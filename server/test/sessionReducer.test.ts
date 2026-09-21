import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "../../web/src/lib/types.js";
import {
  computeSessionOrder,
  initialSessionsState,
  sessionsReducer
} from "../../web/src/features/sessions/sessionReducer.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    agentId: "codex",
    agentLabel: "Codex",
    projectId: "proj-1",
    projectLabel: "Project 1",
    rootProjectLabel: "Project 1",
    workingDirectoryId: "dir-1",
    workingDirectoryLabel: "Project 1",
    state: "running",
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    lastActivityAt: "2026-09-20T10:00:00.000Z",
    revision: 1,
    outputLastSeq: 0,
    ...overrides
  };
}

test("computeSessionOrder groups running/idle before stopping before exited", () => {
  const sessions: Record<string, Session> = {
    sExited: makeSession({ id: "sExited", state: "exited", createdAt: "2026-09-20T08:00:00.000Z" }),
    sStopping: makeSession({ id: "sStopping", state: "stopping", createdAt: "2026-09-20T09:00:00.000Z" }),
    sRunning: makeSession({ id: "sRunning", state: "running", createdAt: "2026-09-20T10:00:00.000Z" }),
    sIdle: makeSession({ id: "sIdle", state: "idle", createdAt: "2026-09-20T07:00:00.000Z" })
  };

  const order = computeSessionOrder(sessions);
  // Group 1: idle, running -> sIdle (07:00), sRunning (10:00)
  // Group 2: stopping -> sStopping (09:00)
  // Group 3: exited -> sExited (08:00)
  assert.deepEqual(order, ["sIdle", "sRunning", "sStopping", "sExited"]);
});

test("stale list snapshot with lower registryRevision is ignored", () => {
  const s1 = makeSession({ id: "s1", revision: 2 });
  const state = sessionsReducer(initialSessionsState, {
    type: "LOAD_SESSIONS",
    payload: {
      sessions: [s1],
      serverEpoch: "epoch-1",
      registryRevision: 10
    }
  });

  assert.equal(state.registryRevision, 10);
  assert.equal(Object.keys(state.sessionsById).length, 1);

  // Stale snapshot with revision 5
  const staleState = sessionsReducer(state, {
    type: "LOAD_SESSIONS",
    payload: {
      sessions: [],
      serverEpoch: "epoch-1",
      registryRevision: 5
    }
  });

  assert.equal(staleState, state);
});

test("stale entity update with lower revision is ignored", () => {
  const s1 = makeSession({ id: "s1", revision: 5, state: "running" });
  let state = sessionsReducer(initialSessionsState, {
    type: "LOAD_SESSIONS",
    payload: {
      sessions: [s1],
      serverEpoch: "epoch-1",
      registryRevision: 5
    }
  });

  // Stale update with revision 3
  const staleSession = makeSession({ id: "s1", revision: 3, state: "stopping" });
  state = sessionsReducer(state, {
    type: "UPSERT_SESSION",
    payload: { session: staleSession }
  });

  assert.equal(state.sessionsById["s1"].state, "running");
  assert.equal(state.sessionsById["s1"].revision, 5);

  // Valid update with revision 6
  const newerSession = makeSession({ id: "s1", revision: 6, state: "stopping" });
  state = sessionsReducer(state, {
    type: "UPSERT_SESSION",
    payload: { session: newerSession }
  });

  assert.equal(state.sessionsById["s1"].state, "stopping");
  assert.equal(state.sessionsById["s1"].revision, 6);
});

test("UPSERT_SESSION does NOT change activeSessionId", () => {
  const s1 = makeSession({ id: "s1" });
  let state = sessionsReducer(initialSessionsState, {
    type: "LOAD_SESSIONS",
    payload: { sessions: [s1], serverEpoch: "e1", registryRevision: 1 }
  });
  state = sessionsReducer(state, {
    type: "SET_ACTIVE_SESSION",
    payload: { sessionId: "s1" }
  });
  assert.equal(state.activeSessionId, "s1");

  // Create session 2
  const s2 = makeSession({ id: "s2" });
  state = sessionsReducer(state, {
    type: "UPSERT_SESSION",
    payload: { session: s2 }
  });

  // Active session MUST remain s1!
  assert.equal(state.activeSessionId, "s1");
  assert.ok(state.sessionsById["s2"]);
});

test("drafts are isolated per session in state", () => {
  let state = initialSessionsState;
  state = sessionsReducer(state, {
    type: "SET_DRAFT",
    payload: { sessionId: "s1", draft: "Draft for A" }
  });
  state = sessionsReducer(state, {
    type: "SET_DRAFT",
    payload: { sessionId: "s2", draft: "Draft for B" }
  });

  assert.equal(state.draftsBySessionId["s1"], "Draft for A");
  assert.equal(state.draftsBySessionId["s2"], "Draft for B");
});

test("REMOVE_SESSION cleans up draft and sets status to missing if active", () => {
  const s1 = makeSession({ id: "s1" });
  let state = sessionsReducer(initialSessionsState, {
    type: "LOAD_SESSIONS",
    payload: { sessions: [s1], serverEpoch: "e1", registryRevision: 1 }
  });
  state = sessionsReducer(state, {
    type: "SET_ACTIVE_SESSION",
    payload: { sessionId: "s1" }
  });
  state = sessionsReducer(state, {
    type: "SET_DRAFT",
    payload: { sessionId: "s1", draft: "Draft" }
  });

  state = sessionsReducer(state, {
    type: "REMOVE_SESSION",
    payload: { sessionId: "s1" }
  });

  assert.equal(state.sessionsById["s1"], undefined);
  assert.equal(state.draftsBySessionId["s1"], undefined);
  assert.equal(state.activeSessionId, undefined);
  assert.equal(state.connection.status, "missing");
});

test("P5.1: LOAD_SESSIONS prunes stale drafts, attention, and seenAttention for missing sessions", () => {
  const sA = makeSession({ id: "sA" });
  const sB = makeSession({ id: "sB" });

  let state = sessionsReducer(initialSessionsState, {
    type: "LOAD_SESSIONS",
    payload: { sessions: [sA, sB], serverEpoch: "e1", registryRevision: 1 }
  });

  state = sessionsReducer(state, {
    type: "SET_DRAFT",
    payload: { sessionId: "sA", draft: "Draft for A" }
  });
  state = sessionsReducer(state, {
    type: "SET_DRAFT",
    payload: { sessionId: "sB", draft: "Draft for B" }
  });
  state = sessionsReducer(state, {
    type: "ADD_ATTENTION",
    payload: { sessionId: "sA", eventId: "ev-A", createdAt: "now" }
  });
  state = sessionsReducer(state, {
    type: "ADD_ATTENTION",
    payload: { sessionId: "sB", eventId: "ev-B", createdAt: "now" }
  });

  // Next authoritative LOAD_SESSIONS contains ONLY sB (sA was deleted/evicted on server)
  state = sessionsReducer(state, {
    type: "LOAD_SESSIONS",
    payload: { sessions: [sB], serverEpoch: "e1", registryRevision: 2 }
  });

  // sA draft and attention must be pruned!
  assert.equal(state.draftsBySessionId["sA"], undefined);
  assert.equal(state.attentionBySessionId["sA"], undefined);

  // sB draft and attention preserved
  assert.equal(state.draftsBySessionId["sB"], "Draft for B");
  assert.equal(state.attentionBySessionId["sB"]?.eventId, "ev-B");
});

test("P5.2: RESET_SESSIONS resets sessions, drafts, attention, and connection state to clean initial state", () => {
  const sA = makeSession({ id: "sA" });
  let state = sessionsReducer(initialSessionsState, {
    type: "LOAD_SESSIONS",
    payload: { sessions: [sA], serverEpoch: "e1", registryRevision: 1, capacity: { active: 1, reserved: 0, max: 5 } }
  });
  state = sessionsReducer(state, {
    type: "SET_ACTIVE_SESSION",
    payload: { sessionId: "sA" }
  });
  state = sessionsReducer(state, {
    type: "SET_DRAFT",
    payload: { sessionId: "sA", draft: "my draft" }
  });
  state = sessionsReducer(state, {
    type: "SET_CONNECTION",
    payload: { status: "connected", control: "controller" }
  });

  // Dispatch RESET_SESSIONS (e.g. on logout or expired auth)
  state = sessionsReducer(state, { type: "RESET_SESSIONS" });

  assert.deepEqual(state.sessionsById, {});
  assert.deepEqual(state.sessionOrder, []);
  assert.equal(state.activeSessionId, undefined);
  assert.deepEqual(state.draftsBySessionId, {});
  assert.deepEqual(state.attentionBySessionId, {});
  assert.equal(state.connection.status, "idle");
  assert.equal(state.connection.control, "none");
  // Capacity max preserved
  assert.equal(state.capacity.max, 5);
});
