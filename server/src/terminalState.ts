import type { Terminal as TerminalType } from "@xterm/headless";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
import headlessPkg from "@xterm/headless";
import serializePkg from "@xterm/addon-serialize";
import type * as pty from "node-pty";
import { AppHttpError } from "./httpErrors.js";

const Terminal = (headlessPkg as unknown as { Terminal: typeof TerminalType }).Terminal || (headlessPkg as unknown as typeof TerminalType);
const SerializeAddon = (serializePkg as unknown as { SerializeAddon: typeof SerializeAddonType }).SerializeAddon || (serializePkg as unknown as typeof SerializeAddonType);

export type SnapshotResult = {
  baseSeq: number;
  cols: number;
  rows: number;
  data: string;
  historyTruncated: boolean;
};

type QueueItem =
  | {
      type: "write";
      data: string;
      bytes: number;
      resolve: (seq: number) => void;
      reject: (err: unknown) => void;
    }
  | {
      type: "resize";
      cols: number;
      rows: number;
      resolve: (seq: number) => void;
      reject: (err: unknown) => void;
    }
  | {
      type: "barrier";
      resolve: (snapshot: SnapshotResult) => void;
      reject: (err: unknown) => void;
    };

const HIGH_WATERMARK_BYTES = 512 * 1024; // 512 KiB
const LOW_WATERMARK_BYTES = 128 * 1024;  // 128 KiB
const MAX_SNAPSHOT_BYTES = 1024 * 1024;  // 1 MiB
export const CHUNK_SIZE_BYTES = 16 * 1024; // 16 KiB

export function chunkUnicodeString(text: string, maxBytes = CHUNK_SIZE_BYTES): string[] {
  if (!text) return [];
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) {
    return [text];
  }

  const chunks: string[] = [];
  let offset = 0;
  while (offset < buf.byteLength) {
    let end = Math.min(offset + maxBytes, buf.byteLength);
    // Adjust end so we do not split UTF-8 multi-byte sequences.
    // In UTF-8, continuation bytes have the form 10xxxxxx (0x80 to 0xBF).
    while (end > offset && end < buf.byteLength && (buf[end] & 0xc0) === 0x80) {
      end--;
    }
    chunks.push(buf.toString("utf8", offset, end));
    offset = end;
  }
  return chunks;
}

export class TerminalState {
  private terminal: TerminalType | undefined;
  private serializer: SerializeAddonType | undefined;
  private seq = 0;
  private cols: number;
  private rows: number;
  private queue: QueueItem[] = [];
  private processing = false;
  private pendingBytes = 0;
  private isPtyPaused = false;
  private ptyProcess: pty.IPty | undefined;
  private finalSnapshot: SnapshotResult | undefined;
  private finalSnapshotPromise: Promise<SnapshotResult> | undefined;
  private disposed = false;

  constructor(cols = 100, rows = 30) {
    this.cols = cols;
    this.rows = rows;
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 1000,
      allowProposedApi: true
    });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
  }

  setPtyProcess(ptyProcess: pty.IPty | undefined): void {
    this.ptyProcess = ptyProcess;
  }

  get currentSeq(): number {
    return this.seq;
  }

  get dimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  enqueueWrite(data: string): Promise<number> {
    if (this.disposed) {
      return Promise.reject(new Error("TerminalState is disposed"));
    }

    const bytes = Buffer.byteLength(data, "utf8");
    this.pendingBytes += bytes;

    if (this.pendingBytes > HIGH_WATERMARK_BYTES && !this.isPtyPaused && this.ptyProcess) {
      try {
        this.ptyProcess.pause();
        this.isPtyPaused = true;
      } catch {}
    }

    return new Promise<number>((resolve, reject) => {
      this.queue.push({
        type: "write",
        data,
        bytes,
        resolve,
        reject
      });
      this.processQueue();
    });
  }

  enqueueResize(cols: number, rows: number): Promise<number> {
    if (this.disposed) {
      return Promise.reject(new Error("TerminalState is disposed"));
    }

    return new Promise<number>((resolve, reject) => {
      this.queue.push({
        type: "resize",
        cols,
        rows,
        resolve,
        reject
      });
      this.processQueue();
    });
  }

  createSnapshotBarrier(): Promise<SnapshotResult> {
    if (this.disposed) {
      if (this.finalSnapshot) return Promise.resolve(this.finalSnapshot);
      return Promise.reject(new Error("TerminalState is disposed"));
    }

    if (this.finalSnapshot) {
      return Promise.resolve(this.finalSnapshot);
    }

    if (this.finalSnapshotPromise) {
      return this.finalSnapshotPromise;
    }

    return new Promise<SnapshotResult>((resolve, reject) => {
      this.queue.push({
        type: "barrier",
        resolve,
        reject
      });
      this.processQueue();
    });
  }

  finalizeOnExit(): Promise<SnapshotResult> {
    if (this.finalSnapshot) {
      return Promise.resolve(this.finalSnapshot);
    }

    if (this.finalSnapshotPromise) {
      return this.finalSnapshotPromise;
    }

    this.finalSnapshotPromise = this.createSnapshotBarrier()
      .then((snapshot) => {
        this.finalSnapshot = snapshot;
        // Free headless terminal memory on exit; retain only the final snapshot
        if (this.terminal) {
          try {
            this.terminal.dispose();
          } catch {}
          this.terminal = undefined;
        }
        if (this.serializer) {
          try {
            this.serializer.dispose();
          } catch {}
          this.serializer = undefined;
        }
        return snapshot;
      })
      .catch((err) => {
        // Clean up even if snapshot generation failed
        if (this.terminal) {
          try {
            this.terminal.dispose();
          } catch {}
          this.terminal = undefined;
        }
        if (this.serializer) {
          try {
            this.serializer.dispose();
          } catch {}
          this.serializer = undefined;
        }
        throw err;
      });

    return this.finalSnapshotPromise;
  }

  private serializeWithLimits(): SnapshotResult {
    if (!this.serializer) {
      if (this.finalSnapshot) return this.finalSnapshot;
      throw new Error("TerminalState has no serializer available");
    }

    const scrollbackLevels = [1000, 500, 100, 0];
    for (const level of scrollbackLevels) {
      const serialized = this.serializer.serialize({
        scrollback: level,
        excludeModes: false,
        excludeAltBuffer: false
      });
      const byteLen = Buffer.byteLength(serialized, "utf8");
      if (byteLen <= MAX_SNAPSHOT_BYTES) {
        return {
          baseSeq: this.seq,
          cols: this.cols,
          rows: this.rows,
          data: serialized,
          historyTruncated: level < 1000
        };
      }
    }

    throw new AppHttpError(500, "terminal_snapshot_too_large", "Terminal snapshot exceeds 1 MiB limit even with 0 scrollback");
  }

  private processQueue(): void {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    const item = this.queue.shift()!;

    if (item.type === "write") {
      if (!this.terminal) {
        this.pendingBytes = Math.max(0, this.pendingBytes - item.bytes);
        item.reject(new Error("Terminal was disposed"));
        this.processing = false;
        this.processQueue();
        return;
      }

      this.terminal.write(item.data, () => {
        this.pendingBytes = Math.max(0, this.pendingBytes - item.bytes);
        if (this.isPtyPaused && this.pendingBytes <= LOW_WATERMARK_BYTES && this.ptyProcess) {
          try {
            this.ptyProcess.resume();
            this.isPtyPaused = false;
          } catch {}
        }

        this.seq++;
        item.resolve(this.seq);
        this.processing = false;
        this.processQueue();
      });
    } else if (item.type === "resize") {
      this.cols = item.cols;
      this.rows = item.rows;
      if (this.terminal) {
        try {
          this.terminal.resize(item.cols, item.rows);
        } catch {}
      }
      this.seq++;
      item.resolve(this.seq);
      this.processing = false;
      this.processQueue();
    } else if (item.type === "barrier") {
      try {
        const snapshot = this.serializeWithLimits();
        item.resolve(snapshot);
      } catch (err) {
        item.reject(err);
      }
      this.processing = false;
      this.processQueue();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.isPtyPaused && this.ptyProcess) {
      try {
        this.ptyProcess.resume();
        this.isPtyPaused = false;
      } catch {}
    }

    if (this.terminal) {
      try {
        this.terminal.dispose();
      } catch {}
      this.terminal = undefined;
    }

    if (this.serializer) {
      try {
        this.serializer.dispose();
      } catch {}
      this.serializer = undefined;
    }

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.reject(new Error("TerminalState disposed"));
    }
  }
}
