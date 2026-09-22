import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKOFF_DELAYS,
  getPollingDelay,
  SessionPollingScheduler
} from "../../web/src/lib/pollingPolicy.js";

// Helper for deterministic fake time in tests
class FakeClock {
  public currentTime = 0;
  private timers: Array<{ id: number; dueTime: number; callback: () => void }> = [];
  private nextTimerId = 1;

  public setTimeout = (callback: () => void, ms: number) => {
    const id = this.nextTimerId++;
    this.timers.push({ id, dueTime: this.currentTime + ms, callback });
    this.timers.sort((a, b) => a.dueTime - b.dueTime);
    return id;
  };

  public clearTimeout = (id: any) => {
    this.timers = this.timers.filter((t) => t.id !== id);
  };

  public async advance(ms: number) {
    this.currentTime += ms;
    while (this.timers.length > 0 && this.timers[0].dueTime <= this.currentTime) {
      const timer = this.timers.shift()!;
      timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  public getPendingCount(): number {
    return this.timers.length;
  }

  public getNextDueDelay(): number | null {
    if (this.timers.length === 0) return null;
    return Math.max(0, this.timers[0].dueTime - this.currentTime);
  }
}

test("P3: Errors follow base delay: 1 -> 1s, 2 -> 2s, 3 -> 4s, 4 -> 8s, 5+ -> 15s (helper and scheduler)", async () => {
  // 1. Check pure helper base delay and jitter bounds
  const expectedBase = [1000, 2000, 4000, 8000, 15000];
  for (let i = 1; i <= 6; i++) {
    const expected = expectedBase[Math.min(i, 5) - 1];

    // With zero jitter
    const delayZero = getPollingDelay({
      activeSession: false,
      visible: true,
      online: true,
      retryCount: i,
      lastAttemptFailed: true,
      randomJitterFn: () => 0
    });
    assert.equal(delayZero, expected, `retryCount=${i} base delay`);

    // With max jitter (0.2 * base)
    const delayMax = getPollingDelay({
      activeSession: false,
      visible: true,
      online: true,
      retryCount: i,
      lastAttemptFailed: true,
      randomJitterFn: () => 1
    });
    assert.equal(delayMax, expected * 1.2, `retryCount=${i} max jitter delay`);
  }

  // 2. Check scheduler with fake clock on consecutive errors
  const clock = new FakeClock();
  let failCount = 0;
  let fetchAttempts = 0;
  const recordedDelays: number[] = [];

  const scheduler = new SessionPollingScheduler({
    fetchSessions: async () => {
      fetchAttempts++;
      throw new Error(`Fetch failed attempt #${fetchAttempts}`);
    },
    hasActiveSession: () => true,
    isAuthenticated: () => true,
    isVisible: () => true,
    isOnline: () => true,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    randomJitterFn: () => 0, // Deterministic zero jitter
    onTimerScheduled: (delay) => recordedDelays.push(delay)
  });

  scheduler.start();

  // First fetch fails
  await scheduler.executeFetch();
  assert.equal(scheduler.lastAttemptFailed, true);
  assert.equal(scheduler.retryCount, 1);
  assert.equal(recordedDelays[0], 1000);

  // Advance clock by 1000ms -> triggers attempt 2
  await clock.advance(1000);
  assert.equal(scheduler.retryCount, 2);
  assert.equal(recordedDelays[1], 2000);

  // Advance clock by 2000ms -> triggers attempt 3
  await clock.advance(2000);
  assert.equal(scheduler.retryCount, 3);
  assert.equal(recordedDelays[2], 4000);

  // Advance clock by 4000ms -> triggers attempt 4
  await clock.advance(4000);
  assert.equal(scheduler.retryCount, 4);
  assert.equal(recordedDelays[3], 8000);

  // Advance clock by 8000ms -> triggers attempt 5
  await clock.advance(8000);
  assert.equal(scheduler.retryCount, 5);
  assert.equal(recordedDelays[4], 15000);

  // Advance clock by 15000ms -> triggers attempt 6 (clamped to 15s)
  await clock.advance(15000);
  assert.equal(scheduler.retryCount, 5);
  assert.equal(recordedDelays[5], 15000);

  scheduler.stop();
});

test("P4: error, error, success => retry count reset => next normal delay 5s", async () => {
  const clock = new FakeClock();
  let shouldFail = true;
  let fetchCount = 0;
  const scheduledDelays: number[] = [];

  const scheduler = new SessionPollingScheduler({
    fetchSessions: async () => {
      fetchCount++;
      if (shouldFail) {
        throw new Error("Simulated network failure");
      }
    },
    hasActiveSession: () => true,
    isAuthenticated: () => true,
    isVisible: () => true,
    isOnline: () => true,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    randomJitterFn: () => 0,
    onTimerScheduled: (delay) => scheduledDelays.push(delay)
  });

  scheduler.start();

  // 1. Error 1
  await scheduler.executeFetch();
  assert.equal(scheduler.retryCount, 1);
  assert.equal(scheduledDelays[0], 1000);

  // 2. Advance 1s -> Error 2
  await clock.advance(1000);
  assert.equal(scheduler.retryCount, 2);
  assert.equal(scheduledDelays[1], 2000);

  // 3. Next attempt succeeds
  shouldFail = false;
  await clock.advance(2000);

  assert.equal(scheduler.lastAttemptFailed, false);
  assert.equal(scheduler.retryCount, 0, "retryCount must reset to 0 after success");
  assert.equal(scheduledDelays[2], 5000, "next delay must be 5000ms normal interval");

  scheduler.stop();
});

test("P5: GET explicit success with no activeSession => no 5s timer; clear activeSession cancels timer immediately", async () => {
  const clock = new FakeClock();
  let hasActive = false;
  let fetchCalls = 0;

  const scheduler = new SessionPollingScheduler({
    fetchSessions: async () => {
      fetchCalls++;
    },
    hasActiveSession: () => hasActive,
    isAuthenticated: () => true,
    isVisible: () => true,
    isOnline: () => true,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    randomJitterFn: () => 0
  });

  scheduler.start();

  // 1. Initial explicit fetch with no activeSession
  await scheduler.executeFetch();
  assert.equal(fetchCalls, 1);
  assert.equal(scheduler.hasScheduledTimer(), false, "No periodic timer should be scheduled when no active session");

  // Advance clock by 30 seconds -> no periodic fetches happen
  await clock.advance(30000);
  assert.equal(fetchCalls, 1, "No further fetches occur without active session");

  // 2. Active session is now opened -> reconcile(true) schedules 5s timer
  hasActive = true;
  scheduler.reconcileActiveSession(true);
  assert.equal(scheduler.hasScheduledTimer(), true, "5s timer scheduled when active session becomes true");
  assert.equal(clock.getNextDueDelay(), 5000);

  // 3. Clear active session before timer fires -> timer cancelled immediately
  hasActive = false;
  scheduler.reconcileActiveSession(false);
  assert.equal(scheduler.hasScheduledTimer(), false, "Timer must be cancelled immediately when active session is cleared");
  assert.equal(clock.getPendingCount(), 0);

  // Advance clock by 10s -> still no fetches
  await clock.advance(10000);
  assert.equal(fetchCalls, 1);

  scheduler.stop();
});

test("P6: active session restored/created starts exactly one timer; switch A -> B does not stack timers or reset backoff", async () => {
  const clock = new FakeClock();
  let activeSessionId: string | undefined = undefined;
  let fetchCalls = 0;
  const delays: number[] = [];

  const scheduler = new SessionPollingScheduler({
    fetchSessions: async () => {
      fetchCalls++;
    },
    hasActiveSession: () => Boolean(activeSessionId),
    isAuthenticated: () => true,
    isVisible: () => true,
    isOnline: () => true,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    randomJitterFn: () => 0,
    onTimerScheduled: (d) => delays.push(d)
  });

  scheduler.start();

  // Initially no active session
  await scheduler.executeFetch();
  assert.equal(scheduler.hasScheduledTimer(), false);

  // Active session created / restored
  activeSessionId = "session-aaa";
  scheduler.reconcileActiveSession(true);
  assert.equal(scheduler.hasScheduledTimer(), true);
  assert.equal(clock.getPendingCount(), 1, "Exactly one timer scheduled");
  assert.equal(delays[delays.length - 1], 5000);

  // Switch from session A to session B (hasActiveSession is still true)
  activeSessionId = "session-bbb";
  scheduler.reconcileActiveSession(true);
  assert.equal(clock.getPendingCount(), 1, "No duplicate timer when switching sessions while active");

  // Advance 5s -> exactly one fetch executes
  const countBefore = fetchCalls;
  await clock.advance(5000);
  assert.equal(fetchCalls, countBefore + 1, "Exactly one fetch triggered at 5s");
  assert.equal(scheduler.hasScheduledTimer(), true, "Next 5s poll scheduled");

  scheduler.stop();
});

test("P7: First GET error retries with backoff even without activeSession; restores backoff on success; stop cancels pending", async () => {
  const clock = new FakeClock();
  let activeSessionId: string | undefined = undefined;
  let isServerError = true;
  let fetchCount = 0;
  const scheduledDelays: number[] = [];

  const scheduler = new SessionPollingScheduler({
    fetchSessions: async () => {
      fetchCount++;
      if (isServerError) {
        throw new Error("Initial login GET failed");
      }
    },
    hasActiveSession: () => Boolean(activeSessionId),
    isAuthenticated: () => true,
    isVisible: () => true,
    isOnline: () => true,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    randomJitterFn: () => 0,
    onTimerScheduled: (d) => scheduledDelays.push(d)
  });

  scheduler.start();

  // First GET fails when activeSession is not yet known
  await scheduler.executeFetch();
  assert.equal(scheduler.lastAttemptFailed, true);
  assert.equal(scheduler.retryCount, 1);
  assert.equal(scheduler.hasScheduledTimer(), true, "Must schedule retry even if no active session yet");
  assert.equal(scheduledDelays[0], 1000);

  // Advance clock by 1s: retry succeeds and restores activeSession
  isServerError = false;
  activeSessionId = "restored-session-123";
  await clock.advance(1000);

  assert.equal(scheduler.lastAttemptFailed, false);
  assert.equal(scheduler.retryCount, 0, "Backoff reset on successful restore");
  assert.equal(scheduler.hasScheduledTimer(), true, "Periodic 5s poll started for restored session");
  assert.equal(scheduledDelays[scheduledDelays.length - 1], 5000);

  // Test unmount/stop while fetch is pending
  let delayedResolve!: () => void;
  const pendingPromise = new Promise<void>((resolve) => {
    delayedResolve = resolve;
  });

  const unmountScheduler = new SessionPollingScheduler({
    fetchSessions: async () => {
      await pendingPromise;
    },
    hasActiveSession: () => true,
    isAuthenticated: () => true,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout
  });

  unmountScheduler.start();
  const fetchPromise = unmountScheduler.executeFetch();
  assert.equal(unmountScheduler.isFetching, true);

  // User logs out / unmounts before fetch finishes
  unmountScheduler.stop();
  assert.equal(unmountScheduler.stopped, true);

  // Late completion of the fetch
  delayedResolve();
  await fetchPromise;

  assert.equal(unmountScheduler.hasScheduledTimer(), false, "Late completion must not schedule new timers after stop");

  scheduler.stop();
});

test("P8: runtime getters use the current auth and fetch behavior", async () => {
  const clock = new FakeClock();
  let authenticated = false;
  let fetchVersion = "old";
  const calls: string[] = [];

  const scheduler = new SessionPollingScheduler({
    fetchSessions: async () => {
      calls.push(fetchVersion);
    },
    hasActiveSession: () => true,
    isAuthenticated: () => authenticated,
    isVisible: () => true,
    isOnline: () => true,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    randomJitterFn: () => 0
  });

  authenticated = true;
  fetchVersion = "new";
  scheduler.start();
  await scheduler.executeFetch();

  assert.deepEqual(calls, ["new"]);
  assert.equal(clock.getNextDueDelay(), 5000);

  scheduler.stop();
});

test("P9: re-login waits for a stale fetch to drain, then starts exactly one current fetch", async () => {
  const clock = new FakeClock();
  let releaseOldFetch!: () => void;
  const oldFetchPending = new Promise<void>((resolve) => {
    releaseOldFetch = resolve;
  });
  let fetchVersion = "old";
  const calls: string[] = [];

  const scheduler = new SessionPollingScheduler({
    fetchSessions: async () => {
      calls.push(fetchVersion);
      if (fetchVersion === "old") {
        await oldFetchPending;
      }
    },
    hasActiveSession: () => true,
    isAuthenticated: () => true,
    isVisible: () => true,
    isOnline: () => true,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    randomJitterFn: () => 0
  });

  scheduler.start();
  const oldFetch = scheduler.executeFetch();
  assert.deepEqual(calls, ["old"]);
  assert.equal(scheduler.isFetching, true);

  scheduler.stop();
  fetchVersion = "new";
  scheduler.start();
  await scheduler.executeFetch();
  assert.deepEqual(calls, ["old"], "re-login must not overlap the stale request");

  releaseOldFetch();
  await oldFetch;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["old", "new"], "re-login must start a current fetch after stale drain");
  assert.equal(clock.getPendingCount(), 1, "current fetch schedules exactly one periodic timer");
  assert.equal(clock.getNextDueDelay(), 5000);

  scheduler.stop();
});

test("P10: logout while a fetch is pending never schedules a late timer", async () => {
  const clock = new FakeClock();
  let releaseFetch!: () => void;
  const pendingFetch = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });

  const scheduler = new SessionPollingScheduler({
    fetchSessions: async () => {
      await pendingFetch;
    },
    hasActiveSession: () => true,
    isAuthenticated: () => true,
    isVisible: () => true,
    isOnline: () => true,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    randomJitterFn: () => 0
  });

  scheduler.start();
  const fetch = scheduler.executeFetch();
  scheduler.stop();
  releaseFetch();
  await fetch;

  assert.equal(scheduler.hasScheduledTimer(), false);
  assert.equal(clock.getPendingCount(), 0);
});
