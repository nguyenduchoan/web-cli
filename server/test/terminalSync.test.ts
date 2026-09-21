import assert from "node:assert/strict";
import test from "node:test";
import { TerminalSyncController } from "../../web/src/lib/terminalSync.js";

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
