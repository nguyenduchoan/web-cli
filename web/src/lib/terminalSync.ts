import { XtermOperationQueue } from "./xtermOperationQueue.js";

export const DEFAULT_MAX_LIVE_BACKLOG_BYTES = 1_000_000;

export type TerminalSyncOptions = {
  sessionId: string;
  generation: number;
  queue?: XtermOperationQueue;
  writeTerminal: (data: string) => Promise<void>;
  resetTerminal: () => void;
  resizeTerminal: (cols: number, rows: number) => void;
  onSyncComplete: (role: "controller" | "viewer") => void;
  onMismatchOrGap: (reason: string) => void;
  maxLiveBacklogBytes?: number;
};

export type SyncStartMessage = {
  syncId: string;
  baseSeq: number;
  cols: number;
  rows: number;
  control: "controller" | "viewer";
};

export type SnapshotChunkMessage = {
  syncId: string;
  index: number;
  data: string;
};

export type SyncEndMessage = {
  syncId: string;
  baseSeq: number;
  chunkCount: number;
};

export type OutputMessage = {
  seq: number;
  data: string;
};

export type ResizeMessage = {
  seq: number;
  cols: number;
  rows: number;
};

export class TerminalSyncController {
  public sessionId: string;
  public generation: number;
  public queue: XtermOperationQueue;
  public readonly maxLiveBacklogBytes: number;

  private writeTerminal: (data: string) => Promise<void>;
  private resetTerminal: () => void;
  private resizeTerminal: (cols: number, rows: number) => void;
  private onSyncComplete: (role: "controller" | "viewer") => void;
  private onMismatchOrGap: (reason: string) => void;

  public syncId = "";
  public baseSeq = 0;
  public expectedChunkIndex = 0;
  public expectedSeq = 0;
  public syncEndReceived = false;
  public syncComplete = false;
  public isSyncing = false;
  public liveBacklogBytes = 0;
  public role: "controller" | "viewer" = "viewer";
  public lastGrid: { cols: number; rows: number } = { cols: 80, rows: 24 };

  constructor(options: TerminalSyncOptions) {
    this.sessionId = options.sessionId;
    this.generation = options.generation;
    this.queue = options.queue ?? new XtermOperationQueue(options.generation);
    this.maxLiveBacklogBytes = options.maxLiveBacklogBytes ?? DEFAULT_MAX_LIVE_BACKLOG_BYTES;
    this.writeTerminal = options.writeTerminal;
    this.resetTerminal = options.resetTerminal;
    this.resizeTerminal = options.resizeTerminal;
    this.onSyncComplete = options.onSyncComplete;
    this.onMismatchOrGap = options.onMismatchOrGap;
  }

  private isInvalid(gen: number, session: string, syncId?: string): boolean {
    if (this.generation !== gen || this.sessionId !== session) return true;
    if (syncId !== undefined && this.syncId !== syncId) return true;
    return false;
  }

  public handleSyncStart(msg: SyncStartMessage): void {
    this.syncId = msg.syncId;
    this.baseSeq = msg.baseSeq;
    this.expectedChunkIndex = 0;
    this.syncEndReceived = false;
    this.syncComplete = false;
    this.isSyncing = true;
    this.role = msg.control;
    this.expectedSeq = msg.baseSeq + 1;
    this.liveBacklogBytes = 0;

    this.lastGrid = { cols: msg.cols, rows: msg.rows };
    this.resetTerminal();
    this.resizeTerminal(msg.cols, msg.rows);
  }

  public handleSnapshotChunk(msg: SnapshotChunkMessage): boolean {
    if (msg.syncId !== this.syncId) return false;

    if (msg.index !== this.expectedChunkIndex) {
      this.onMismatchOrGap(`snapshot_chunk_index_mismatch: expected ${this.expectedChunkIndex} got ${msg.index}`);
      return false;
    }

    this.expectedChunkIndex += 1;
    const currentGen = this.generation;
    const currentSession = this.sessionId;
    const currentSyncId = this.syncId;

    void this.queue.enqueue(currentGen, async () => {
      if (this.isInvalid(currentGen, currentSession, currentSyncId)) {
        return;
      }
      await this.writeTerminal(msg.data);
    });

    return true;
  }

  public handleSyncEnd(msg: SyncEndMessage): Promise<boolean> {
    if (msg.syncId !== this.syncId) return Promise.resolve(false);

    if (msg.chunkCount !== this.expectedChunkIndex) {
      this.onMismatchOrGap(
        `snapshot_chunk_count_mismatch: expected ${this.expectedChunkIndex} got ${msg.chunkCount}`
      );
      return Promise.resolve(false);
    }

    if (msg.baseSeq !== this.baseSeq) {
      this.onMismatchOrGap(
        `snapshot_base_seq_mismatch: expected ${this.baseSeq} got ${msg.baseSeq}`
      );
      return Promise.resolve(false);
    }

    this.syncEndReceived = true;
    const currentGen = this.generation;
    const currentSession = this.sessionId;
    const currentSyncId = this.syncId;

    return this.queue.enqueue(currentGen, async () => {
      if (this.isInvalid(currentGen, currentSession, currentSyncId)) {
        return;
      }
      this.syncComplete = true;
      this.isSyncing = false;
      this.liveBacklogBytes = 0;
      this.onSyncComplete(this.role);
    });
  }

  public handleOutput(msg: OutputMessage): boolean {
    if (!this.syncEndReceived) {
      this.onMismatchOrGap("output_before_sync_end");
      return false;
    }

    if (msg.seq < this.expectedSeq) {
      // Duplicate, ignore
      return true;
    }

    if (msg.seq !== this.expectedSeq) {
      this.onMismatchOrGap(`output_seq_gap: expected ${this.expectedSeq} got ${msg.seq}`);
      return false;
    }

    this.expectedSeq += 1;

    if (!this.syncComplete) {
      const bytes = new TextEncoder().encode(msg.data).length;
      this.liveBacklogBytes += bytes;
      if (this.liveBacklogBytes > this.maxLiveBacklogBytes) {
        this.invalidate();
        this.onMismatchOrGap(`live_backlog_overflow: exceeded ${this.maxLiveBacklogBytes} bytes`);
        return false;
      }
    }

    const currentGen = this.generation;
    const currentSession = this.sessionId;
    const currentSyncId = this.syncId;

    void this.queue.enqueue(currentGen, async () => {
      if (this.isInvalid(currentGen, currentSession, currentSyncId)) {
        return;
      }
      await this.writeTerminal(msg.data);
    });

    return true;
  }

  public handleTerminalResize(msg: ResizeMessage): boolean {
    if (!this.syncEndReceived) {
      this.onMismatchOrGap("resize_before_sync_end");
      return false;
    }

    if (msg.seq < this.expectedSeq) {
      return true;
    }

    if (msg.seq !== this.expectedSeq) {
      this.onMismatchOrGap(`resize_seq_gap: expected ${this.expectedSeq} got ${msg.seq}`);
      return false;
    }

    this.expectedSeq += 1;

    if (!this.syncComplete) {
      this.liveBacklogBytes += 64;
      if (this.liveBacklogBytes > this.maxLiveBacklogBytes) {
        this.invalidate();
        this.onMismatchOrGap(`live_backlog_overflow: exceeded ${this.maxLiveBacklogBytes} bytes`);
        return false;
      }
    }

    const currentGen = this.generation;
    const currentSession = this.sessionId;
    const currentSyncId = this.syncId;
    const isViewer = this.role === "viewer";

    void this.queue.enqueue(currentGen, async () => {
      if (this.isInvalid(currentGen, currentSession, currentSyncId)) {
        return;
      }
      if (isViewer) {
        this.lastGrid = { cols: msg.cols, rows: msg.rows };
        this.resizeTerminal(msg.cols, msg.rows);
      }
    });

    return true;
  }

  public invalidate(): void {
    this.generation = -1;
    this.syncId = "";
    this.syncEndReceived = false;
    this.syncComplete = false;
    this.isSyncing = false;
    this.liveBacklogBytes = 0;
  }
}
