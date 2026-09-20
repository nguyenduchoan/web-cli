export type AgentConfig = {
  id: string;
  label: string;
  quickActions: {
    yesAll: string;
    skip: string;
    editFirst: string;
  };
};

export type ProjectConfig = {
  id: string;
  label: string;
  workingDirectoryId?: string;
};

export type SessionState = "idle" | "running" | "stopping" | "exited" | "error";

export type SessionExitReason =
  | "natural"
  | "user_kill"
  | "restart"
  | "idle_timeout"
  | "server_shutdown"
  | "spawn_error";

export type Session = {
  id: string;
  name?: string;
  agentId: string;
  agentLabel: string;
  projectId: string;
  projectLabel: string;
  rootProjectLabel: string;
  subpath?: string;
  workingDirectoryId: string;
  workingDirectoryLabel: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  revision: number;
  outputLastSeq: number;
  replacedFromSessionId?: string;
  replacementSessionId?: string;
  stopTimedOut?: boolean;
  attention?: { eventId: string; createdAt: string };
  exitReason?: SessionExitReason;
  exitCode?: number;
  signal?: number;
  error?: string;
};

export type BrowseDirectory = {
  name: string;
  subpath: string;
};

export type BrowseResult = {
  projectId: string;
  rootLabel: string;
  currentSubpath: string;
  canonicalSubpath?: string;
  workingDirectoryId?: string;
  directories: BrowseDirectory[];
};

export type ServerMessage =
  | { type: "output"; data: string }
  | { type: "state"; session: Session }
  | { type: "error"; message: string }
  | { type: "exit"; exitCode?: number; signal?: number }
  | { type: "pong"; ts: number; nonce?: string };

export type ServerMessageV2 =
  | {
      type: "sync_start";
      sessionId: string;
      serverEpoch: string;
      syncId: string;
      session: Session;
      baseSeq: number;
      cols: number;
      rows: number;
      control: "controller" | "viewer";
      historyTruncated: boolean;
    }
  | {
      type: "snapshot_chunk";
      sessionId: string;
      serverEpoch: string;
      syncId: string;
      index: number;
      data: string;
    }
  | {
      type: "sync_end";
      sessionId: string;
      serverEpoch: string;
      syncId: string;
      baseSeq: number;
      chunkCount: number;
    }
  | {
      type: "output";
      sessionId: string;
      serverEpoch: string;
      seq: number;
      data: string;
    }
  | {
      type: "terminal_resize";
      sessionId: string;
      serverEpoch: string;
      seq: number;
      cols: number;
      rows: number;
    }
  | {
      type: "control";
      sessionId: string;
      serverEpoch: string;
      role: "controller" | "viewer";
    }
  | {
      type: "state";
      sessionId: string;
      serverEpoch: string;
      registryRevision: number;
      session: Session;
    }
  | {
      type: "exit";
      sessionId: string;
      serverEpoch: string;
      registryRevision: number;
      session?: Session;
      exitCode?: number;
      signal?: number;
    }
  | {
      type: "removed";
      sessionId: string;
      serverEpoch: string;
      registryRevision: number;
    }
  | {
      type: "attention";
      sessionId: string;
      serverEpoch: string;
      eventId: string;
      createdAt: string;
    }
  | {
      type: "error";
      sessionId?: string;
      serverEpoch?: string;
      code?: string;
      message: string;
    }
  | { type: "pong"; ts: number; nonce?: string };
