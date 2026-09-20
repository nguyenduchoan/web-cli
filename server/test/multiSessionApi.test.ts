import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import type { AppConfig, ProjectConfig } from "../src/config.js";
import { IdempotencyStore } from "../src/idempotency.js";
import { registerSessionRoutes } from "../src/sessionRoutes.js";
import { SessionManager } from "../src/sessionManager.js";
import { WebSocketBridge } from "../src/websocket.js";
import type { WebAuth } from "../src/webAuth.js";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureAgentPath = path.resolve(testDir, "fixtures/terminal-agent.cjs");
const logger = { info() {}, warn() {}, error() {} };

function setupTestApp(maxSessions = 3) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-test-"));
  const subDir = path.join(tmpDir, "server");
  fs.mkdirSync(subDir);

  const projects: ProjectConfig[] = [
    { id: "proj-1", label: "Project One", path: tmpDir }
  ];

  const appConfig: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    clientOrigins: ["http://localhost"],
    authToken: "",
    agents: [
      {
        id: "codex",
        label: "Codex CLI",
        command: process.execPath,
        args: [fixtureAgentPath],
        quickActions: { yesAll: "", skip: "", editFirst: "" }
      },
      {
        id: "shell",
        label: "Terminal",
        command: process.execPath,
        args: [fixtureAgentPath],
        quickActions: { yesAll: "", skip: "", editFirst: "" }
      }
    ],
    projects,
    outputBufferLimit: 20_000,
    websocketTicketTtlMs: 60_000,
    logTerminalOutput: false,
    childEnvAllowlist: ["PATH", "HOME"],
    maxSessions,
    sessionIdleTtlMs: 60_000,
    sessionRetentionMs: 60_000,
    maxRetainedSessions: 50,
    shutdownTimeoutMs: 2_000,
    maxWebsocketConnections: 8,
    maxWebsocketBufferedBytes: 100_000
  };

  const fastify = Fastify();
  const sessions = new SessionManager(appConfig, logger);
  const mockAuth: WebAuth = {
    valid: () => true,
    sessionKey: () => "mock-auth-key"
  } as unknown as WebAuth;

  const wsBridge = new WebSocketBridge(fastify.server, appConfig, sessions, mockAuth, logger);
  const idempotencyStore = new IdempotencyStore();

  registerSessionRoutes(fastify, {
    config: appConfig,
    sessions,
    wsBridge,
    auth: mockAuth,
    idempotencyStore
  });

  const cleanup = async () => {
    await wsBridge.close();
    await sessions.close();
    await fastify.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { fastify, sessions, tmpDir, cleanup };
}

test("GET /api/projects includes workingDirectoryId for each project root", async () => {
  const { fastify, cleanup } = setupTestApp();
  try {
    const res = await fastify.inject({ method: "GET", url: "/api/projects" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.projects));
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].id, "proj-1");
    assert.ok(body.projects[0].workingDirectoryId);
    assert.equal(body.projects[0].workingDirectoryId.length, 32);
  } finally {
    await cleanup();
  }
});

test("GET /api/browse/:projectId returns workingDirectoryId and canonicalSubpath", async () => {
  const { fastify, cleanup } = setupTestApp();
  try {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/browse/proj-1?subpath=server"
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.projectId, "proj-1");
    assert.equal(body.canonicalSubpath, "server");
    assert.ok(body.workingDirectoryId);
    assert.equal(body.workingDirectoryId.length, 32);
  } finally {
    await cleanup();
  }
});

test("POST /api/sessions creates session with metadata, epoch, revision, capacity, and Idempotency-Key", async () => {
  const { fastify, cleanup } = setupTestApp();
  const key = "11111111-2222-4333-8444-555555555555";
  try {
    const payload = {
      agentId: "codex",
      projectId: "proj-1",
      subpath: "server",
      name: "Feature Session"
    };

    const res1 = await fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "idempotency-key": key },
      payload
    });

    assert.equal(res1.statusCode, 201);
    const body1 = res1.json();
    assert.ok(body1.session);
    assert.equal(body1.session.name, "Feature Session");
    assert.equal(body1.session.agentId, "codex");
    assert.equal(body1.session.subpath, "server");
    assert.ok(body1.serverEpoch);
    assert.ok(body1.registryRevision);
    assert.deepEqual(body1.capacity, { active: 1, reserved: 0, max: 3 });

    // Replay with identical key returns exact same body and status
    const res2 = await fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "idempotency-key": key },
      payload
    });

    assert.equal(res2.statusCode, 201);
    const body2 = res2.json();
    assert.equal(body2.session.id, body1.session.id);
  } finally {
    await cleanup();
  }
});

test("POST /api/sessions capacity limit returns 429 session_capacity_reached", async () => {
  const { fastify, cleanup } = setupTestApp(1);
  try {
    const res1 = await fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { agentId: "codex", projectId: "proj-1" }
    });
    assert.equal(res1.statusCode, 201);

    const res2 = await fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { agentId: "shell", projectId: "proj-1" }
    });
    assert.equal(res2.statusCode, 429);
    assert.equal(res2.json().error, "session_capacity_reached");
  } finally {
    await cleanup();
  }
});

test("POST /api/sessions/:id/restart with idempotency returns replacedSessionId and new session", async () => {
  const { fastify, cleanup } = setupTestApp(2);
  const restartKey = "66666666-7777-4888-8999-000000000000";
  try {
    const createRes = await fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { agentId: "codex", projectId: "proj-1", name: "Session To Restart" }
    });
    const originalSessionId = createRes.json().session.id;

    const restartRes = await fastify.inject({
      method: "POST",
      url: `/api/sessions/${originalSessionId}/restart`,
      headers: { "idempotency-key": restartKey },
      payload: { cols: 80, rows: 25 }
    });

    assert.equal(restartRes.statusCode, 200);
    const restartBody = restartRes.json();
    assert.equal(restartBody.replacedSessionId, originalSessionId);
    assert.notEqual(restartBody.session.id, originalSessionId);
    assert.equal(restartBody.session.name, "Session To Restart");
    assert.ok(restartBody.capacity);

    // Replay with identical key returns cached response
    const replayRes = await fastify.inject({
      method: "POST",
      url: `/api/sessions/${originalSessionId}/restart`,
      headers: { "idempotency-key": restartKey },
      payload: { cols: 80, rows: 25 }
    });
    assert.equal(replayRes.statusCode, 200);
    assert.equal(replayRes.json().session.id, restartBody.session.id);
  } finally {
    await cleanup();
  }
});

test("POST /api/sessions/:id/ws-ticket negotiates protocolVersion 1 and 2", async () => {
  const { fastify, cleanup } = setupTestApp();
  try {
    const createRes = await fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { agentId: "codex", projectId: "proj-1" }
    });
    const sessionId = createRes.json().session.id;

    // v1 default
    const t1Res = await fastify.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/ws-ticket`,
      payload: {}
    });
    assert.equal(t1Res.statusCode, 200);
    assert.equal(t1Res.json().protocolVersion, 1);
    assert.ok(t1Res.json().ticket);

    // v2 explicit
    const t2Res = await fastify.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/ws-ticket`,
      payload: { protocolVersion: 2 }
    });
    assert.equal(t2Res.statusCode, 200);
    assert.equal(t2Res.json().protocolVersion, 2);
    assert.ok(t2Res.json().ticket);
  } finally {
    await cleanup();
  }
});
