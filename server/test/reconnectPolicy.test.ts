import assert from "node:assert/strict";
import test from "node:test";
import { ReconnectManager } from "../../web/src/lib/reconnectPolicy.js";

test("R1: Reconnect follows 1s, 2s, 4s, 8s, 15s delays and stops after 5 consecutive attempts", () => {
  const manager = new ReconnectManager();

  const d1 = manager.nextAttempt();
  assert.deepEqual(d1, { action: "retry", delayMs: 1000, attempt: 1 });

  const d2 = manager.nextAttempt();
  assert.deepEqual(d2, { action: "retry", delayMs: 2000, attempt: 2 });

  const d3 = manager.nextAttempt();
  assert.deepEqual(d3, { action: "retry", delayMs: 4000, attempt: 3 });

  const d4 = manager.nextAttempt();
  assert.deepEqual(d4, { action: "retry", delayMs: 8000, attempt: 4 });

  const d5 = manager.nextAttempt();
  assert.deepEqual(d5, { action: "retry", delayMs: 15000, attempt: 5 });

  // 6th attempt: stops
  const d6 = manager.nextAttempt();
  assert.deepEqual(d6, { action: "stop", reason: "max_attempts_reached" });
  assert.equal(manager.isStopped(), true);

  // Manual reconnect resets state
  manager.onManualReconnect();
  assert.equal(manager.isStopped(), false);
  assert.equal(manager.getAttempt(), 0);

  const dAfterReset = manager.nextAttempt();
  assert.deepEqual(dAfterReset, { action: "retry", delayMs: 1000, attempt: 1 });
});

test("R2: Socket close code 4004 (Session Removed) stops retry immediately with session_missing", () => {
  const manager = new ReconnectManager();
  const decision = manager.handleCloseCode(4004);

  assert.deepEqual(decision, { action: "stop", reason: "session_missing" });
  assert.equal(manager.isStopped(), true);

  // Subsequent attempts should remain stopped
  const next = manager.nextAttempt();
  assert.deepEqual(next, { action: "stop", reason: "max_attempts_reached" });
});

test("R3: Ticket endpoint 404 or unknown_session stops retry immediately with session_missing", () => {
  const manager = new ReconnectManager();
  const decision = manager.handleTicketError(404, "unknown_session");

  assert.deepEqual(decision, { action: "stop", reason: "session_missing" });
  assert.equal(manager.isStopped(), true);
});

test("R4: 1013 (Try again later / overflow) is retryable; eventual sync success resets attempt to 0", () => {
  const manager = new ReconnectManager();

  // Receives 1013 twice
  const d1 = manager.handleCloseCode(1013);
  assert.equal(d1.action, "retry");
  assert.equal(d1.attempt, 1);

  const d2 = manager.handleCloseCode(1013);
  assert.equal(d2.action, "retry");
  assert.equal(d2.attempt, 2);

  // Successful sync completes
  manager.onSyncSuccess();
  assert.equal(manager.getAttempt(), 0);

  // Next failure starts at attempt 1 again
  const d3 = manager.handleCloseCode(1013);
  assert.equal(d3.action, "retry");
  assert.equal(d3.attempt, 1);
  assert.equal(d3.delayMs, 1000);
});

test("R5: TCP open does not reset retry counter; sync failure accumulates until 5 attempts", () => {
  const manager = new ReconnectManager();

  for (let i = 1; i <= 5; i++) {
    // Socket opens (do NOT call onSyncSuccess here!)
    // Then socket closes unexpectedly
    const decision = manager.handleCloseCode(1006);
    assert.equal(decision.action, "retry");
    assert.equal(decision.attempt, i);
  }

  // 6th attempt stops
  const finalDecision = manager.handleCloseCode(1006);
  assert.equal(finalDecision.action, "stop");
  assert.equal(manager.isStopped(), true);
});
