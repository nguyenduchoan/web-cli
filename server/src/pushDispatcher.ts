import crypto from "node:crypto";
import type { AttentionEvent } from "./attention.js";
import { AppHttpError } from "./httpErrors.js";
import type { PushStore, DeviceRecord } from "./pushStore.js";
import type { SessionManager } from "./sessionManager.js";

export type PushMessage = {
  token: string;
  data: Record<string, string>;
  webpush?: {
    headers?: Record<string, string>;
  };
};

export interface PushSender {
  send(message: PushMessage): Promise<string>;
}

export type DispatcherCounters = {
  accepted: number;
  sent: number;
  failed: number;
  dropped: number;
  slow: number;
  queueDepth: number;
  inFlight: number;
};

type DispatchJob = {
  id: string;
  eventId: string;
  type: "attention" | "test";
  sessionId: string;
  createdAt: string;
  createdAtMs: number;
  expiresAtMs: number;
  device: {
    deviceId: string;
    fid: string;
    registrationVersion: string;
  };
};

const MAX_QUEUE_DEPTH = 128;
const MAX_CONCURRENCY = 2;
const JOB_TTL_MS = 300_000; // 300 seconds
const TEST_PUSH_COOLDOWN_MS = 30_000; // 30 seconds per device

export class PushDispatcher {
  private readonly store: PushStore;
  private readonly sender: PushSender;
  private readonly sessions?: SessionManager;
  private queue: DispatchJob[] = [];
  private inFlight = 0;
  private closing = false;

  private acceptedCount = 0;
  private sentCount = 0;
  private failedCount = 0;
  private droppedCount = 0;
  private slowCount = 0;

  private testPushLastSent = new Map<string, number>();

  constructor(options: {
    store: PushStore;
    sender: PushSender;
    sessions?: SessionManager;
  }) {
    this.store = options.store;
    this.sender = options.sender;
    this.sessions = options.sessions;
  }

  getCounters(): DispatcherCounters {
    return {
      accepted: this.acceptedCount,
      sent: this.sentCount,
      failed: this.failedCount,
      dropped: this.droppedCount,
      slow: this.slowCount,
      queueDepth: this.queue.length,
      inFlight: this.inFlight
    };
  }

  dispatchAttention(event: AttentionEvent): void {
    if (this.closing) return;

    const devices = this.store.getValidDevices();
    if (devices.length === 0) return;

    const now = Date.now();
    for (const device of devices) {
      if (this.queue.length >= MAX_QUEUE_DEPTH) {
        this.droppedCount++;
        continue;
      }

      this.acceptedCount++;
      this.queue.push({
        id: crypto.randomUUID(),
        eventId: event.eventId,
        type: "attention",
        sessionId: event.sessionId,
        createdAt: event.createdAt,
        createdAtMs: now,
        expiresAtMs: now + JOB_TTL_MS,
        device: {
          deviceId: device.deviceId,
          fid: device.fid,
          registrationVersion: device.registrationVersion
        }
      });
    }

    this.processQueue();
  }

  async dispatchTest(deviceId: string, authScope: string): Promise<{ queued: true; eventId: string }> {
    if (this.closing) {
      throw new AppHttpError(503, "server_shutting_down", "Server is shutting down");
    }

    const device = this.store.getDevice(deviceId);
    if (!device) {
      throw new AppHttpError(404, "device_not_found", "Device is not registered");
    }

    if (device.webAuthScope !== authScope) {
      throw new AppHttpError(404, "device_not_found", "Device does not belong to current auth scope");
    }

    const now = Date.now();
    const lastSent = this.testPushLastSent.get(deviceId) ?? 0;
    if (now - lastSent < TEST_PUSH_COOLDOWN_MS) {
      throw new AppHttpError(429, "rate_limited", "Test notification rate limit: 1 per 30 seconds per device");
    }
    this.testPushLastSent.set(deviceId, now);

    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      this.droppedCount++;
      throw new AppHttpError(429, "queue_full", "Notification dispatch queue is full");
    }

    const eventId = crypto.randomUUID();
    const createdAt = new Date(now).toISOString();

    this.acceptedCount++;
    this.queue.push({
      id: crypto.randomUUID(),
      eventId,
      type: "test",
      sessionId: "",
      createdAt,
      createdAtMs: now,
      expiresAtMs: now + JOB_TTL_MS,
      device: {
        deviceId: device.deviceId,
        fid: device.fid,
        registrationVersion: device.registrationVersion
      }
    });

    this.processQueue();
    return { queued: true, eventId };
  }

  private processQueue(): void {
    if (this.closing) return;

    while (this.inFlight < MAX_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      const now = Date.now();

      // 1. Check TTL
      if (now > job.expiresAtMs) {
        this.droppedCount++;
        continue;
      }

      // 2. If attention, check if session is still running and event is still valid
      if (job.type === "attention" && this.sessions) {
        const session = this.sessions.getSession(job.sessionId);
        if (!session || session.state !== "running") {
          this.droppedCount++;
          continue;
        }
        if (session.attention && session.attention.eventId !== job.eventId) {
          // Superseded by newer attention event
          this.droppedCount++;
          continue;
        }
      }

      // 3. Check device tuple in store
      const currentDevice = this.store.getDevice(job.device.deviceId);
      if (
        !currentDevice ||
        currentDevice.fid !== job.device.fid ||
        currentDevice.registrationVersion !== job.device.registrationVersion
      ) {
        // Device was rotated, deleted or revoked
        this.droppedCount++;
        continue;
      }

      // 4. Send
      this.inFlight++;
      this.executeJob(job).finally(() => {
        this.inFlight--;
        this.processQueue();
      });
    }
  }

  private async executeJob(job: DispatchJob): Promise<void> {
    const remainingSeconds = Math.max(1, Math.floor((job.expiresAtMs - Date.now()) / 1000));

    const message: PushMessage = {
      token: job.device.fid,
      data: {
        type: job.type,
        eventId: job.eventId,
        sessionId: job.sessionId,
        createdAt: job.createdAt
      },
      webpush: {
        headers: {
          Urgency: "high",
          TTL: String(remainingSeconds)
        }
      }
    };

    let watchdogTimer: NodeJS.Timeout | undefined;
    let slowLogged = false;

    watchdogTimer = setTimeout(() => {
      this.slowCount++;
      slowLogged = true;
    }, 30_000);

    try {
      await this.sender.send(message);
      this.sentCount++;
    } catch (err) {
      this.failedCount++;
      const errMsg = String(err);
      if (
        errMsg.includes("registration-token-not-registered") ||
        errMsg.includes("invalid-registration-token") ||
        errMsg.includes("messaging/invalid-argument")
      ) {
        // Stale or invalid token: verify tuple still matches before removing
        const current = this.store.getDevice(job.device.deviceId);
        if (
          current &&
          current.fid === job.device.fid &&
          current.registrationVersion === job.device.registrationVersion
        ) {
          await this.store.deleteDevice(job.device.deviceId).catch(() => {});
        }
      }
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
    }
  }

  async shutdown(timeoutMs: number = 2000): Promise<void> {
    this.closing = true;
    this.droppedCount += this.queue.length;
    this.queue = [];

    const start = Date.now();
    while (this.inFlight > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
