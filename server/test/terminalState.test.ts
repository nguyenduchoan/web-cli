import assert from "node:assert/strict";
import test from "node:test";
import { TerminalState, chunkUnicodeString } from "../src/terminalState.js";

test("chunkUnicodeString splits multi-byte UTF-8 without breaking characters", () => {
  const text = "Chào bạn! Đây là bài kiểm tra tiếng Việt có dấu. Unicode emoji: 🚀🔥";
  const chunks = chunkUnicodeString(text, 10);
  assert.equal(chunks.join(""), text);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, "utf8") <= 10);
  }
});

test("W01: serial queue executes writes and resizes in strict sequence advancing seq", async () => {
  const state = new TerminalState(80, 24);

  const p1 = state.enqueueWrite("Line 1\r\n");
  const p2 = state.enqueueResize(100, 30);
  const p3 = state.enqueueWrite("Line 2\r\n");

  const [s1, s2, s3] = await Promise.all([p1, p2, p3]);

  assert.equal(s1, 1);
  assert.equal(s2, 2);
  assert.equal(s3, 3);
  assert.equal(state.currentSeq, 3);
  assert.deepEqual(state.dimensions, { cols: 100, rows: 30 });

  state.dispose();
});

test("W01: snapshot barrier waits for prior writes and captures exact baseSeq", async () => {
  const state = new TerminalState(80, 24);

  state.enqueueWrite("First Line\r\n");
  state.enqueueWrite("Second Line\r\n");

  const snapshot = await state.createSnapshotBarrier();
  assert.equal(snapshot.baseSeq, 2);
  assert.match(snapshot.data, /First Line/);
  assert.match(snapshot.data, /Second Line/);

  // Writes after barrier advance seq beyond snapshot baseSeq
  const nextSeq = await state.enqueueWrite("Third Line\r\n");
  assert.equal(nextSeq, 3);
  assert.equal(snapshot.baseSeq, 2);

  state.dispose();
});

test("W03: alternate screen buffer and ANSI modes are captured in snapshot", async () => {
  const state = new TerminalState(80, 24);

  // Switch to alternate buffer and write text
  await state.enqueueWrite("\x1b[?1049h\x1b[31mRed in Alt\x1b[0m\r\n");

  const snapshot = await state.createSnapshotBarrier();
  assert.match(snapshot.data, /Red in Alt/);

  state.dispose();
});

test("finalizeOnExit disposes headless instance while preserving final snapshot", async () => {
  const state = new TerminalState(80, 24);
  await state.enqueueWrite("Output before exit\r\n");

  const finalSnapshot = await state.finalizeOnExit();
  assert.equal(finalSnapshot.baseSeq, 1);
  assert.match(finalSnapshot.data, /Output before exit/);

  // Second call returns cached final snapshot
  const cached = await state.finalizeOnExit();
  assert.equal(cached, finalSnapshot);

  // Enqueue write after exit rejects
  await assert.rejects(() => state.enqueueWrite("new write"));
});
