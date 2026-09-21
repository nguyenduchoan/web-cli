import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Fastify from "fastify";
import { registerPushRoutes } from "../src/pushRoutes.js";
import { PushStore } from "../src/pushStore.js";
import { PushDispatcher, type PushSender } from "../src/pushDispatcher.js";
import type { AppConfig } from "../src/config.js";

class MockSender implements PushSender {
  async send(): Promise<string> {
    return "ok";
  }
}

function makeMockAuth(authScope: string | null = "test-web-scope") {
  return {
    getAuthScope: () => authScope
  } as any;
}

function makeConfig(fcmEnabled: boolean): AppConfig {
  const base: any = {
    host: "127.0.0.1",
    port: 3001,
    clientOrigins: ["http://localhost:5173"],
    agents: [{ id: "codex", label: "Codex CLI", command: "node", args: [] }],
    projects: [{ id: "proj", label: "Project", path: "/tmp" }],
    outputBufferLimit: 200000,
    wsTicketTtlMs: 60000,
    logTerminalOutput: false,
    maxSessions: 3,
    sessionIdleTtlMs: 3600000,
    sessionRetentionMs: 3600000,
    maxRetainedSessions: 50,
    shutdownTimeoutMs: 15000,
    maxWebsocketConnections: 8,
    maxWsBufferedBytes: 1000000,
    agentEnvAllowlist: []
  };

  if (!fcmEnabled) {
    base.push = {
      enabled: false,
      supportedAgents: ["codex"]
    };
  } else {
    base.push = {
      enabled: true,
      supportedAgents: ["codex"],
      firebaseWebConfig: {
        apiKey: "test-api-key",
        projectId: "test-project-123",
        messagingSenderId: "123456789",
        appId: "1:123456789:web:abcdef"
      },
      vapidPublicKey: "B" + "a".repeat(86),
      serviceAccountFile: "/tmp/fake-sa.json",
      serviceAccountJson: { project_id: "test-project-123" },
      fcmDataDir: "/tmp/push-data"
    };
  }
  return base as AppConfig;
}

test("PushRoutes: GET /api/notifications/config returns disabled when FCM_ENABLED is false", async () => {
  const app = Fastify();
  const config = makeConfig(false);
  const auth = makeMockAuth();

  registerPushRoutes(app, { config, auth });

  const res = await app.inject({
    method: "GET",
    url: "/api/notifications/config"
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.enabled, false);
  assert.deepEqual(body.supportedAgents, ["codex"]);
  assert.equal(body.firebaseConfig, undefined);
  await app.close();
});

test("PushRoutes: mutations return 409 notifications_disabled when FCM is disabled", async () => {
  const app = Fastify();
  const config = makeConfig(false);
  const auth = makeMockAuth();

  registerPushRoutes(app, { config, auth });

  const postDevice = await app.inject({
    method: "POST",
    url: "/api/notifications/devices",
    payload: {
      deviceId: crypto.randomUUID(),
      fid: "c" + "1".repeat(21)
    }
  });
  assert.equal(postDevice.statusCode, 409);
  assert.equal(postDevice.json().code, "notifications_disabled");

  const deleteDevice = await app.inject({
    method: "DELETE",
    url: `/api/notifications/devices/${crypto.randomUUID()}`
  });
  assert.equal(deleteDevice.statusCode, 409);
  assert.equal(deleteDevice.json().code, "notifications_disabled");

  const postTest = await app.inject({
    method: "POST",
    url: "/api/notifications/test",
    payload: {
      deviceId: crypto.randomUUID()
    }
  });
  assert.equal(postTest.statusCode, 409);
  assert.equal(postTest.json().code, "notifications_disabled");

  await app.close();
});

test("PushRoutes: device registration and test notification flow with FCM enabled", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-routes-test-"));
  const app = Fastify();
  const config = makeConfig(true);
  const pushStore = new PushStore(tempDir, "test-project-123");
  const sender = new MockSender();
  const pushDispatcher = new PushDispatcher({ store: pushStore, sender });
  const auth = makeMockAuth("my-session-scope");

  registerPushRoutes(app, { config, auth, pushStore, pushDispatcher });

  try {
    // 1. GET config returns enabled + public keys
    const configRes = await app.inject({
      method: "GET",
      url: "/api/notifications/config"
    });
    assert.equal(configRes.statusCode, 200);
    const configBody = configRes.json();
    assert.equal(configBody.enabled, true);
    assert.equal(configBody.firebaseConfig.projectId, "test-project-123");
    assert.ok(configBody.vapidPublicKey);

    // 2. POST /api/notifications/devices - invalid UUID
    const badUuidRes = await app.inject({
      method: "POST",
      url: "/api/notifications/devices",
      payload: {
        deviceId: "not-a-uuid",
        fid: "c" + "1".repeat(21)
      }
    });
    assert.equal(badUuidRes.statusCode, 400);

    // 3. POST /api/notifications/devices - invalid FID
    const validUuid = crypto.randomUUID();
    const badFidRes = await app.inject({
      method: "POST",
      url: "/api/notifications/devices",
      payload: {
        deviceId: validUuid,
        fid: "a" + "1".repeat(21) // FID must start with c, d, e, or f
      }
    });
    assert.equal(badFidRes.statusCode, 400);

    // 4. POST /api/notifications/devices - valid
    const validFid = "c" + "1".repeat(21);
    const regRes = await app.inject({
      method: "POST",
      url: "/api/notifications/devices",
      payload: {
        deviceId: validUuid,
        fid: validFid
      }
    });
    assert.equal(regRes.statusCode, 200);
    assert.equal(regRes.json().ok, true);
    assert.ok(regRes.json().expiresAt);

    // Verify stored
    const stored = pushStore.getDevice(validUuid);
    assert.ok(stored);
    assert.equal(stored.fid, validFid);

    // 5. POST /api/notifications/test - valid scope
    const testRes = await app.inject({
      method: "POST",
      url: "/api/notifications/test",
      payload: {
        deviceId: validUuid
      }
    });
    assert.equal(testRes.statusCode, 202);
    assert.equal(testRes.json().queued, true);

    // 6. POST /api/notifications/test - immediate repeat returns 429
    const testRepeatRes = await app.inject({
      method: "POST",
      url: "/api/notifications/test",
      payload: {
        deviceId: validUuid
      }
    });
    assert.equal(testRepeatRes.statusCode, 429);

    // 7. DELETE /api/notifications/devices/:deviceId
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/notifications/devices/${validUuid}`
    });
    assert.equal(deleteRes.statusCode, 200);
    assert.equal(deleteRes.json().ok, true);
    assert.equal(pushStore.getDevice(validUuid), undefined);

    // Repeated delete is also idempotent (200)
    const deleteAgain = await app.inject({
      method: "DELETE",
      url: `/api/notifications/devices/${validUuid}`
    });
    assert.equal(deleteAgain.statusCode, 200);

    await pushDispatcher.shutdown(100);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("PushStore: deleteDevice with mismatched authScope keeps device, matching authScope deletes it (Phase 8)", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-store-scope-test-"));
  try {
    const store = new PushStore(tempDir, "test-project-123");
    const deviceId = crypto.randomUUID();
    const fid = "c" + "2".repeat(21);

    await store.upsertDevice({
      deviceId,
      fid,
      webAuthScope: "scope-A"
    });

    assert.ok(store.getDevice(deviceId));

    // Delete with different scope B -> device must NOT be deleted
    await store.deleteDevice(deviceId, "scope-B");
    assert.ok(store.getDevice(deviceId), "Device should remain when deleted with mismatched authScope");

    // Delete with matching scope A -> device must be deleted
    await store.deleteDevice(deviceId, "scope-A");
    assert.equal(store.getDevice(deviceId), undefined, "Device should be deleted when authScope matches");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
