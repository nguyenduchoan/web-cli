import { useCallback, useEffect, useReducer, useRef } from "react";
import * as api from "../../lib/api";
import type { Session } from "../../lib/types";
import { initialSessionsState, sessionsReducer } from "./sessionReducer";
import type { AttentionEvent, ConnectionState, SessionsAction, SessionsState } from "./sessionTypes";

const ACTIVE_SESSION_STORAGE_KEY = "web-cli-active-session";

export type UseSessionsOptions = {
  token: string;
  isAuthenticated: boolean;
};

export function useSessions({ token, isAuthenticated }: UseSessionsOptions) {
  const [state, dispatch] = useReducer(sessionsReducer, initialSessionsState);

  const connectionGenRef = useRef<number>(0);
  const selectionGenRef = useRef<number>(0);
  const authGenRef = useRef<number>(0);
  const inputBlockedRef = useRef<boolean>(false);
  const isFetchingListRef = useRef<boolean>(false);
  const retryCountRef = useRef<number>(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stateRef = useRef<SessionsState>(state);
  stateRef.current = state;

  // Track auth generation on auth change
  useEffect(() => {
    if (!isAuthenticated) {
      authGenRef.current += 1;
      connectionGenRef.current += 1;
      inputBlockedRef.current = true;
      dispatch({ type: "RESET_SESSIONS" });
    }
  }, [isAuthenticated]);

  const switchSession = useCallback((sessionId: string) => {
    // 1. Synchronously block input before React renders or dispatches
    inputBlockedRef.current = true;
    // 2. Increment connection generation to invalidate in-flight socket/xterm callbacks
    connectionGenRef.current += 1;
    // 3. Increment selection generation to guard against auto-switch races
    selectionGenRef.current += 1;

    // 4. Save to tab sessionStorage
    try {
      sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
    } catch {
      // Ignore sessionStorage errors in private mode
    }

    // 5. Dispatch state update
    dispatch({ type: "SET_ACTIVE_SESSION", payload: { sessionId } });
  }, []);

  const clearActiveSession = useCallback(() => {
    inputBlockedRef.current = true;
    connectionGenRef.current += 1;
    selectionGenRef.current += 1;
    try {
      sessionStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    } catch {
      // Ignore
    }
    dispatch({ type: "SET_ACTIVE_SESSION", payload: { sessionId: undefined } });
    dispatch({ type: "SET_CONNECTION", payload: { status: "idle", control: "none" } });
  }, []);

  const setConnection = useCallback((connection: Partial<ConnectionState>) => {
    if (connection.status === "connected" && connection.control === "controller") {
      inputBlockedRef.current = false;
    } else if (connection.status === "disconnected" || connection.status === "missing" || connection.status === "idle") {
      inputBlockedRef.current = true;
    }
    dispatch({ type: "SET_CONNECTION", payload: connection });
  }, []);

  const isInputAllowed = useCallback(() => {
    return (
      !inputBlockedRef.current &&
      stateRef.current.connection.status === "connected" &&
      stateRef.current.connection.control === "controller"
    );
  }, []);

  // Fetch session list with stale-guard and backoff retry
  const fetchSessions = useCallback(async (): Promise<void> => {
    if (!isAuthenticated || isFetchingListRef.current) return;
    const currentAuthGen = authGenRef.current;
    isFetchingListRef.current = true;

    try {
      const response = await api.listSessions(token);
      if (authGenRef.current !== currentAuthGen) return;

      retryCountRef.current = 0; // Reset retry counter on success
      const serverEpoch = response.serverEpoch ?? stateRef.current.serverEpoch ?? "epoch-1";
      const registryRevision = response.registryRevision ?? stateRef.current.registryRevision;

      dispatch({
        type: "LOAD_SESSIONS",
        payload: {
          sessions: response.sessions,
          serverEpoch,
          registryRevision,
          capacity: response.capacity
        }
      });

      // Handle initial restore / hash / sessionStorage
      const currentState = stateRef.current;
      if (!currentState.activeSessionId) {
        // Priority: hash -> sessionStorage -> newest running session
        let targetId: string | undefined;
        let isHashTarget = false;

        const hash = window.location.hash;
        const match = hash.match(/^#session=([0-9a-fA-F-]+)$/);
        if (match) {
          targetId = match[1];
          isHashTarget = true;
        }

        if (!targetId) {
          try {
            targetId = sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) || undefined;
          } catch {
            // Ignore
          }
        }

        if (targetId) {
          const exists = response.sessions.some((s) => s.id === targetId);
          if (exists) {
            switchSession(targetId);
          } else if (isHashTarget) {
            // Hash specifies a session that no longer exists on server
            dispatch({
              type: "SET_CONNECTION",
              payload: { status: "missing", control: "none" }
            });
          } else {
            // SessionStorage target was deleted; fallback to running session
            const newestRunning = response.sessions
              .filter((s) => s.state === "running")
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            if (newestRunning) {
              switchSession(newestRunning.id);
            }
          }
        } else {
          // No target, pick newest running session if any
          const newestRunning = response.sessions
            .filter((s) => s.state === "running")
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          if (newestRunning) {
            switchSession(newestRunning.id);
          }
        }
      }
    } catch (err) {
      if (authGenRef.current !== currentAuthGen) return;
      throw err;
    } finally {
      isFetchingListRef.current = false;
    }
  }, [isAuthenticated, token, switchSession]);

  // Polling loop: single owner of scheduling and backoff
  useEffect(() => {
    if (!isAuthenticated) return;

    let active = true;

    const scheduleNextPoll = (isError = false) => {
      clearTimeout(pollTimerRef.current);
      if (!active) return;

      const isVisible = document.visibilityState === "visible";
      const isOnline = navigator.onLine;

      if (!isVisible || !isOnline || !isAuthenticated) return;

      let delayMs = 5000;
      if (isError) {
        retryCountRef.current = Math.min(retryCountRef.current + 1, 5);
        const baseMs = [1000, 2000, 4000, 8000, 15000][retryCountRef.current - 1] ?? 15000;
        const jitterMs = Math.random() * 0.2 * baseMs;
        delayMs = baseMs + jitterMs;
      } else {
        retryCountRef.current = 0;
      }

      pollTimerRef.current = setTimeout(async () => {
        if (!active) return;
        let failed = false;
        try {
          await fetchSessions();
        } catch {
          failed = true;
        }
        if (active) scheduleNextPoll(failed);
      }, delayMs);
    };

    const handleVisibilityOrOnline = () => {
      if (document.visibilityState === "visible" && navigator.onLine && isAuthenticated) {
        retryCountRef.current = 0;
        clearTimeout(pollTimerRef.current);
        void fetchSessions().then(
          () => {
            if (active) scheduleNextPoll(false);
          },
          () => {
            if (active) scheduleNextPoll(true);
          }
        );
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityOrOnline);
    window.addEventListener("online", handleVisibilityOrOnline);
    window.addEventListener("focus", handleVisibilityOrOnline);

    void fetchSessions().then(
      () => {
        if (active) scheduleNextPoll(false);
      },
      () => {
        if (active) scheduleNextPoll(true);
      }
    );

    return () => {
      active = false;
      clearTimeout(pollTimerRef.current);
      document.removeEventListener("visibilitychange", handleVisibilityOrOnline);
      window.removeEventListener("online", handleVisibilityOrOnline);
      window.removeEventListener("focus", handleVisibilityOrOnline);
    };
  }, [isAuthenticated, fetchSessions]);

  // Mutations
  const createNewSession = useCallback(
    async (input: {
      agentId: string;
      projectId: string;
      subpath?: string;
      name?: string;
      cols?: number;
      rows?: number;
    }): Promise<Session> => {
      const opId = crypto.randomUUID();
      const currentSelectionGen = selectionGenRef.current;

      dispatch({
        type: "SET_PENDING_OPERATION",
        payload: { id: opId, type: "create" }
      });

      try {
        const response = await api.createSession(token, input, {
          idempotencyKey: opId
        });

        dispatch({
          type: "UPSERT_SESSION",
          payload: {
            session: response.session,
            serverEpoch: response.serverEpoch,
            registryRevision: response.registryRevision,
            capacity: response.capacity
          }
        });

        // Only auto-switch if user hasn't actively navigated away during creation
        if (selectionGenRef.current === currentSelectionGen) {
          switchSession(response.session.id);
        }

        return response.session;
      } finally {
        dispatch({ type: "SET_PENDING_OPERATION", payload: undefined });
      }
    },
    [token, switchSession]
  );

  const restartCurrentSession = useCallback(
    async (sessionId?: string, input: { cols?: number; rows?: number } = {}): Promise<Session> => {
      const targetId = sessionId ?? stateRef.current.activeSessionId;
      if (!targetId) throw new Error("Không có phiên để khởi động lại.");

      const opId = crypto.randomUUID();
      const currentSelectionGen = selectionGenRef.current;

      dispatch({
        type: "SET_PENDING_OPERATION",
        payload: { id: opId, type: "restart", sessionId: targetId }
      });

      try {
        const response = await api.restartSession(token, targetId, input, {
          idempotencyKey: opId
        });

        dispatch({
          type: "UPSERT_SESSION",
          payload: {
            session: response.session,
            serverEpoch: response.serverEpoch,
            registryRevision: response.registryRevision,
            capacity: response.capacity
          }
        });

        // Only auto-switch to replacement if user hasn't switched away
        if (
          selectionGenRef.current === currentSelectionGen &&
          stateRef.current.activeSessionId === targetId
        ) {
          switchSession(response.session.id);
        }

        return response.session;
      } finally {
        dispatch({ type: "SET_PENDING_OPERATION", payload: undefined });
      }
    },
    [token, switchSession]
  );

  const killCurrentSession = useCallback(
    async (sessionId?: string): Promise<Session> => {
      const targetId = sessionId ?? stateRef.current.activeSessionId;
      if (!targetId) throw new Error("Không có phiên để kết thúc.");

      const opId = crypto.randomUUID();

      dispatch({
        type: "SET_PENDING_OPERATION",
        payload: { id: opId, type: "kill", sessionId: targetId }
      });

      try {
        const response = await api.killSession(token, targetId);

        dispatch({
          type: "UPSERT_SESSION",
          payload: {
            session: response.session,
            serverEpoch: response.serverEpoch,
            registryRevision: response.registryRevision,
            capacity: response.capacity
          }
        });

        return response.session;
      } finally {
        dispatch({ type: "SET_PENDING_OPERATION", payload: undefined });
      }
    },
    [token]
  );

  const setDraft = useCallback((sessionId: string, draft: string) => {
    dispatch({ type: "SET_DRAFT", payload: { sessionId, draft } });
  }, []);

  const getDraft = useCallback(
    (sessionId: string): string => {
      return stateRef.current.draftsBySessionId[sessionId] ?? "";
    },
    []
  );

  const markAttentionSeen = useCallback((sessionId: string, eventId: string) => {
    dispatch({ type: "REMOVE_ATTENTION", payload: { sessionId, eventId } });
  }, []);

  const addAttention = useCallback((event: AttentionEvent) => {
    dispatch({ type: "ADD_ATTENTION", payload: event });
  }, []);

  const activeSession = state.activeSessionId
    ? state.sessionsById[state.activeSessionId]
    : undefined;

  return {
    state,
    activeSession,
    connectionGeneration: connectionGenRef.current,
    isInputAllowed,
    switchSession,
    clearActiveSession,
    setConnection,
    fetchSessions,
    createNewSession,
    restartCurrentSession,
    killCurrentSession,
    setDraft,
    getDraft,
    markAttentionSeen,
    addAttention,
    dispatch
  };
}
