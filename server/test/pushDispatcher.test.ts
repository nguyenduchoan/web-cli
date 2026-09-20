import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PushStore } from "../src/pushStore.js";
import { PushDispatcher, type PushMessage, type PushSender } from "../src/pushDispatcher.js";

class FakeSender implements PushSender {
  public sentMessages: PushMessage[] = [];
  public failNextWith?: Error;
  public delayMs = 0;

  async send(message: PushMessage): Promise<string> {
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    if (this.failNextWith) {
      const err = this.failNextWith;
      this.failNextWith = undefined;
      throw err;
    }
    this.sentMessages.push(message);
    return `message-${this.sentMessages.length}`;
  }
}

function createTempPushStore(projectId = "test-project"): { store: PushStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-store-test-"));
  const store = new PushStore(dir, projectId);
  return { store, dir };
}

test("PushDispatcher: dispatches test push and enforces 30s rate limit per device", async () => {
  const { store, dir } = createTempPushStore();
  try {
    const sender = new FakeSender();
    const dispatcher = new PushDispatcher({ store, sender });

    const deviceId = crypto.randomUUID();
    const fid = "c" + "1".repeat(21);
    const authScope = "web-scope-1";

    await store.upsertDevice({
      deviceId,
      fid,
      webAuthScope: authScope
    });

    // First test dispatch: OK
    const res1 = await dispatcher.dispatchTest(deviceId, authScope);
    assert.equal(res1.queued, true);
    assert.ok(res1.eventId);

    // Wait a tick for execution
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sender.sentMessages.length, 1);
    assert.equal(sender.sentMessages[0].token, fid);
    assert.equal(sender.sentMessages[0].data.type, "test");

    // Second test dispatch immediately: should throw rate limit (429)
    await assert.rejects(
      async () => dispatcher.dispatchTest(deviceId, authScope),
      (err: any) => err.statusCode === 429 && err.code === "rate_limited"
    );

    await dispatcher.shutdown(100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PushDispatcher: rejects test push for non-existent device or wrong auth scope", async () => {
  const { store, dir } = createTempPushStore();
  try {
    const sender = new FakeSender();
    const dispatcher = new PushDispatcher({ store, sender });

    const deviceId = crypto.randomUUID();
    const fid = "d" + "2".repeat(21);

    await store.upsertDevice({
      deviceId,
      fid,
      webAuthScope: "scope-A"
    });

    // Wrong scope: throws 404
    await assert.rejects(
      async () => dispatcher.dispatchTest(deviceId, "scope-B"),
      (err: any) => err.statusCode === 404
    );

    // Unknown deviceId: throws 404
    await assert.rejects(
      async () => dispatcher.dispatchTest(crypto.randomUUID(), "scope-A"),
      (err: any) => err.statusCode === 404
    );

    await dispatcher.shutdown(100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PushDispatcher: cleans up stale device when sender returns invalid-token error", async () => {
  const { store, dir } = createTempPushStore();
  try {
    const sender = new FakeSender();
    sender.failNextWith = new Error("registration-token-not-registered");
    const dispatcher = new PushDispatcher({ store, sender });

    const deviceId = crypto.randomUUID();
    const fid = "e" + "3".repeat(21);
    const authScope = "scope-cleanup";

    await store.upsertDevice({
      deviceId,
      fid,
      webAuthScope: authScope
    });

    assert.ok(store.getDevice(deviceId));

    await dispatcher.dispatchTest(deviceId, authScope);

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 60));

    // Device should have been removed from store
    assert.equal(store.getDevice(deviceId), undefined);

    const counters = dispatcher.getCounters();
    assert.equal(counters.failed, 1);

    await dispatcher.shutdown(100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PushDispatcher: bounded queue drops new jobs when queue exceeds 128", async () => {
  const { store, dir } = createTempPushStore();
  try {
    const sender = new FakeSender();
    // Simulate slow sender to let queue fill up
    sender.delayMs = 200;
    const dispatcher = new PushDispatcher({ store, sender });

    // Register 1 device
    const deviceId = crypto.randomUUID();
    const fid = "f" + "4".repeat(21);
    await store.upsertDevice({
      deviceId,
      fid,
      webAuthScope: "scope"
    });

    // Fill queue by dispatching attention events
    for (let i = 0; i < 150; i++) {
      dispatcher.dispatchAttention({
        type: "attention",
        eventId: `event-${i}`,
        sessionId: `session-${i}`,
        createdAt: new Date().toISOString()
      });
    }

    const counters = dispatcher.getCounters();
    assert.ok(counters.dropped > 0, "Expected some jobs to be dropped when exceeding 128");

    await dispatcher.shutdown(500);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
