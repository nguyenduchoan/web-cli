import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import Fastify from "fastify";
import WebSocket from "ws";
import type { AppConfig, ProjectConfig } from "../src/config.js";
import { registerSessionRoutes } from "../src/sessionRoutes.js";
import { SessionManager } from "../src/sessionManager.js";
import { WebSocketBridge } from "../src/websocket.js";
import type { WebAuth } from "../src/webAuth.js";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureAgentPath = path.resolve(testDir, "fixtures/terminal-agent.cjs");
const logger = { info() {}, warn() {}, error() {} };

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setupWsServer(configOverrides: Partial<AppConfig> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
  const port = await freePort();

  const projects: ProjectConfig[] = [
    { id: "proj-1", label: "Project One", path: tmpDir }
  ];

  const appConfig: AppConfig = {
    host: "127.0.0.1",
    port,
    clientOrigins: [`http://127.0.0.1:${port}`],
    authToken: "",
    agents: [
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
    maxSessions: 5,
    sessionIdleTtlMs: 60_000,
    sessionRetentionMs: 60_000,
    maxRetainedSessions: 50,
    shutdownTimeoutMs: 2_000,
    maxWebsocketConnections: 8,
    maxWebsocketBufferedBytes: 100_000,
    ...configOverrides
  };

  const fastify = Fastify();
  const sessions = new SessionManager(appConfig, logger);

  const mockAuth: WebAuth = {
    valid: (key?: string) => key === "valid-auth-key",
    sessionKey: () => "valid-auth-key"
  } as unknown as WebAuth;

  const wsBridge = new WebSocketBridge(fastify.server, appConfig, sessions, mockAuth, logger);
  wsBridge.start();

  registerSessionRoutes(fastify, {
    config: appConfig,
    sessions,
    wsBridge,
    auth: mockAuth
  });

  await fastify.listen({ host: "127.0.0.1", port });

  const session = sessions.createSession({
    agent: appConfig.agents[0],
    project: projects[0]
  });

  const getTicket = (protocolVersion: 1 | 2 = 1) => {
    return wsBridge.issueTicket(session.id, "valid-auth-key", protocolVersion);
  };

  const cleanup = async () => {
    await wsBridge.close();
    await sessions.close();
    await fastify.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { port, session, getTicket, sessions, wsBridge, cleanup };
}

function connectWs(port: number, sessionId: string, ticket: string, origin = `http://127.0.0.1:${port}`): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/ws`, [
      "web-cli",
      `ticket.${ticket}`
    ], {
      headers: { Origin: origin }
    });

    ws.on("message", (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch {
        messages.push(data.toString());
      }
    });

    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

function waitForMessage(messages: any[], predicate: (msg: any) => boolean, timeoutMs = 4000): Promise<any> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = messages.find(predicate);
      if (found) return resolve(found);
      if (Date.now() > deadline) {
        return reject(new Error(`Timed out waiting for message. Received: ${JSON.stringify(messages)}`));
      }
      setTimeout(check, 25);
    };
    const deadline = Date.now() + timeoutMs;
    check();
  });
}

test("W01 & W04: Protocol v1 and v2 clients receive expected formats without double replay", async () => {
  const { port, session, getTicket, cleanup } = await setupWsServer();
  try {
    // 1. Connect V1 client
    const t1 = getTicket(1);
    const { ws: ws1, messages: m1 } = await connectWs(port, session.id, t1.ticket);

    const v1State = await waitForMessage(m1, (m) => m.type === "state");
    assert.equal(v1State.session.id, session.id);

    // 2. Connect V2 client
    const t2 = getTicket(2);
    const { ws: ws2, messages: m2 } = await connectWs(port, session.id, t2.ticket);

    const v2SyncStart = await waitForMessage(m2, (m) => m.type === "sync_start");
    assert.equal(v2SyncStart.sessionId, session.id);
    assert.ok(v2SyncStart.syncId);

    const v2SyncEnd = await waitForMessage(m2, (m) => m.type === "sync_end");
    assert.equal(v2SyncEnd.syncId, v2SyncStart.syncId);

    ws1.close();
    ws2.close();
  } finally {
    await cleanup();
  }
});

test("W06: First socket is controller, second is viewer; viewer input returns control_locked", async () => {
  const { port, session, getTicket, cleanup } = await setupWsServer();
  try {
    // Client 1 (v2) -> controller
    const t1 = getTicket(2);
    const { ws: ws1, messages: m1 } = await connectWs(port, session.id, t1.ticket);
    const syncStart1 = await waitForMessage(m1, (m) => m.type === "sync_start");
    assert.equal(syncStart1.control, "controller");
    await waitForMessage(m1, (m) => m.type === "sync_end");

    // Client 2 (v2) -> viewer
    const t2 = getTicket(2);
    const { ws: ws2, messages: m2 } = await connectWs(port, session.id, t2.ticket);
    const syncStart2 = await waitForMessage(m2, (m) => m.type === "sync_start");
    assert.equal(syncStart2.control, "viewer");
    await waitForMessage(m2, (m) => m.type === "sync_end");

    // Viewer attempts to send input
    ws2.send(JSON.stringify({ type: "input", data: "VIEWER_FORBIDDEN\n" }));

    const errorMsg = await waitForMessage(m2, (m) => m.type === "error" && m.code === "control_locked");
    assert.equal(errorMsg.code, "control_locked");

    // Viewer attempts to resize
    ws2.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    const resizeErr = await waitForMessage(m2, (m) => m.type === "error" && m.code === "control_locked");
    assert.ok(resizeErr);

    ws1.close();
    ws2.close();
  } finally {
    await cleanup();
  }
});

test("W07: Controller disconnect promotes oldest viewer to controller atomically", async () => {
  const { port, session, getTicket, cleanup } = await setupWsServer();
  try {
    // Client 1 -> controller
    const t1 = getTicket(2);
    const { ws: ws1, messages: m1 } = await connectWs(port, session.id, t1.ticket);
    await waitForMessage(m1, (m) => m.type === "sync_end");

    // Client 2 -> viewer
    const t2 = getTicket(2);
    const { ws: ws2, messages: m2 } = await connectWs(port, session.id, t2.ticket);
    await waitForMessage(m2, (m) => m.type === "sync_end");

    // Close controller ws1
    ws1.close();

    // Client 2 should be promoted to controller
    const controlMsg = await waitForMessage(m2, (m) => m.type === "control");
    assert.equal(controlMsg.role, "controller");

    // Now client 2 can send input successfully
    ws2.send(JSON.stringify({ type: "input", data: "PING\n" }));
    const pongOutput = await waitForMessage(m2, (m) => m.type === "output" && m.data.includes("PONG"));
    assert.ok(pongOutput);

    ws2.close();
  } finally {
    await cleanup();
  }
});

test("W10: Auth/Origin/ticket validation rejects invalid handshakes", async () => {
  const { port, session, getTicket, cleanup } = await setupWsServer();
  try {
    // Invalid origin
    const t1 = getTicket(2);
    await assert.rejects(
      () => connectWs(port, session.id, t1.ticket, "http://evil-attacker.com"),
      (err: any) => err.message.includes("403") || err.message.includes("Unexpected server response")
    );

    // Invalid ticket
    await assert.rejects(
      () => connectWs(port, session.id, "invalid-ticket-key"),
      (err: any) => err.message.includes("401") || err.message.includes("Unexpected server response")
    );
  } finally {
    await cleanup();
  }
});

test("W11: Sync liveQueue bounded; overflow closes socket with 1013 and leaves session running", async () => {
  // Low limit: 300 bytes
  const { port, session, getTicket, sessions, cleanup } = await setupWsServer({
    maxWebsocketBufferedBytes: 300
  });

  try {
    const termState = sessions.getTerminalState(session.id);
    assert.ok(termState);

    // Delay snapshot barrier to keep client in syncComplete === false
    const origBarrier = termState.createSnapshotBarrier.bind(termState);
    termState.createSnapshotBarrier = async () => {
      await delay(150);
      return origBarrier();
    };

    const ticket = getTicket(2);
    const { ws, messages } = await connectWs(port, session.id, ticket.ticket);

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    // While client is waiting for snapshot barrier, emit output exceeding 300 bytes
    (sessions as any).events.emit("output_v2", session.id, 1, "A".repeat(400));

    const closeEvent = await closePromise;
    assert.equal(closeEvent.code, 1013);
    assert.match(closeEvent.reason, /Live queue overflow/);

    // PTY/session remains running
    const currentSession = sessions.getSession(session.id);
    assert.ok(currentSession);
    assert.equal(currentSession.state, "running");
  } finally {
    await cleanup();
  }
});

test("W12: Unicode byte accounting computes UTF-8 byte length rather than string length", async () => {
  // Limit is 200 bytes. A 4-byte emoji (e.g. 🚀) has string length 2, but UTF-8 byte length 4.
  // 60 emojis = 120 string chars, but 240 UTF-8 bytes.
  const { port, session, getTicket, sessions, cleanup } = await setupWsServer({
    maxWebsocketBufferedBytes: 200
  });

  try {
    const termState = sessions.getTerminalState(session.id);
    assert.ok(termState);

    const origBarrier = termState.createSnapshotBarrier.bind(termState);
    termState.createSnapshotBarrier = async () => {
      await delay(150);
      return origBarrier();
    };

    const ticket = getTicket(2);
    const { ws } = await connectWs(port, session.id, ticket.ticket);

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    // 60 rockets (120 chars, but 240 bytes payload)
    const emojiPayload = "🚀".repeat(60);
    (sessions as any).events.emit("output_v2", session.id, 1, emojiPayload);

    const closeEvent = await closePromise;
    assert.equal(closeEvent.code, 1013);
  } finally {
    await cleanup();
  }
});

test("W13: Slow syncing client does not pause/kill PTY or disconnect other clients", async () => {
  const { port, session, getTicket, sessions, cleanup } = await setupWsServer({
    maxWebsocketBufferedBytes: 300
  });

  try {
    // Client 1 (healthy viewer / fast client connected first)
    const t1 = getTicket(2);
    const { ws: ws1, messages: m1 } = await connectWs(port, session.id, t1.ticket);
    await waitForMessage(m1, (m) => m.type === "sync_end");

    // Client 2 (slow syncing client)
    const termState = sessions.getTerminalState(session.id);
    const origBarrier = termState!.createSnapshotBarrier.bind(termState!);
    termState!.createSnapshotBarrier = async () => {
      await delay(150);
      return origBarrier();
    };

    const t2 = getTicket(2);
    const { ws: ws2 } = await connectWs(port, session.id, t2.ticket);

    const close2Promise = new Promise<number>((resolve) => {
      ws2.on("close", (code) => resolve(code));
    });

    // Overflow client 2's queue
    (sessions as any).events.emit("output_v2", session.id, 2, "X".repeat(500));

    // Client 2 drops with 1013
    const code2 = await close2Promise;
    assert.equal(code2, 1013);

    // Client 1 remains connected and receives output!
    const received1 = await waitForMessage(m1, (m) => m.type === "output" && m.data.includes("XXXXX"));
    assert.ok(received1);
    assert.equal(ws1.readyState, WebSocket.OPEN);

    // Session remains running
    assert.equal(sessions.getSession(session.id)?.state, "running");

    ws1.close();
  } finally {
    await cleanup();
  }
});

test("WQ3: Normal small backlog is drained in order after sync completes", async () => {
  const { port, session, getTicket, sessions, cleanup } = await setupWsServer({
    maxWebsocketBufferedBytes: 100_000
  });

  try {
    const termState = sessions.getTerminalState(session.id);
    const origBarrier = termState!.createSnapshotBarrier.bind(termState!);
    termState!.createSnapshotBarrier = async () => {
      await delay(80);
      return origBarrier();
    };

    const ticket = getTicket(2);
    const { ws, messages } = await connectWs(port, session.id, ticket.ticket);

    // Emit live message while in sync
    (sessions as any).events.emit("output_v2", session.id, 100, "hello queued");

    // Wait for sync_end
    await waitForMessage(messages, (m) => m.type === "sync_end");

    // After sync_end, queued message should arrive
    const queuedMsg = await waitForMessage(messages, (m) => m.type === "output" && m.data === "hello queued");
    assert.ok(queuedMsg);
    assert.equal(queuedMsg.seq, 100);

    ws.close();
  } finally {
    await cleanup();
  }
});
