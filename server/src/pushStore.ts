import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppHttpError } from "./httpErrors.js";

export type DeviceRecord = {
  deviceId: string;
  fid: string;
  webAuthScope: string;
  hubAuthScope?: string;
  registrationVersion: string;
  expiresAt: string;
  updatedAt: string;
};

export type PushStoreData = {
  version: 1;
  projectId: string;
  devices: DeviceRecord[];
};

const MAX_DEVICES = 16;
const MAX_FILE_BYTES = 64 * 1024;
const TTL_DAYS = 30;

export function validateFid(fid: string): boolean {
  // Validate FID is 22 characters base64url, first character in [c, d, e, f]
  if (typeof fid !== "string" || fid.length !== 22) return false;
  const first = fid[0].toLowerCase();
  if (first !== "c" && first !== "d" && first !== "e" && first !== "f") return false;
  return /^[a-zA-Z0-9_-]{22}$/.test(fid);
}

export function validateUuid(id: string): boolean {
  if (typeof id !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export class PushStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly projectId: string;
  private writeLock: Promise<void> = Promise.resolve();
  private cache: PushStoreData;

  constructor(dataDir: string, projectId: string) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "devices.json");
    this.projectId = projectId;

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    }

    this.cache = this.loadFromFile();
  }

  private loadFromFile(): PushStoreData {
    if (!fs.existsSync(this.filePath)) {
      return {
        version: 1,
        projectId: this.projectId,
        devices: []
      };
    }

    try {
      const content = fs.readFileSync(this.filePath, "utf8");
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
        throw new Error("Push store file exceeds maximum allowed size (64 KiB)");
      }

      const parsed = JSON.parse(content) as PushStoreData;
      if (parsed.version !== 1) {
        throw new Error(`Unsupported push store version: ${String(parsed.version)}`);
      }
      if (parsed.projectId !== this.projectId) {
        throw new Error(
          `Push store project mismatch: file has ${parsed.projectId}, expected ${this.projectId}`
        );
      }
      if (!Array.isArray(parsed.devices)) {
        throw new Error("Corrupted push store: devices is not an array");
      }

      return parsed;
    } catch (err) {
      throw new Error(`Failed to load push store from ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async persist(): Promise<void> {
    const serialized = JSON.stringify(this.cache, null, 2);
    const byteLen = Buffer.byteLength(serialized, "utf8");
    if (byteLen > MAX_FILE_BYTES) {
      throw new AppHttpError(500, "push_store_overflow", "Push store file exceeds 64 KiB");
    }

    // Queue atomic write
    this.writeLock = this.writeLock.then(async () => {
      const tempPath = path.join(
        this.dataDir,
        `devices.json.tmp.${process.pid}.${crypto.randomUUID()}`
      );
      try {
        fs.writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tempPath, this.filePath);
      } catch (err) {
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {}
        throw new AppHttpError(503, "push_store_error", "Failed to persist push store");
      }
    });

    await this.writeLock;
  }

  private pruneExpired(now: number = Date.now()): boolean {
    const initialLen = this.cache.devices.length;
    this.cache.devices = this.cache.devices.filter((dev) => {
      const expiresAtMs = new Date(dev.expiresAt).getTime();
      return expiresAtMs > now;
    });
    return this.cache.devices.length !== initialLen;
  }

  async upsertDevice(input: {
    deviceId: string;
    fid: string;
    webAuthScope: string;
    hubAuthScope?: string;
  }): Promise<{ ok: true; expiresAt: string }> {
    if (!validateUuid(input.deviceId)) {
      throw new AppHttpError(400, "invalid_device_id", "deviceId must be a valid UUID");
    }
    if (!validateFid(input.fid)) {
      throw new AppHttpError(400, "invalid_fid", "fid must be a valid 22-character base64url string starting with c, d, e, or f");
    }

    const now = Date.now();
    this.pruneExpired(now);

    const expiresAt = new Date(now + TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const registrationVersion = crypto.randomUUID();

    // 1. Remove any other device that has the same FID (avoid duplicate push)
    this.cache.devices = this.cache.devices.filter(
      (dev) => dev.deviceId === input.deviceId || dev.fid !== input.fid
    );

    // 2. Check capacity
    const existingIndex = this.cache.devices.findIndex((dev) => dev.deviceId === input.deviceId);
    if (existingIndex === -1 && this.cache.devices.length >= MAX_DEVICES) {
      throw new AppHttpError(429, "device_limit_reached", "Maximum 16 push devices registered");
    }

    const record: DeviceRecord = {
      deviceId: input.deviceId,
      fid: input.fid,
      webAuthScope: input.webAuthScope,
      hubAuthScope: input.hubAuthScope,
      registrationVersion,
      expiresAt,
      updatedAt: new Date(now).toISOString()
    };

    if (existingIndex >= 0) {
      this.cache.devices[existingIndex] = record;
    } else {
      this.cache.devices.push(record);
    }

    await this.persist();
    return { ok: true, expiresAt };
  }

  async deleteDevice(deviceId: string, authScope?: string): Promise<{ ok: true }> {
    if (!validateUuid(deviceId)) {
      throw new AppHttpError(400, "invalid_device_id", "deviceId must be a valid UUID");
    }

    const initialLen = this.cache.devices.length;
    this.cache.devices = this.cache.devices.filter((dev) => {
      if (dev.deviceId !== deviceId) return true;
      if (authScope && dev.webAuthScope !== authScope) {
        return true; // KEEP mismatched device
      }
      return false; // delete matching device
    });

    if (this.cache.devices.length !== initialLen) {
      await this.persist();
    }

    return { ok: true };
  }

  getDevice(deviceId: string): DeviceRecord | undefined {
    this.pruneExpired();
    return this.cache.devices.find((dev) => dev.deviceId === deviceId);
  }

  getValidDevices(): DeviceRecord[] {
    this.pruneExpired();
    return [...this.cache.devices];
  }

  async revokeWebScope(webAuthScope: string): Promise<number> {
    const initialLen = this.cache.devices.length;
    this.cache.devices = this.cache.devices.filter((dev) => dev.webAuthScope !== webAuthScope);
    const removed = initialLen - this.cache.devices.length;
    if (removed > 0) {
      await this.persist();
    }
    return removed;
  }

  async revokeHubScope(hubAuthScope: string): Promise<number> {
    const initialLen = this.cache.devices.length;
    this.cache.devices = this.cache.devices.filter((dev) => dev.hubAuthScope !== hubAuthScope);
    const removed = initialLen - this.cache.devices.length;
    if (removed > 0) {
      await this.persist();
    }
    return removed;
  }

  async revokeAll(): Promise<number> {
    const count = this.cache.devices.length;
    this.cache.devices = [];
    if (count > 0) {
      await this.persist();
    }
    return count;
  }
}
