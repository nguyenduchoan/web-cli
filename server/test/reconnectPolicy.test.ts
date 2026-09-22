import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ReconnectManager } from "../../web/src/lib/reconnectPolicy.js";
import { TerminalConnectionSession } from "../../web/src/lib/terminalConnection.js";
import { XtermOperationQueue } from "../../web/src/lib/xtermOperationQueue.js";

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

class MockWebSocket {
  public url: string;
  public protocols: string[];
  public readyState = 0; // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
  public sent: string[] = [];
  public autoFinishClose = true;
  private pendingCloseCode = 1000;
  private listeners: Record<string, ((event: any) => void)[]> = {};

  constructor(url: string, protocols: string[] = []) {
    this.url = url;
    this.protocols = protocols;
  }

  public addEventListener(type: string, listener: (event: any) => void): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  public removeEventListener(type: string, listener: (event: any) => void): void {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
  }

  public emit(type: string, event: any = {}): void {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    const list = this.listeners[type] || [];
    for (const fn of list) {
      fn(event);
    }
  }

  public send(payload: string): void {
    this.sent.push(payload);
  }

  public close(code = 1000): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.pendingCloseCode = code;
    if (this.autoFinishClose) this.finishClose();
  }

  public finishClose(code = this.pendingCloseCode): void {
    this.emit("close", { code });
  }
}

// Keep cancelled callbacks available so tests can deliver already-queued stale work.
function connectionHarness(jitter = 0) {
  let nextId = 1;
  let ticketCalls = 0;
  const sockets: MockWebSocket[] = [];
  const timeouts = new Map<number, { callback: () => void; delay: number }>();
  const intervals = new Map<number, () => void>();
  const clearedIntervals: number[] = [];
  const session = new TerminalConnectionSession({
    sessionId: "async-close-session",
    queue: new XtermOperationQueue(),
    createTicket: async () => { ticketCalls++; return { ticket: "ticket" }; },
    createWebSocket: (url, protocols) => {
      const socket = new MockWebSocket(url, protocols);
      socket.autoFinishClose = false;
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    setTimeoutFn: (callback, delay) => {
      const id = nextId++;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn: (id) => { timeouts.delete(id); },
    setIntervalFn: (callback) => {
      const id = nextId++;
      intervals.set(id, callback);
      return id;
    },
    clearIntervalFn: (id) => { if (id !== undefined) clearedIntervals.push(id); },
    randomJitterFn: () => jitter,
    callbacks: {
      onConnectedChange: () => {},
      onError: () => {},
      writeTerminal: async () => {},
      resetTerminal: () => {},
      resizeTerminal: () => {}
    }
  });
  return {
    session, sockets, timeouts, intervals, clearedIntervals,
    get ticketCalls() { return ticketCalls; },
    async fireRetry(delay = 1000 + jitter) {
      assert.equal(timeouts.size, 1, "exactly one retry timer");
      const [id, timer] = [...timeouts][0];
      assert.equal(timer.delay, delay);
      timeouts.delete(id);
      await timer.callback();
    }
  };
}

function emitGap(socket: MockWebSocket): void {
  socket.emit("message", { data: JSON.stringify({
    type: "sync_start", syncId: "gap-sync", baseSeq: 0, cols: 80, rows: 24, control: "controller"
  }) });
  socket.emit("message", { data: JSON.stringify({ type: "output", seq: 5, data: "gap" }) });
}

test("RP8: async CLOSING blocks a new socket until close owns the retry", async (t) => {
  const h = connectionHarness();
  t.after(() => h.session.dispose());
  await h.session.connect();
  const first = h.sockets[0];
  await h.session.connect();
  assert.equal(h.ticketCalls, 1, "CONNECTING blocks duplicate tickets");
  first.emit("open");
  await h.session.connect();
  assert.equal(h.sockets.length, 1, "OPEN blocks duplicate sockets");
  emitGap(first);
  assert.equal(first.readyState, 2);
  assert.equal(h.session.connected, false);
  await h.session.connect();
  assert.equal(h.sockets.length, 1, "CLOSING blocks early reconnect");
  assert.equal(h.session.reconnectManager.getAttempt(), 0);
  assert.equal(h.timeouts.size, 0, "gap does not schedule retry");
  first.finishClose(1006);
  assert.equal(h.session.reconnectManager.getAttempt(), 1);
  assert.equal(h.sockets.length, 1);
  await h.fireRetry();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.ticketCalls, 2);
});

test("RP9: stale close cleans only its own heartbeat", async (t) => {
  const h = connectionHarness();
  t.after(() => h.session.dispose());
  await h.session.connect();
  const first = h.sockets[0];
  first.emit("open");
  const [heartbeat1] = h.intervals.keys();
  first.close();
  first.finishClose(1006);
  await h.fireRetry();
  const second = h.sockets[1];
  second.emit("open");
  const heartbeat2 = [...h.intervals.keys()][1];
  first.emit("close", { code: 1006 });
  assert.ok(h.clearedIntervals.includes(heartbeat1));
  assert.ok(!h.clearedIntervals.includes(heartbeat2), "old close must not clear H2");
  assert.equal(second.readyState, 1);
  assert.equal(h.session.reconnectManager.getAttempt(), 1);
  assert.equal(h.timeouts.size, 0);
});

test("RP10: queued stale heartbeat cannot ping the new socket", async (t) => {
  const h = connectionHarness();
  t.after(() => h.session.dispose());
  await h.session.connect();
  const first = h.sockets[0];
  first.emit("open");
  const [heartbeat1] = h.intervals.values();
  first.close();
  first.finishClose(1006);
  await h.fireRetry();
  const second = h.sockets[1];
  second.emit("open");
  heartbeat1();
  assert.deepEqual(second.sent, [], "HB1 cannot send through socket2");
  [...h.intervals.values()][1]();
  assert.deepEqual(second.sent, [JSON.stringify({ type: "ping" })]);
});

test("RP11: resume cannot bypass closing or scheduled backoff", async (t) => {
  const h = connectionHarness(125);
  t.after(() => h.session.dispose());
  await h.session.connect();
  const first = h.sockets[0];
  first.emit("open");
  first.close();
  for (let i = 0; i < 3; i++) await h.session.connect();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.ticketCalls, 1);
  assert.equal(h.timeouts.size, 0);
  first.finishClose(1006);
  for (let i = 0; i < 3; i++) await h.session.connect();
  assert.equal(h.sockets.length, 1, "resume after close must also respect backoff");
  assert.equal(h.ticketCalls, 1);
  assert.equal(h.session.reconnectManager.getAttempt(), 1);
  await h.fireRetry();
  assert.equal(h.sockets.length, 2);
});

test("RP12: queued open timeout cannot close an opened or newer socket", async (t) => {
  const h = connectionHarness();
  t.after(() => h.session.dispose());
  await h.session.connect();
  const first = h.sockets[0];
  const timeout1 = [...h.timeouts.values()][0].callback;
  first.emit("open");
  timeout1();
  assert.equal(first.readyState, 1, "cancelled opening timeout cannot close an open socket");
  first.close();
  first.finishClose(1006);
  await h.fireRetry();
  const second = h.sockets[1];
  second.emit("open");
  timeout1();
  assert.equal(second.readyState, 1);
  assert.equal(h.session.reconnectManager.getAttempt(), 1);
});

test("RP13: manual reconnect is allowed only after the previous attempt closes", async (t) => {
  const h = connectionHarness();
  t.after(() => h.session.dispose());
  await h.session.connect();
  const first = h.sockets[0];
  h.session.manualReconnect();
  first.emit("open");
  h.session.manualReconnect();
  first.close();
  h.session.manualReconnect();
  await Promise.resolve();
  assert.equal(h.ticketCalls, 1, "manual retry cannot overlap CONNECTING/OPEN/CLOSING");
  first.finishClose(1006);
  const staleRetry = [...h.timeouts.values()][0].callback;
  h.session.manualReconnect();
  await Promise.resolve();
  const second = h.sockets[1];
  second.emit("open");
  staleRetry();
  await Promise.resolve();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.session.reconnectManager.getAttempt(), 0);
  assert.equal(h.timeouts.size, 0);
});

test("RP14: dispose cancels attempt timers and invalidates queued callbacks", async () => {
  const h = connectionHarness();
  await h.session.connect();
  const openingTimeout = [...h.timeouts.values()][0].callback;
  h.session.dispose();
  assert.equal(h.timeouts.size, 0, "dispose cancels open timeout before async close arrives");
  openingTimeout();
  h.sockets[0].finishClose(1006);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.session.reconnectManager.getAttempt(), 0);
  await h.session.connect();
  assert.equal(h.sockets.length, 1);
  h.session.manualReconnect();
  await Promise.resolve();
  assert.equal(h.sockets.length, 1, "disposed sessions cannot be revived by queued UI callbacks");
});

test("RP1: TerminalPane production imports and wires ReconnectManager and TerminalConnectionSession", async () => {
  const terminalPaneContent = await fs.promises.readFile(
    new URL("../../web/src/components/TerminalPane.tsx", import.meta.url),
    "utf8"
  );
  assert.match(
    terminalPaneContent,
    /import\s+\{[^}]*ReconnectManager[^}]*\}\s+from\s+["']\.\.\/lib\/reconnectPolicy/
  );
  assert.match(
    terminalPaneContent,
    /import\s+\{[^}]*TerminalConnectionSession[^}]*\}\s+from\s+["']\.\.\/lib\/terminalConnection/
  );
  assert.match(terminalPaneContent, /new\s+ReconnectManager\(\)/);
  assert.match(terminalPaneContent, /new\s+TerminalConnectionSession\(/);
});

test("RP2: mismatch consumes exactly one attempt", async () => {
  let activeSocket: MockWebSocket | undefined;
  const queue = new XtermOperationQueue();
  let scheduledDelay = 0;
  let scheduledCount = 0;

  const session = new TerminalConnectionSession({
    sessionId: "sess-1",
    queue,
    createTicket: async () => ({ ticket: "ticket-1" }),
    createWebSocket: (url, protocols) => {
      activeSocket = new MockWebSocket(url, protocols);
      return activeSocket as unknown as WebSocket;
    },
    setTimeoutFn: (cb, delay) => {
      if (delay !== 10_000) {
        scheduledDelay = delay;
        scheduledCount += 1;
      }
      return 123;
    },
    clearTimeoutFn: () => {},
    randomJitterFn: () => 0,
    callbacks: {
      onConnectedChange: () => {},
      onError: () => {},
      writeTerminal: async () => {},
      resetTerminal: () => {},
      resizeTerminal: () => {}
    }
  });

  await session.connect();
  assert.ok(activeSocket);

  // Open socket
  activeSocket.emit("open");
  // Sync
  activeSocket.emit("message", {
    data: JSON.stringify({
      type: "sync_start",
      syncId: "sync-1",
      baseSeq: 0,
      cols: 80,
      rows: 24,
      control: "controller"
    })
  });
  activeSocket.emit("message", {
    data: JSON.stringify({
      type: "sync_end",
      syncId: "sync-1",
      baseSeq: 0,
      chunkCount: 0
    })
  });
  await queue.barrier();

  // Socket is connected, manager attempt is 0
  assert.equal(session.reconnectManager.getAttempt(), 0);
  assert.equal(scheduledCount, 0);

  // Send sequence gap (expected seq is 1, send 3)
  activeSocket.emit("message", {
    data: JSON.stringify({
      type: "output",
      seq: 3,
      data: "gap-data"
    })
  });

  // onMismatchOrGap closed socket, trigger close event
  // Close handler runs
  assert.equal(session.reconnectManager.getAttempt(), 1);
  assert.equal(scheduledCount, 1);
  assert.equal(scheduledDelay, 1000);
});

test("RP3: repeated TCP-open/sync-fail x5 stops retry and triggers onReconnectExhausted", async () => {
  let activeSocket: MockWebSocket | undefined;
  const queue = new XtermOperationQueue();
  let exhaustedSessionId = "";
  let retryTimerCallback: (() => void) | undefined;

  const session = new TerminalConnectionSession({
    sessionId: "sess-exhaust",
    queue,
    createTicket: async () => ({ ticket: "ticket-1" }),
    createWebSocket: (url, protocols) => {
      activeSocket = new MockWebSocket(url, protocols);
      return activeSocket as unknown as WebSocket;
    },
    setTimeoutFn: (cb, delay) => {
      if (delay !== 10_000) {
        retryTimerCallback = cb;
      }
      return 1;
    },
    clearTimeoutFn: () => {},
    randomJitterFn: () => 0,
    callbacks: {
      onConnectedChange: () => {},
      onError: () => {},
      onReconnectExhausted: (sid) => {
        exhaustedSessionId = sid;
      },
      writeTerminal: async () => {},
      resetTerminal: () => {},
      resizeTerminal: () => {}
    }
  });

  await session.connect();

  for (let i = 1; i <= 6; i++) {
    activeSocket!.emit("open");
    // sync gap triggers close
    activeSocket!.emit("message", {
      data: JSON.stringify({
        type: "sync_start",
        syncId: `sync-${i}`,
        baseSeq: 0,
        cols: 80,
        rows: 24,
        control: "controller"
      })
    });
    // gap
    activeSocket!.emit("message", {
      data: JSON.stringify({
        type: "output",
        seq: 5,
        data: "gap"
      })
    });

    if (i <= 5) {
      assert.equal(session.reconnectManager.getAttempt(), i);
      assert.equal(session.stopped, false);
      assert.ok(retryTimerCallback);
      const nextCb = retryTimerCallback;
      retryTimerCallback = undefined;
      await nextCb();
    }
  }

  // After 5 retries have run and failed, manager stops
  assert.equal(session.stopped, true);
  assert.equal(session.reconnectManager.isStopped(), true);
  assert.equal(exhaustedSessionId, "sess-exhaust");
});

test("RP4: close 4004 stops retry immediately with onSessionMissing", async () => {
  let activeSocket: MockWebSocket | undefined;
  const queue = new XtermOperationQueue();
  let missingSessionId = "";
  let timerScheduled = false;

  const session = new TerminalConnectionSession({
    sessionId: "sess-4004",
    queue,
    createTicket: async () => ({ ticket: "ticket-1" }),
    createWebSocket: (url, protocols) => {
      activeSocket = new MockWebSocket(url, protocols);
      return activeSocket as unknown as WebSocket;
    },
    setTimeoutFn: (_cb, delay) => {
      if (delay !== 10_000) {
        timerScheduled = true;
      }
      return 1;
    },
    clearTimeoutFn: () => {},
    callbacks: {
      onConnectedChange: () => {},
      onError: () => {},
      onSessionMissing: (sid) => {
        missingSessionId = sid;
      },
      writeTerminal: async () => {},
      resetTerminal: () => {},
      resizeTerminal: () => {}
    }
  });

  await session.connect();
  activeSocket!.emit("open");
  activeSocket!.close(4004);

  assert.equal(session.stopped, true);
  assert.equal(session.reconnectManager.isStopped(), true);
  assert.equal(missingSessionId, "sess-4004");
  assert.equal(timerScheduled, false);
});

test("RP5: closed-socket snapshot callback cannot reconnect UI/reset retry", async (t) => {
  let activeSocket: MockWebSocket | undefined;
  const queue = new XtermOperationQueue();
  let connectedState = false;
  let resolveSnapshotWrite: () => void = () => {};
  const snapshotPromise = new Promise<void>((r) => {
    resolveSnapshotWrite = r;
  });

  let retryTimerCallback: (() => void) | undefined;

  const session = new TerminalConnectionSession({
    sessionId: "sess-rp5",
    queue,
    createTicket: async () => ({ ticket: "ticket-1" }),
    createWebSocket: (url, protocols) => {
      activeSocket = new MockWebSocket(url, protocols);
      return activeSocket as unknown as WebSocket;
    },
    setTimeoutFn: (cb) => {
      retryTimerCallback = cb;
      return 1;
    },
    clearTimeoutFn: () => {},
    randomJitterFn: () => 0,
    callbacks: {
      onConnectedChange: (conn) => {
        connectedState = conn;
      },
      onError: () => {},
      writeTerminal: async (data) => {
        if (data === "snapshot-rp5") {
          await snapshotPromise;
        }
      },
      resetTerminal: () => {},
      resizeTerminal: () => {}
    }
  });

  t.after(() => session.dispose());
  await session.connect();
  activeSocket!.emit("open");

  // Send snapshot
  activeSocket!.emit("message", {
    data: JSON.stringify({
      type: "sync_start",
      syncId: "sync-rp5",
      baseSeq: 0,
      cols: 80,
      rows: 24,
      control: "controller"
    })
  });
  activeSocket!.emit("message", {
    data: JSON.stringify({
      type: "snapshot_chunk",
      syncId: "sync-rp5",
      index: 0,
      data: "snapshot-rp5"
    })
  });
  activeSocket!.emit("message", {
    data: JSON.stringify({
      type: "sync_end",
      syncId: "sync-rp5",
      baseSeq: 0,
      chunkCount: 1
    })
  });

  // Socket closes with 1006 while snapshot write is still pending
  activeSocket!.close(1006);

  assert.equal(session.reconnectManager.getAttempt(), 1);
  assert.equal(session.connected, false);
  assert.equal(connectedState, false);

  // Now snapshot finishes while waiting for retry timer
  resolveSnapshotWrite();
  await queue.barrier();

  // Late completion MUST NOT report connected, MUST NOT reset attempt
  assert.equal(session.connected, false);
  assert.equal(connectedState, false);
  assert.equal(session.reconnectManager.getAttempt(), 1);
  assert.ok(retryTimerCallback);

  // Now execute retry timer -> starts attempt 2
  await retryTimerCallback!();
  assert.ok(activeSocket);
  activeSocket!.emit("open");

  // Attempt 2 sync succeeds
  activeSocket!.emit("message", {
    data: JSON.stringify({
      type: "sync_start",
      syncId: "sync-rp5-2",
      baseSeq: 0,
      cols: 80,
      rows: 24,
      control: "controller"
    })
  });
  activeSocket!.emit("message", {
    data: JSON.stringify({
      type: "sync_end",
      syncId: "sync-rp5-2",
      baseSeq: 0,
      chunkCount: 0
    })
  });
  await queue.barrier();

  // Only the new healthy attempt resets the counter and marks connected
  assert.equal(session.reconnectManager.getAttempt(), 0);
  assert.equal(session.connected, true);
  assert.equal(connectedState, true);
});

test("RP6: gap invalidates old attempt, late callbacks cannot affect new socket", async (t) => {
  let socket1: MockWebSocket | undefined;
  let socket2: MockWebSocket | undefined;
  let socketCount = 0;
  const queue = new XtermOperationQueue();
  const writtenData: string[] = [];

  let resolveWrite1: () => void = () => {};
  const write1Promise = new Promise<void>((r) => {
    resolveWrite1 = r;
  });

  let retryTimerCallback: (() => void) | undefined;

  const session = new TerminalConnectionSession({
    sessionId: "sess-rp6",
    queue,
    createTicket: async () => ({ ticket: "ticket-1" }),
    createWebSocket: (url, protocols) => {
      socketCount += 1;
      const sock = new MockWebSocket(url, protocols);
      if (socketCount === 1) socket1 = sock;
      else socket2 = sock;
      return sock as unknown as WebSocket;
    },
    setTimeoutFn: (cb) => {
      retryTimerCallback = cb;
      return 1;
    },
    clearTimeoutFn: () => {},
    randomJitterFn: () => 0,
    callbacks: {
      onConnectedChange: () => {},
      onError: () => {},
      writeTerminal: async (data) => {
        if (data === "chunk-old") {
          await write1Promise;
          writtenData.push("old-write-done");
        } else {
          writtenData.push(data);
        }
      },
      resetTerminal: () => {
        writtenData.push("reset");
      },
      resizeTerminal: () => {}
    }
  });

  t.after(() => session.dispose());
  await session.connect();
  assert.ok(socket1);
  socket1!.emit("open");

  // Attempt 1: snapshot pending
  socket1!.emit("message", {
    data: JSON.stringify({
      type: "sync_start",
      syncId: "sync-1",
      baseSeq: 0,
      cols: 80,
      rows: 24,
      control: "controller"
    })
  });
  socket1!.emit("message", {
    data: JSON.stringify({
      type: "snapshot_chunk",
      syncId: "sync-1",
      index: 0,
      data: "chunk-old"
    })
  });
  socket1!.emit("message", {
    data: JSON.stringify({
      type: "sync_end",
      syncId: "sync-1",
      baseSeq: 0,
      chunkCount: 1
    })
  });

  // Gap occurs on socket 1
  socket1!.emit("message", {
    data: JSON.stringify({
      type: "output",
      seq: 5,
      data: "gap"
    })
  });

  // Socket 1 closed, exactly 1 retry scheduled
  assert.equal(session.reconnectManager.getAttempt(), 1);
  assert.ok(retryTimerCallback);

  // New attempt started via retry timer
  await retryTimerCallback!();
  assert.ok(socket2);
  socket2!.emit("open");

  // Late events from old socket1 MUST NOT affect socket2!
  socket1!.emit("message", {
    data: JSON.stringify({
      type: "exit",
      exitCode: 123
    })
  });
  socket1!.emit("close", { code: 1006 });
  assert.equal(socket2!.readyState, 1); // Still open!
  assert.equal(session.reconnectManager.getAttempt(), 1); // Not incremented!

  // Now resolve old write
  resolveWrite1();
  await queue.barrier();

  // Attempt 2 sync completes normally
  socket2!.emit("message", {
    data: JSON.stringify({
      type: "sync_start",
      syncId: "sync-2",
      baseSeq: 0,
      cols: 80,
      rows: 24,
      control: "controller"
    })
  });
  socket2!.emit("message", {
    data: JSON.stringify({
      type: "sync_end",
      syncId: "sync-2",
      baseSeq: 0,
      chunkCount: 0
    })
  });
  await queue.barrier();

  assert.equal(session.reconnectManager.getAttempt(), 0);
  assert.equal(session.connected, true);
});

test("RP7: same-session reconnect waits for old xterm write before new reset", async () => {
  const queue = new XtermOperationQueue();
  const sockets: MockWebSocket[] = [];
  const events: string[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let retry: (() => void) | undefined;
  const session = new TerminalConnectionSession({
    sessionId: "sess-rp7",
    queue,
    createTicket: async () => ({ ticket: "ticket" }),
    createWebSocket: (url, protocols) => {
      const socket = new MockWebSocket(url, protocols);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    setTimeoutFn: (cb, delay) => { if (delay !== 10_000) retry = cb; return 1; },
    clearTimeoutFn: () => {},
    randomJitterFn: () => 0,
    callbacks: {
      onConnectedChange: () => {},
      onError: () => {},
      resetTerminal: () => { events.push("reset"); },
      resizeTerminal: () => { events.push("resize"); },
      writeTerminal: async (data) => {
        if (data === "old") {
          events.push("old-start");
          started.resolve();
          await release.promise;
          events.push("old-end");
        } else events.push(data);
      }
    }
  });
  const emit = (socket: MockWebSocket, message: object) => socket.emit("message", { data: JSON.stringify(message) });
  const syncStart = (syncId: string) => ({ type: "sync_start", syncId, baseSeq: 0, cols: 80, rows: 24, control: "controller" });
  try {
    await session.connect();
    const first = sockets[0];
    first.emit("open");
    emit(first, syncStart("old-sync"));
    emit(first, { type: "snapshot_chunk", syncId: "old-sync", index: 0, data: "old" });
    await started.promise;
    emit(first, { type: "sync_end", syncId: "old-sync", baseSeq: 0, chunkCount: 1 });
    emit(first, { type: "output", seq: 5, data: "gap" });
    assert.equal(session.reconnectManager.getAttempt(), 1);
    assert.ok(retry);
    await retry();
    const second = sockets[1];
    second.emit("open");
    emit(second, syncStart("new-sync"));
    assert.deepEqual(events, ["reset", "resize", "old-start"], "second reset cannot run while old write is pending");
    emit(second, { type: "snapshot_chunk", syncId: "new-sync", index: 0, data: "new-write" });
    emit(second, { type: "sync_end", syncId: "new-sync", baseSeq: 0, chunkCount: 1 });
    assert.equal(session.connected, false);
    assert.equal(session.reconnectManager.getAttempt(), 1);
    first.emit("close", { code: 1006 });
    emit(first, { type: "exit", exitCode: 123 });
    assert.equal(second.readyState, 1);
    release.resolve();
    await queue.barrier();
    assert.deepEqual(events, ["reset", "resize", "old-start", "old-end", "reset", "resize", "new-write"]);
    assert.equal(session.connected, true);
    assert.equal(session.reconnectManager.getAttempt(), 0);
  } finally {
    release.resolve();
    session.dispose();
    await queue.barrier();
  }
});
