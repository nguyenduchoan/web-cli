import assert from "node:assert/strict";
import test from "node:test";
import { TerminalSyncController } from "../../web/src/lib/terminalSync.js";
import { XtermOperationQueue } from "../../web/src/lib/xtermOperationQueue.js";

test("T2.1: Controller snapshot geometry restores server cols/rows before viewport fit", () => {
  let terminalCols = 80;
  let terminalRows = 24;
  let resetCount = 0;

  const controller = new TerminalSyncController({
    sessionId: "sess-1",
    generation: 1,
    writeTerminal: async () => {},
    resetTerminal: () => {
      resetCount += 1;
    },
    resizeTerminal: (cols, rows) => {
      terminalCols = cols;
      terminalRows = rows;
    },
    onSyncComplete: () => {},
    onMismatchOrGap: () => {}
  });

  // Server snapshot has 100x30 geometry, client has 80x24
  controller.handleSyncStart({
    syncId: "sync-1",
    baseSeq: 10,
    cols: 100,
    rows: 30,
    control: "controller"
  });

  assert.equal(resetCount, 1);
  assert.equal(terminalCols, 100);
  assert.equal(terminalRows, 30);
  assert.equal(controller.role, "controller");
  assert.equal(controller.syncComplete, false);
});

test("T2.2: Input not enabled early; syncComplete only true after pending writes complete", async () => {
  let writeFinished = false;
  let syncCompleted = false;

  const controller = new TerminalSyncController({
    sessionId: "sess-1",
    generation: 1,
    writeTerminal: async () => {
      await new Promise((r) => setTimeout(r, 30));
      writeFinished = true;
    },
    resetTerminal: () => {},
    resizeTerminal: () => {},
    onSyncComplete: () => {
      syncCompleted = true;
    },
    onMismatchOrGap: () => {}
  });

  controller.handleSyncStart({
    syncId: "sync-1",
    baseSeq: 0,
    cols: 80,
    rows: 24,
    control: "controller"
  });

  controller.handleSnapshotChunk({
    syncId: "sync-1",
    index: 0,
    data: "chunk data"
  });

  // sync_end is received while chunk write is still pending
  const syncEndPromise = controller.handleSyncEnd({
    syncId: "sync-1",
    baseSeq: 0,
    chunkCount: 1
  });

  // Immediately after receiving sync_end, write is NOT finished and sync is NOT complete
  assert.equal(writeFinished, false);
  assert.equal(syncCompleted, false);
  assert.equal(controller.syncComplete, false);

  // Await the syncEnd processing
  const success = await syncEndPromise;
  assert.equal(success, true);
  assert.equal(writeFinished, true);
  assert.equal(syncCompleted, true);
  assert.equal(controller.syncComplete, true);
  assert.equal(controller.expectedSeq, 1);
});

test("T2.3: Chunk gap triggers onMismatchOrGap and rejects sync", () => {
  let mismatchReason = "";

  const controller = new TerminalSyncController({
    sessionId: "sess-1",
    generation: 1,
    writeTerminal: async () => {},
    resetTerminal: () => {},
    resizeTerminal: () => {},
    onSyncComplete: () => {},
    onMismatchOrGap: (reason) => {
      mismatchReason = reason;
    }
  });

  controller.handleSyncStart({
    syncId: "sync-1",
    baseSeq: 0,
    cols: 80,
    rows: 24,
    control: "viewer"
  });

  // Send chunk 0 (ok)
  const ok0 = controller.handleSnapshotChunk({
    syncId: "sync-1",
    index: 0,
    data: "chunk 0"
  });
  assert.equal(ok0, true);

  // Send chunk 2 (gap: expected 1)
  const ok2 = controller.handleSnapshotChunk({
    syncId: "sync-1",
    index: 2,
    data: "chunk 2"
  });
  assert.equal(ok2, false);
  assert.match(mismatchReason, /snapshot_chunk_index_mismatch/);
  assert.equal(controller.syncComplete, false);
});

test("T2.4: Chunk count mismatch on sync_end triggers onMismatchOrGap", async () => {
  let mismatchReason = "";

  const controller = new TerminalSyncController({
    sessionId: "sess-1",
    generation: 1,
    writeTerminal: async () => {},
    resetTerminal: () => {},
    resizeTerminal: () => {},
    onSyncComplete: () => {},
    onMismatchOrGap: (reason) => {
      mismatchReason = reason;
    }
  });

  controller.handleSyncStart({
    syncId: "sync-1",
    baseSeq: 0,
    cols: 80,
    rows: 24,
    control: "viewer"
  });

  controller.handleSnapshotChunk({
    syncId: "sync-1",
    index: 0,
    data: "chunk 0"
  });

  // sync_end says chunkCount: 2, but only 1 chunk was sent
  const result = await controller.handleSyncEnd({
    syncId: "sync-1",
    baseSeq: 0,
    chunkCount: 2
  });

  assert.equal(result, false);
  assert.match(mismatchReason, /snapshot_chunk_count_mismatch/);
  assert.equal(controller.syncComplete, false);
});

test("T2.5: Session switch late write does not overwrite session B or mark it complete", async () => {
  const writtenData: string[] = [];
  let syncBCompleted = false;

  const controllerA = new TerminalSyncController({
    sessionId: "sess-A",
    generation: 1,
    writeTerminal: async (data) => {
      await new Promise((r) => setTimeout(r, 40));
      writtenData.push(data);
    },
    resetTerminal: () => {},
    resizeTerminal: () => {},
    onSyncComplete: () => {},
    onMismatchOrGap: () => {}
  });

  controllerA.handleSyncStart({
    syncId: "sync-A",
    baseSeq: 0,
    cols: 80,
    rows: 24,
    control: "controller"
  });

  controllerA.handleSnapshotChunk({
    syncId: "sync-A",
    index: 0,
    data: "chunk from A"
  });

  // User switches to session B before A's write finishes
  controllerA.invalidate();

  const controllerB = new TerminalSyncController({
    sessionId: "sess-B",
    generation: 2,
    writeTerminal: async (data) => {
      writtenData.push(data);
    },
    resetTerminal: () => {},
    resizeTerminal: () => {},
    onSyncComplete: () => {
      syncBCompleted = true;
    },
    onMismatchOrGap: () => {}
  });

  controllerB.handleSyncStart({
    syncId: "sync-B",
    baseSeq: 0,
    cols: 80,
    rows: 24,
    control: "controller"
  });

  // Wait for A's slow write to elapse
  await new Promise((r) => setTimeout(r, 60));

  // Chunk from A was suppressed because generation was invalidated
  assert.deepEqual(writtenData, []);
  assert.equal(syncBCompleted, false);
});

test("T2.6: Output seq gap triggers onMismatchOrGap; duplicate is ignored", async () => {
  let gapReason = "";
  const written: string[] = [];

  const controller = new TerminalSyncController({
    sessionId: "sess-1",
    generation: 1,
    writeTerminal: async (data) => {
      written.push(data);
    },
    resetTerminal: () => {},
    resizeTerminal: () => {},
    onSyncComplete: () => {},
    onMismatchOrGap: (reason) => {
      gapReason = reason;
    }
  });

  controller.handleSyncStart({
    syncId: "sync-1",
    baseSeq: 5,
    cols: 80,
    rows: 24,
    control: "controller"
  });

  // Complete sync
  await controller.handleSyncEnd({
    syncId: "sync-1",
    baseSeq: 5,
    chunkCount: 0
  });

  // Expected seq is baseSeq + 1 = 6
  assert.equal(controller.expectedSeq, 6);

  // Duplicate (seq 5 <= 5): ignored
  const okDup = controller.handleOutput({ seq: 5, data: "dup" });
  assert.equal(okDup, true);

  // Gap (seq 7 != 6): gap error
  const okGap = controller.handleOutput({ seq: 7, data: "gap" });
  assert.equal(okGap, false);
  assert.match(gapReason, /output_seq_gap/);
});

test("XQ1: old write already started -> new reset waits", async () => {
  const ops: string[] = [];
  const queue = new XtermOperationQueue();

  let resolveWriteA: () => void = () => {};
  const writeAPromise = new Promise<void>((r) => {
    resolveWriteA = r;
  });

  // Session A controller
  const genA = queue.getGeneration();
  const controllerA = new TerminalSyncController({
    sessionId: "sess-A",
    generation: genA,
    queue,
    writeTerminal: async (data) => {
      ops.push("A-write-start");
      await writeAPromise;
      ops.push("A-write-end");
    },
    resetTerminal: () => ops.push("A-reset"),
    resizeTerminal: () => ops.push("A-resize"),
    onSyncComplete: () => ops.push("A-sync-complete"),
    onMismatchOrGap: () => {}
  });

  controllerA.handleSyncStart({
    syncId: "sync-A",
    baseSeq: 0,
    cols: 80,
    rows: 24,
    control: "controller"
  });

  controllerA.handleSnapshotChunk({
    syncId: "sync-A",
    index: 0,
    data: "chunk-A"
  });

  // Allow microtask to run so A-write-start is logged and writeTerminal is pending
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ops.includes("A-write-start"), true);
  assert.equal(ops.includes("A-write-end"), false);

  // User switches to session B
  // Switch flow:
  // 1. Invalidate old controller
  controllerA.invalidate();
  // 2. Mark old queue generation stale
  const genB = queue.invalidate();
  // 3. Await global write barrier
  const switchPromise = (async () => {
    await queue.barrier();
    // 4. Only after barrier drains: create and attach B
    const controllerB = new TerminalSyncController({
      sessionId: "sess-B",
      generation: genB,
      queue,
      writeTerminal: async (data) => {
        ops.push("B-write");
      },
      resetTerminal: () => ops.push("B-reset"),
      resizeTerminal: () => ops.push("B-resize"),
      onSyncComplete: () => ops.push("B-sync-complete"),
      onMismatchOrGap: () => {}
    });

    controllerB.handleSyncStart({
      syncId: "sync-B",
      baseSeq: 0,
      cols: 80,
      rows: 24,
      control: "controller"
    });

    controllerB.handleSnapshotChunk({
      syncId: "sync-B",
      index: 0,
      data: "chunk-B"
    });

    await queue.barrier();
  })();

  // While writeAPromise is pending, B-reset has NOT run yet!
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ops.includes("B-reset"), false);

  // Now resolve write A
  resolveWriteA();
  await switchPromise;

  assert.deepEqual(ops, [
    "A-reset",
    "A-resize",
    "A-write-start",
    "A-write-end",
    "B-reset",
    "B-resize",
    "B-write"
  ]);
});

test("XQ2: rapid A/B/A no xterm contamination", async () => {
  const ops: string[] = [];
  const queue = new XtermOperationQueue();

  let resolveWriteA1: () => void = () => {};
  const writeA1Promise = new Promise<void>((r) => {
    resolveWriteA1 = r;
  });

  const genA1 = queue.getGeneration();
  const ctrlA1 = new TerminalSyncController({
    sessionId: "sess-A",
    generation: genA1,
    queue,
    writeTerminal: async (data) => {
      ops.push(`A1-write-start:${data}`);
      await writeA1Promise;
      ops.push(`A1-write-end:${data}`);
    },
    resetTerminal: () => ops.push("A1-reset"),
    resizeTerminal: () => {},
    onSyncComplete: () => {},
    onMismatchOrGap: () => {}
  });

  ctrlA1.handleSyncStart({ syncId: "sync-A1", baseSeq: 0, cols: 80, rows: 24, control: "controller" });
  ctrlA1.handleSnapshotChunk({ syncId: "sync-A1", index: 0, data: "data-A1" });
  await new Promise((r) => setTimeout(r, 5));

  // Rapid switch to B
  ctrlA1.invalidate();
  const genB = queue.invalidate();
  const ctrlB = new TerminalSyncController({
    sessionId: "sess-B",
    generation: genB,
    queue,
    writeTerminal: async (data) => ops.push(`B-write:${data}`),
    resetTerminal: () => ops.push("B-reset"),
    resizeTerminal: () => {},
    onSyncComplete: () => {},
    onMismatchOrGap: () => {}
  });
  // Rapid switch back to A again immediately before B even drains
  ctrlB.invalidate();
  const genA2 = queue.invalidate();

  resolveWriteA1();
  await queue.barrier();

  // Now A2 runs
  const ctrlA2 = new TerminalSyncController({
    sessionId: "sess-A",
    generation: genA2,
    queue,
    writeTerminal: async (data) => ops.push(`A2-write:${data}`),
    resetTerminal: () => ops.push("A2-reset"),
    resizeTerminal: () => {},
    onSyncComplete: () => {},
    onMismatchOrGap: () => {}
  });
  ctrlA2.handleSyncStart({ syncId: "sync-A2", baseSeq: 0, cols: 80, rows: 24, control: "controller" });
  ctrlA2.handleSnapshotChunk({ syncId: "sync-A2", index: 0, data: "data-A2" });
  await queue.barrier();

  // B was completely skipped because genB was invalidated before running
  assert.equal(ops.some((op) => op.startsWith("B-")), false);
  assert.equal(ops.includes("A2-write:data-A2"), true);
});

test("XQ3: reconnect same session generation barrier", async () => {
  const ops: string[] = [];
  const queue = new XtermOperationQueue();

  let resolveOldWrite: () => void = () => {};
  const oldWritePromise = new Promise<void>((r) => {
    resolveOldWrite = r;
  });

  const gen1 = queue.getGeneration();
  const ctrl1 = new TerminalSyncController({
    sessionId: "sess-1",
    generation: gen1,
    queue,
    writeTerminal: async (data) => {
      ops.push("old-write-start");
      await oldWritePromise;
      ops.push("old-write-end");
    },
    resetTerminal: () => ops.push("old-reset"),
    resizeTerminal: () => {},
    onSyncComplete: () => {},
    onMismatchOrGap: () => {}
  });

  ctrl1.handleSyncStart({ syncId: "sync-1", baseSeq: 0, cols: 80, rows: 24, control: "controller" });
  ctrl1.handleSnapshotChunk({ syncId: "sync-1", index: 0, data: "chunk-1" });
  await new Promise((r) => setTimeout(r, 5));

  // Reconnect for same session
  ctrl1.invalidate();
  const gen2 = queue.invalidate();

  let newStarted = false;
  const reconnectPromise = (async () => {
    await queue.barrier();
    newStarted = true;
    const ctrl2 = new TerminalSyncController({
      sessionId: "sess-1",
      generation: gen2,
      queue,
      writeTerminal: async () => ops.push("new-write"),
      resetTerminal: () => ops.push("new-reset"),
      resizeTerminal: () => {},
      onSyncComplete: () => {},
      onMismatchOrGap: () => {}
    });
    ctrl2.handleSyncStart({ syncId: "sync-2", baseSeq: 0, cols: 80, rows: 24, control: "controller" });
    ctrl2.handleSnapshotChunk({ syncId: "sync-2", index: 0, data: "chunk-2" });
    await queue.barrier();
  })();

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(newStarted, false);
  assert.equal(ops.includes("new-reset"), false);

  resolveOldWrite();
  await reconnectPromise;

  assert.equal(newStarted, true);
  assert.deepEqual(ops, [
    "old-reset",
    "old-write-start",
    "old-write-end",
    "new-reset",
    "new-write"
  ]);
});

test("OR1: output before resize ordering", async () => {
  const ops: string[] = [];
  const queue = new XtermOperationQueue();
  let resolveOutput10: () => void = () => {};
  const output10Promise = new Promise<void>((r) => {
    resolveOutput10 = r;
  });

  const controller = new TerminalSyncController({
    sessionId: "sess-1",
    generation: queue.getGeneration(),
    queue,
    writeTerminal: async (data) => {
      ops.push(`write:${data}:start`);
      await output10Promise;
      ops.push(`write:${data}:end`);
    },
    resetTerminal: () => {},
    resizeTerminal: (cols, rows) => {
      ops.push(`resize:${cols}x${rows}`);
    },
    onSyncComplete: () => {},
    onMismatchOrGap: () => {}
  });

  controller.handleSyncStart({ syncId: "sync-1", baseSeq: 9, cols: 80, rows: 24, control: "viewer" });
  await controller.handleSyncEnd({ syncId: "sync-1", baseSeq: 9, chunkCount: 0 });
  ops.length = 0;

  controller.handleOutput({ seq: 10, data: "out10" });
  controller.handleTerminalResize({ seq: 11, cols: 100, rows: 30 });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ops.includes("write:out10:start"), true);
  assert.equal(ops.includes("resize:100x30"), false);

  resolveOutput10();
  await queue.barrier();

  assert.deepEqual(ops, [
    "write:out10:start",
    "write:out10:end",
    "resize:100x30"
  ]);
});

test("OR2: output/resize/output ordering", async () => {
  const ops: string[] = [];
  const queue = new XtermOperationQueue();

  const controller = new TerminalSyncController({
    sessionId: "sess-1",
    generation: queue.getGeneration(),
    queue,
    writeTerminal: async (data) => {
      ops.push(`write:${data}:start`);
      await new Promise((r) => setTimeout(r, 10));
      ops.push(`write:${data}:end`);
    },
    resetTerminal: () => {},
    resizeTerminal: (cols, rows) => {
      ops.push(`resize:${cols}x${rows}`);
    },
    onSyncComplete: () => {},
    onMismatchOrGap: () => {}
  });

  controller.handleSyncStart({ syncId: "sync-1", baseSeq: 9, cols: 80, rows: 24, control: "viewer" });
  await controller.handleSyncEnd({ syncId: "sync-1", baseSeq: 9, chunkCount: 0 });
  ops.length = 0;

  controller.handleOutput({ seq: 10, data: "10" });
  controller.handleTerminalResize({ seq: 11, cols: 90, rows: 25 });
  controller.handleOutput({ seq: 12, data: "12" });

  await queue.barrier();

  assert.deepEqual(ops, [
    "write:10:start",
    "write:10:end",
    "resize:90x25",
    "write:12:start",
    "write:12:end"
  ]);
});

test("OR3: duplicate resize ignored", async () => {
  let resizeCount = 0;
  const queue = new XtermOperationQueue();

  const controller = new TerminalSyncController({
    sessionId: "sess-1",
    generation: queue.getGeneration(),
    queue,
    writeTerminal: async () => {},
    resetTerminal: () => {},
    resizeTerminal: () => {
      resizeCount += 1;
    },
    onSyncComplete: () => {},
    onMismatchOrGap: () => {}
  });

  controller.handleSyncStart({ syncId: "sync-1", baseSeq: 5, cols: 80, rows: 24, control: "viewer" });
  await controller.handleSyncEnd({ syncId: "sync-1", baseSeq: 5, chunkCount: 0 });
  resizeCount = 0;

  // expectedSeq is 6
  assert.equal(controller.expectedSeq, 6);

  // Duplicate resize (seq 5 < 6)
  const result = controller.handleTerminalResize({ seq: 5, cols: 90, rows: 25 });
  assert.equal(result, true);
  await queue.barrier();
  assert.equal(resizeCount, 0);
  assert.equal(controller.expectedSeq, 6);
});

test("OR4: resize gap triggers onMismatchOrGap and is not enqueued", async () => {
  let gapReason = "";
  let resizeCount = 0;
  const queue = new XtermOperationQueue();

  const controller = new TerminalSyncController({
    sessionId: "sess-1",
    generation: queue.getGeneration(),
    queue,
    writeTerminal: async () => {},
    resetTerminal: () => {},
    resizeTerminal: () => {
      resizeCount += 1;
    },
    onSyncComplete: () => {},
    onMismatchOrGap: (reason) => {
      gapReason = reason;
    }
  });

  controller.handleSyncStart({ syncId: "sync-1", baseSeq: 10, cols: 80, rows: 24, control: "viewer" });
  await controller.handleSyncEnd({ syncId: "sync-1", baseSeq: 10, chunkCount: 0 });
  resizeCount = 0;

  // expected is 11, send 12
  const result = controller.handleTerminalResize({ seq: 12, cols: 90, rows: 25 });
  assert.equal(result, false);
  assert.match(gapReason, /resize_seq_gap/);
  await queue.barrier();
  assert.equal(resizeCount, 0);
});

test("OR5: live output/resize queued while snapshot drains, expectedSeq preserved", async () => {
  const ops: string[] = [];
  const queue = new XtermOperationQueue();
  let resolveSnapshotWrite: () => void = () => {};
  const snapshotPromise = new Promise<void>((r) => {
    resolveSnapshotWrite = r;
  });

  let syncCompleted = false;

  const controller = new TerminalSyncController({
    sessionId: "sess-1",
    generation: queue.getGeneration(),
    queue,
    writeTerminal: async (data) => {
      if (data === "snapshot-data") {
        ops.push("snapshot-start");
        await snapshotPromise;
        ops.push("snapshot-end");
      } else {
        ops.push(`live-write:${data}`);
      }
    },
    resetTerminal: () => {},
    resizeTerminal: (cols, rows) => {
      if (controller.syncEndReceived) {
        ops.push(`live-resize:${cols}x${rows}`);
      }
    },
    onSyncComplete: () => {
      syncCompleted = true;
      ops.push("sync-complete");
    },
    onMismatchOrGap: () => {}
  });

  controller.handleSyncStart({ syncId: "sync-1", baseSeq: 10, cols: 80, rows: 24, control: "viewer" });
  controller.handleSnapshotChunk({ syncId: "sync-1", index: 0, data: "snapshot-data" });

  // sync_end received while snapshot is still writing
  const syncEndPromise = controller.handleSyncEnd({ syncId: "sync-1", baseSeq: 10, chunkCount: 1 });

  // Live messages arrive while snapshot callback is pending
  const okOutput11 = controller.handleOutput({ seq: 11, data: "out11" });
  const okResize12 = controller.handleTerminalResize({ seq: 12, cols: 95, rows: 28 });

  // Both accepted without error
  assert.equal(okOutput11, true);
  assert.equal(okResize12, true);
  assert.equal(controller.expectedSeq, 13);
  assert.equal(syncCompleted, false);
  assert.equal(controller.syncComplete, false);
  assert.equal(ops.includes("live-write:out11"), false);
  assert.equal(ops.includes("live-resize:95x28"), false);

  // Resolve snapshot
  resolveSnapshotWrite();
  await syncEndPromise;
  await queue.barrier();

  assert.equal(syncCompleted, true);
  assert.equal(controller.syncComplete, true);
  assert.equal(controller.expectedSeq, 13);

  // Subsequent live message with seq 13 is accepted
  const okOutput13 = controller.handleOutput({ seq: 13, data: "out13" });
  assert.equal(okOutput13, true);
  await queue.barrier();

  assert.deepEqual(ops, [
    "snapshot-start",
    "snapshot-end",
    "sync-complete",
    "live-write:out11",
    "live-resize:95x28",
    "live-write:out13"
  ]);
});

test("OR6: bounded live backlog during snapshot drain, overflow invalidates attempt", async () => {
  let mismatchReason = "";
  const queue = new XtermOperationQueue();
  let resolveSnapshot: () => void = () => {};
  const snapshotPromise = new Promise<void>((r) => {
    resolveSnapshot = r;
  });

  const controller = new TerminalSyncController({
    sessionId: "sess-1",
    generation: queue.getGeneration(),
    queue,
    maxLiveBacklogBytes: 50, // Small limit for testing overflow
    writeTerminal: async (data) => {
      if (data === "snap") {
        await snapshotPromise;
      }
    },
    resetTerminal: () => {},
    resizeTerminal: () => {},
    onSyncComplete: () => {},
    onMismatchOrGap: (reason) => {
      mismatchReason = reason;
    }
  });

  controller.handleSyncStart({ syncId: "sync-1", baseSeq: 10, cols: 80, rows: 24, control: "viewer" });
  controller.handleSnapshotChunk({ syncId: "sync-1", index: 0, data: "snap" });
  void controller.handleSyncEnd({ syncId: "sync-1", baseSeq: 10, chunkCount: 1 });

  // Send 30 bytes (ok)
  const ok1 = controller.handleOutput({ seq: 11, data: "x".repeat(30) });
  assert.equal(ok1, true);
  assert.equal(mismatchReason, "");

  // Send another 30 bytes (total 60 > 50 -> overflow!)
  const ok2 = controller.handleOutput({ seq: 12, data: "y".repeat(30) });
  assert.equal(ok2, false);
  assert.match(mismatchReason, /live_backlog_overflow/);
  assert.equal(controller.generation, -1);

  // Resolve snapshot - must NOT report sync complete because attempt was invalidated
  resolveSnapshot();
  await queue.barrier();
  assert.equal(controller.syncComplete, false);
});
