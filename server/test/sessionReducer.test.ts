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
