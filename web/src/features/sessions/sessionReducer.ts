import type { Session } from "../../lib/types";
import type {
  SessionsAction,
  SessionsState
} from "./sessionTypes";

export const initialSessionsState: SessionsState = {
  sessionsById: {},
  sessionOrder: [],
  registryRevision: 0,
  capacity: { active: 0, reserved: 0, max: 3 },
  connection: { status: "idle", control: "none" },
  draftsBySessionId: {},
  attentionBySessionId: {},
  seenAttentionBySessionId: {}
};

export function computeSessionOrder(sessionsById: Record<string, Session>): string[] {
  const list = Object.values(sessionsById);

  const getGroupWeight = (state: Session["state"]): number => {
    if (state === "running" || state === "idle") return 1;
    if (state === "stopping") return 2;
    return 3;
  };

  return list
    .sort((a, b) => {
      const gwA = getGroupWeight(a.state);
      const gwB = getGroupWeight(b.state);
      if (gwA !== gwB) return gwA - gwB;

      const dirA = a.workingDirectoryId || "";
      const dirB = b.workingDirectoryId || "";
      const dirCompare = dirA.localeCompare(dirB);
      if (dirCompare !== 0) return dirCompare;

      const dateCompare = a.createdAt.localeCompare(b.createdAt);
      if (dateCompare !== 0) return dateCompare;

      return a.id.localeCompare(b.id);
    })
    .map((s) => s.id);
}

export function sessionsReducer(state: SessionsState, action: SessionsAction): SessionsState {
  switch (action.type) {
    case "LOAD_SESSIONS": {
      const { sessions, serverEpoch, registryRevision, capacity } = action.payload;

      // Stale snapshot check
      if (
        state.serverEpoch &&
        state.serverEpoch === serverEpoch &&
        registryRevision < state.registryRevision
      ) {
        return state;
      }

      // If epoch changed, server restarted: purge old state
      const isNewEpoch = Boolean(state.serverEpoch && state.serverEpoch !== serverEpoch);
      const nextSessionsById: Record<string, Session> = {};

      for (const s of sessions) {
        const existing = state.sessionsById[s.id];
        if (!isNewEpoch && existing && existing.revision > s.revision) {
          nextSessionsById[s.id] = existing;
        } else {
          nextSessionsById[s.id] = s;
        }
      }

      const nextOrder = computeSessionOrder(nextSessionsById);
      const nextActiveId = isNewEpoch ? undefined : state.activeSessionId;
      const isMissingActive = Boolean(nextActiveId && !nextSessionsById[nextActiveId]);

      return {
        ...state,
        sessionsById: nextSessionsById,
        sessionOrder: nextOrder,
        serverEpoch,
        registryRevision,
        capacity: capacity ?? state.capacity,
        activeSessionId: isMissingActive ? undefined : nextActiveId,
        connection: isMissingActive
          ? { sessionId: nextActiveId, status: "missing", control: "none" }
          : isNewEpoch
          ? { status: "idle", control: "none" }
          : state.connection,
        draftsBySessionId: isNewEpoch ? {} : state.draftsBySessionId,
        attentionBySessionId: isNewEpoch ? {} : state.attentionBySessionId,
        seenAttentionBySessionId: isNewEpoch ? {} : state.seenAttentionBySessionId
      };
    }

    case "UPSERT_SESSIONS": {
      const { sessions, serverEpoch, registryRevision, capacity } = action.payload;
      if (
        serverEpoch &&
        state.serverEpoch &&
        serverEpoch === state.serverEpoch &&
        registryRevision !== undefined &&
        registryRevision < state.registryRevision
      ) {
        return state;
      }

      const nextSessionsById = { ...state.sessionsById };
      for (const s of sessions) {
        const existing = nextSessionsById[s.id];
        if (!existing || s.revision >= existing.revision) {
          nextSessionsById[s.id] = s;
        }
      }

      return {
        ...state,
        sessionsById: nextSessionsById,
        sessionOrder: computeSessionOrder(nextSessionsById),
        serverEpoch: serverEpoch ?? state.serverEpoch,
        registryRevision: Math.max(state.registryRevision, registryRevision ?? state.registryRevision),
        capacity: capacity ?? state.capacity
      };
    }

    case "UPSERT_SESSION": {
      const { session, serverEpoch, registryRevision, capacity } = action.payload;
      const existing = state.sessionsById[session.id];
      if (existing && session.revision < existing.revision) {
        return state;
      }

      const nextSessionsById = {
        ...state.sessionsById,
        [session.id]: session
      };

      return {
        ...state,
        sessionsById: nextSessionsById,
        sessionOrder: computeSessionOrder(nextSessionsById),
        serverEpoch: serverEpoch ?? state.serverEpoch,
        registryRevision: Math.max(state.registryRevision, registryRevision ?? state.registryRevision),
        capacity: capacity ?? state.capacity
      };
    }

    case "REMOVE_SESSION": {
      const { sessionId, registryRevision } = action.payload;
      if (!state.sessionsById[sessionId]) return state;

      const nextSessionsById = { ...state.sessionsById };
      delete nextSessionsById[sessionId];

      const nextDrafts = { ...state.draftsBySessionId };
      delete nextDrafts[sessionId];

      const nextAttention = { ...state.attentionBySessionId };
      delete nextAttention[sessionId];

      const wasActive = state.activeSessionId === sessionId;

      return {
        ...state,
        sessionsById: nextSessionsById,
        sessionOrder: computeSessionOrder(nextSessionsById),
        registryRevision: Math.max(state.registryRevision, registryRevision ?? state.registryRevision),
        activeSessionId: wasActive ? undefined : state.activeSessionId,
        connection: wasActive
          ? { sessionId, status: "missing", control: "none" }
          : state.connection,
        draftsBySessionId: nextDrafts,
        attentionBySessionId: nextAttention
      };
    }

    case "SET_ACTIVE_SESSION": {
      const { sessionId } = action.payload;
      if (!sessionId) {
        return {
          ...state,
          activeSessionId: undefined,
          connection: { sessionId: undefined, status: "idle", control: "none" }
        };
      }

      const exists = Boolean(state.sessionsById[sessionId]);
      if (!exists) {
        return {
          ...state,
          activeSessionId: sessionId,
          connection: { sessionId, status: "missing", control: "none" }
        };
      }

      return {
        ...state,
        activeSessionId: sessionId,
        connection: {
          sessionId,
          status: state.connection.sessionId === sessionId && state.connection.status === "connected"
            ? "connected"
            : "connecting",
          control: state.connection.sessionId === sessionId ? state.connection.control : "none"
        }
      };
    }

    case "SET_CONNECTION": {
      return {
        ...state,
        connection: {
          ...state.connection,
          ...action.payload
        }
      };
    }

    case "SET_DRAFT": {
      const { sessionId, draft } = action.payload;
      return {
        ...state,
        draftsBySessionId: {
          ...state.draftsBySessionId,
          [sessionId]: draft
        }
      };
    }

    case "SET_PENDING_OPERATION": {
      return {
        ...state,
        pendingOperation: action.payload
      };
    }

    case "ADD_ATTENTION": {
      const event = action.payload;
      const seen = state.seenAttentionBySessionId[event.sessionId];
      if (seen === event.eventId) {
        return state;
      }

      return {
        ...state,
        attentionBySessionId: {
          ...state.attentionBySessionId,
          [event.sessionId]: event
        }
      };
    }

    case "REMOVE_ATTENTION": {
      const { sessionId, eventId } = action.payload;
      const nextAttention = { ...state.attentionBySessionId };
      delete nextAttention[sessionId];

      return {
        ...state,
        attentionBySessionId: nextAttention,
        seenAttentionBySessionId: eventId
          ? { ...state.seenAttentionBySessionId, [sessionId]: eventId }
          : state.seenAttentionBySessionId
      };
    }

    default:
      return state;
  }
}
