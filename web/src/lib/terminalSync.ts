export type TerminalSyncOptions = {
  sessionId: string;
  generation: number;
  writeTerminal: (data: string) => Promise<void>;
  resetTerminal: () => void;
  resizeTerminal: (cols: number, rows: number) => void;
  onSyncComplete: (role: "controller" | "viewer") => void;
  onMismatchOrGap: (reason: string) => void;
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
  private writeTerminal: (data: string) => Promise<void>;
  private resetTerminal: () => void;
  private resizeTerminal: (cols: number, rows: number) => void;
  private onSyncComplete: (role: "controller" | "viewer") => void;
  private onMismatchOrGap: (reason: string) => void;

  public syncId = "";
  public expectedChunkIndex = 0;
  public expectedSeq = 0;
  public syncComplete = false;
  public isSyncing = false;
  public role: "controller" | "viewer" = "viewer";
  public lastGrid: { cols: number; rows: number } = { cols: 80, rows: 24 };

  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: TerminalSyncOptions) {
    this.sessionId = options.sessionId;
    this.generation = options.generation;
    this.writeTerminal = options.writeTerminal;
    this.resetTerminal = options.resetTerminal;
    this.resizeTerminal = options.resizeTerminal;
    this.onSyncComplete = options.onSyncComplete;
    this.onMismatchOrGap = options.onMismatchOrGap;
  }

  public handleSyncStart(msg: SyncStartMessage): void {
    this.syncId = msg.syncId;
    this.expectedChunkIndex = 0;
    this.syncComplete = false;
    this.isSyncing = true;
    this.role = msg.control;
    this.expectedSeq = msg.baseSeq + 1;
    this.writeChain = Promise.resolve();

    this.resetTerminal();
    // Grid must be set to server snapshot geometry for BOTH controller and viewer
    this.lastGrid = { cols: msg.cols, rows: msg.rows };
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

    this.writeChain = this.writeChain.then(async () => {
      if (
        this.generation !== currentGen ||
        this.sessionId !== currentSession ||
        this.syncId !== currentSyncId
      ) {
        return;
      }
      await this.writeTerminal(msg.data);
    });

    return true;
  }

  public async handleSyncEnd(msg: SyncEndMessage): Promise<boolean> {
    if (msg.syncId !== this.syncId) return false;

    if (msg.chunkCount !== this.expectedChunkIndex) {
      this.onMismatchOrGap(
        `snapshot_chunk_count_mismatch: expected ${this.expectedChunkIndex} got ${msg.chunkCount}`
      );
      return false;
    }

    const currentGen = this.generation;
    const currentSession = this.sessionId;
    const currentSyncId = this.syncId;
    const targetBaseSeq = msg.baseSeq;

    await this.writeChain;

    if (
      this.generation !== currentGen ||
      this.sessionId !== currentSession ||
      this.syncId !== currentSyncId
    ) {
      return false;
    }

    this.expectedSeq = targetBaseSeq + 1;
    this.syncComplete = true;
    this.isSyncing = false;
    this.onSyncComplete(this.role);
    return true;
  }

  public handleOutput(msg: OutputMessage): boolean {
    if (!this.syncComplete) return false;

    if (msg.seq < this.expectedSeq) {
      // Duplicate, ignore
      return true;
    }

    if (msg.seq !== this.expectedSeq) {
      this.onMismatchOrGap(`output_seq_gap: expected ${this.expectedSeq} got ${msg.seq}`);
      return false;
    }

    this.expectedSeq += 1;
    const currentGen = this.generation;
    const currentSession = this.sessionId;
    const currentSyncId = this.syncId;

    this.writeChain = this.writeChain.then(async () => {
      if (
        this.generation !== currentGen ||
        this.sessionId !== currentSession ||
        this.syncId !== currentSyncId
      ) {
        return;
      }
      await this.writeTerminal(msg.data);
    });

    return true;
  }

  public handleTerminalResize(msg: ResizeMessage): boolean {
    if (!this.syncComplete) return false;

    if (msg.seq < this.expectedSeq) {
      return true;
    }

    if (msg.seq !== this.expectedSeq) {
      this.onMismatchOrGap(`resize_seq_gap: expected ${this.expectedSeq} got ${msg.seq}`);
      return false;
    }

    this.expectedSeq += 1;
    if (this.role === "viewer") {
      this.lastGrid = { cols: msg.cols, rows: msg.rows };
      this.resizeTerminal(msg.cols, msg.rows);
    }

    return true;
  }

  public invalidate(): void {
    this.generation = -1;
    this.syncId = "";
    this.syncComplete = false;
    this.isSyncing = false;
  }
}
