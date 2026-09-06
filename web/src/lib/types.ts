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
};

export type SessionState = "idle" | "running" | "stopping" | "exited" | "error";

export type Session = {
  id: string;
  agentId: string;
  agentLabel: string;
  projectId: string;
  projectLabel: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
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
  directories: BrowseDirectory[];
};

export type ServerMessage =
  | { type: "output"; data: string }
  | { type: "state"; session: Session }
  | { type: "error"; message: string }
  | { type: "exit"; exitCode?: number; signal?: number }
  | { type: "pong"; ts: number; nonce?: string };
