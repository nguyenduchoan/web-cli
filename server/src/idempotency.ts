import crypto from "node:crypto";
import {
  AppHttpError,
  IdempotencyCapacityError,
  IdempotencyConflictError
} from "./httpErrors.js";

export type IdempotencyResult<T = unknown> = {
  statusCode: number;
  body: T;
};

export type IdempotencyEntry<T = unknown> = {
  key: string;
  fingerprint: string;
  createdAt: number;
  completedAt?: number;
  expiresAt?: number;
  pendingPromise?: Promise<IdempotencyResult<T>>;
  result?: IdempotencyResult<T>;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize(obj[key]);
  }
  return result;
}

export function canonicalFingerprint(payload: unknown): string {
  const normalized = canonicalize(payload ?? {});
  const json = JSON.stringify(normalized);
  return crypto.createHash("sha256").update(json).digest("hex");
}

export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

export class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();

  constructor(
    private readonly maxEntries = 1000,
    private readonly ttlMs = 5 * 60 * 1000 // 5 minutes
  ) {}

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  evictExpired(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  async execute<T>(
    method: string,
    canonicalRoute: string,
    rawKey: string | undefined | null,
    payload: unknown,
    action: () => Promise<IdempotencyResult<T>>
  ): Promise<IdempotencyResult<T>> {
    if (!rawKey) {
      // Legacy or no key: execute directly without idempotency
      return action();
    }

    const trimmedKey = rawKey.trim();
    if (!isValidUuid(trimmedKey)) {
      throw new AppHttpError(400, "validation_error", "Idempotency-Key must be a valid UUID");
    }

    const namespaceKey = `${method.toUpperCase()} ${canonicalRoute}:${trimmedKey.toLowerCase()}`;
    const fingerprint = canonicalFingerprint(payload);
    const now = Date.now();

    const existing = this.entries.get(namespaceKey);
    if (existing) {
      // Check expiration
      if (existing.expiresAt && existing.expiresAt <= now) {
        this.entries.delete(namespaceKey);
      } else {
        // Must match fingerprint
        if (existing.fingerprint !== fingerprint) {
          throw new IdempotencyConflictError("Idempotency key reused with different request payload");
        }

        if (existing.pendingPromise) {
          return existing.pendingPromise as Promise<IdempotencyResult<T>>;
        }

        if (existing.result) {
          return existing.result as IdempotencyResult<T>;
        }
      }
    }

    // Evict expired completed entries
    this.evictExpired(now);

    if (this.entries.size >= this.maxEntries) {
      throw new IdempotencyCapacityError();
    }

    let resolvePending!: (res: IdempotencyResult<T>) => void;
    let rejectPending!: (err: unknown) => void;
    const pendingPromise = new Promise<IdempotencyResult<T>>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });

    const entry: IdempotencyEntry<T> = {
      key: namespaceKey,
      fingerprint,
      createdAt: now,
      pendingPromise
    };

    this.entries.set(namespaceKey, entry as IdempotencyEntry);

    try {
      const result = await action();
      // Rule 4: Cache 5 min from completion, including success and business error.
      // Do NOT cache 401 / 403 / schema (400 validation_error) errors.
      const isCacheable =
        result.statusCode !== 401 &&
        result.statusCode !== 403 &&
        !(result.statusCode === 400 && typeof result.body === "object" && result.body !== null && (result.body as Record<string, unknown>).error === "validation_error");

      if (isCacheable) {
        const completed = Date.now();
        entry.result = result;
        entry.completedAt = completed;
        entry.expiresAt = completed + this.ttlMs;
        delete entry.pendingPromise;
      } else {
        this.entries.delete(namespaceKey);
      }

      resolvePending(result);
      return result;
    } catch (error) {
      this.entries.delete(namespaceKey);
      rejectPending(error);
      throw error;
    }
  }
}
