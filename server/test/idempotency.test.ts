import assert from "node:assert/strict";
import test from "node:test";
import { IdempotencyStore, canonicalFingerprint } from "../src/idempotency.js";
import { IdempotencyConflictError, IdempotencyCapacityError, AppHttpError } from "../src/httpErrors.js";

test("idempotency fingerprint is deterministic regardless of key order", () => {
  const p1 = { b: 2, a: 1, nested: { y: "hello", x: "world" } };
  const p2 = { a: 1, nested: { x: "world", y: "hello" }, b: 2 };
  assert.equal(canonicalFingerprint(p1), canonicalFingerprint(p2));
});

test("S08: concurrent calls with identical key and payload share single execution", async () => {
  const store = new IdempotencyStore();
  let executions = 0;
  const key = "11111111-1111-4111-8111-111111111111";

  const action = async () => {
    executions++;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { statusCode: 201, body: { id: "session-1", executions } };
  };

  const [res1, res2] = await Promise.all([
    store.execute("POST", "/api/sessions", key, { agentId: "codex" }, action),
    store.execute("POST", "/api/sessions", key, { agentId: "codex" }, action)
  ]);

  assert.equal(executions, 1);
  assert.deepEqual(res1, res2);
  assert.equal(res1.statusCode, 201);
  assert.equal(res1.body.executions, 1);
});

test("S10: same key with different body throws idempotency_conflict", async () => {
  const store = new IdempotencyStore();
  const key = "22222222-2222-4222-8222-222222222222";

  await store.execute("POST", "/api/sessions", key, { agentId: "codex" }, async () => {
    return { statusCode: 201, body: { ok: true } };
  });

  await assert.rejects(
    () => store.execute("POST", "/api/sessions", key, { agentId: "shell" }, async () => {
      return { statusCode: 201, body: { ok: true } };
    }),
    IdempotencyConflictError
  );
});

test("S10: same key across different routes have separate namespaces", async () => {
  const store = new IdempotencyStore();
  const key = "33333333-3333-4333-8333-333333333333";

  const res1 = await store.execute("POST", "/api/sessions/session-a/restart", key, { cols: 80 }, async () => {
    return { statusCode: 200, body: { session: "new-a" } };
  });

  const res2 = await store.execute("POST", "/api/sessions/session-b/restart", key, { cols: 80 }, async () => {
    return { statusCode: 200, body: { session: "new-b" } };
  });

  assert.equal(res1.body.session, "new-a");
  assert.equal(res2.body.session, "new-b");
});

test("S11: retry with same key replays cached response, but does not cache 401/403/validation_error", async () => {
  const store = new IdempotencyStore();
  const keySuccess = "44444444-4444-4444-8444-444444444444";
  let count = 0;

  // Cacheable 201
  await store.execute("POST", "/api/sessions", keySuccess, { agentId: "codex" }, async () => {
    count++;
    return { statusCode: 201, body: { session: "created" } };
  });
  const replay = await store.execute("POST", "/api/sessions", keySuccess, { agentId: "codex" }, async () => {
    count++;
    return { statusCode: 201, body: { session: "created-again" } };
  });
  assert.equal(count, 1);
  assert.equal(replay.body.session, "created");

  // Non-cacheable 401
  const keyAuth = "55555555-5555-4555-8555-555555555555";
  let authAttempts = 0;
  await store.execute("POST", "/api/sessions", keyAuth, {}, async () => {
    authAttempts++;
    return { statusCode: 401, body: { error: "unauthorized" } };
  });
  await store.execute("POST", "/api/sessions", keyAuth, {}, async () => {
    authAttempts++;
    return { statusCode: 201, body: { session: "auth-passed" } };
  });
  assert.equal(authAttempts, 2);
});

test("capacity limit triggers 429 when store is full of active entries", async () => {
  const store = new IdempotencyStore(2);
  const k1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const k2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const k3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  await store.execute("POST", "/test", k1, {}, async () => ({ statusCode: 200, body: {} }));
  await store.execute("POST", "/test", k2, {}, async () => ({ statusCode: 200, body: {} }));

  await assert.rejects(
    () => store.execute("POST", "/test", k3, {}, async () => ({ statusCode: 200, body: {} })),
    IdempotencyCapacityError
  );
});
