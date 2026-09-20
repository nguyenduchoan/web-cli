import test from "node:test";
import assert from "node:assert/strict";
import { AttentionDetector, type AttentionEvent } from "../src/attention.js";

test("AttentionDetector: parses standard OSC 9 with BEL terminator", () => {
  const events: AttentionEvent[] = [];
  const detector = new AttentionDetector("session-1", (evt) => events.push(evt));

  detector.feed(Buffer.from("some initial output\x1b]9;approval-requested\x07trailing output"));

  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, "session-1");
  assert.ok(events[0].eventId);
  assert.ok(events[0].createdAt);
});

test("AttentionDetector: parses standard OSC 9 with ST (ESC \\) terminator", () => {
  const events: AttentionEvent[] = [];
  const detector = new AttentionDetector("session-2", (evt) => events.push(evt));

  detector.feed(Buffer.from("\x1b]9;plan-mode-prompt\x1b\\"));

  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, "session-2");
});

test("AttentionDetector: handles chunk boundary split across escape sequence", () => {
  const events: AttentionEvent[] = [];
  const detector = new AttentionDetector("session-3", (evt) => events.push(evt));

  detector.feed(Buffer.from("hello "));
  detector.feed(Buffer.from("\x1b]9;ap"));
  detector.feed(Buffer.from("proval-req"));
  detector.feed(Buffer.from("uested\x07world"));

  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, "session-3");
});

test("AttentionDetector: handles ST split across chunks (ESC then \\)", () => {
  const events: AttentionEvent[] = [];
  const detector = new AttentionDetector("session-4", (evt) => events.push(evt));

  detector.feed(Buffer.from("\x1b]9;approval-requested\x1b"));
  detector.feed(Buffer.from("\\"));

  assert.equal(events.length, 1);
});

test("AttentionDetector: enforces 2-second cooldown per session", async () => {
  const events: AttentionEvent[] = [];
  const detector = new AttentionDetector("session-cooldown", (evt) => events.push(evt));

  detector.feed(Buffer.from("\x1b]9;first\x07"));
  detector.feed(Buffer.from("\x1b]9;second\x07")); // Ignored within 2s

  assert.equal(events.length, 1);

  // Wait 2100ms
  await new Promise((r) => setTimeout(r, 2100));

  detector.feed(Buffer.from("\x1b]9;third\x07"));
  assert.equal(events.length, 2);
});

test("AttentionDetector: overflow guard ignores payload exceeding 4096 bytes", () => {
  const events: AttentionEvent[] = [];
  const detector = new AttentionDetector("session-overflow", (evt) => events.push(evt));

  const hugePayload = "A".repeat(5000);
  detector.feed(Buffer.from(`\x1b]9;${hugePayload}\x07`));

  assert.equal(events.length, 0);

  // Next valid sequence should be parsed normally
  detector.feed(Buffer.from("\x1b]9;valid-after-overflow\x07"));
  assert.equal(events.length, 1);
});

test("AttentionDetector: ignores other OSC codes, malformed sequences and plain text", () => {
  const events: AttentionEvent[] = [];
  const detector = new AttentionDetector("session-noise", (evt) => events.push(evt));

  detector.feed(Buffer.from("regular terminal text\r\n"));
  detector.feed(Buffer.from("\x1b]0;Window Title\x07")); // OSC 0
  detector.feed(Buffer.from("\x1b]7;file://path\x07")); // OSC 7
  detector.feed(Buffer.from("\x1b[31mRed text\x1b[0m")); // SGR
  detector.feed(Buffer.from("\x1b]999;unknown\x07"));

  assert.equal(events.length, 0);
});
