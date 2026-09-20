import type { Session, SessionState } from "../../lib/types";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "syncing"
  | "connected"
  | "disconnected"
  | "missing";

export type ConnectionControl = "none" | "controller" | "viewer";

export type ConnectionState = {
  sessionId?: string;
  status: ConnectionStatus;
  control: ConnectionControl;
};

export type CapacityState = {
  active: number;
  reserved: number;
  max: number;
};

export type AttentionEvent = {
  eventId: string;
  sessionId: string;
  createdAt: string;
};

export type PendingOperation = {
  id: string;
  type: "create" | "kill" | "restart";
  sessionId?: string;
};

export type SessionsState = {
  sessionsById: Record<string, Session>;
  sessionOrder: string[];
  serverEpoch?: string;
  registryRevision: number;
  activeSessionId?: string;
  capacity: CapacityState;
  connection: ConnectionState;
  draftsBySessionId: Record<string, string>;
  pendingOperation?: PendingOperation;
  attentionBySessionId: Record<string, AttentionEvent>;
  seenAttentionBySessionId: Record<string, string>;
};

export type SessionsAction =
  | {
      type: "LOAD_SESSIONS";
      payload: {
        sessions: Session[];
        serverEpoch: string;
        registryRevision: number;
        capacity?: CapacityState;
      };
    }
  | {
      type: "UPSERT_SESSIONS";
      payload: {
        sessions: Session[];
        serverEpoch?: string;
        registryRevision?: number;
        capacity?: CapacityState;
      };
    }
  | {
      type: "UPSERT_SESSION";
      payload: {
        session: Session;
        serverEpoch?: string;
        registryRevision?: number;
        capacity?: CapacityState;
      };
    }
  | {
      type: "REMOVE_SESSION";
      payload: {
        sessionId: string;
        registryRevision?: number;
      };
    }
  | {
      type: "SET_ACTIVE_SESSION";
      payload: {
        sessionId?: string;
      };
    }
  | {
      type: "SET_CONNECTION";
      payload: Partial<ConnectionState>;
    }
  | {
      type: "SET_DRAFT";
      payload: {
        sessionId: string;
        draft: string;
      };
    }
  | {
      type: "SET_PENDING_OPERATION";
      payload?: PendingOperation;
    }
  | {
      type: "ADD_ATTENTION";
      payload: AttentionEvent;
    }
  | {
      type: "REMOVE_ATTENTION";
      payload: {
        sessionId: string;
        eventId?: string;
      };
    };
