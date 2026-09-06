import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { AgentConfig, AppConfig, ProjectConfig } from "../src/config.js";
import { SessionCapacityError, SessionManager } from "../src/sessionManager.js";

const logger = { info() {}, warn() {}, error() {} };

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    clientOrigins: ["http://localhost"],
    authToken: "x".repeat(64),
    agents: [],
    projects: [],
    outputBufferLimit: 20_000,
    websocketTicketTtlMs: 60_000,
    logTerminalOutput: false,
    childEnvAllowlist: ["PATH", "HOME", "SAFE_AGENT_TEST_VALUE"],
    maxSessions: 1,
    sessionIdleTtlMs: 60_000,
    sessionRetentionMs: 60_000,
    shutdownTimeoutMs: 2_000,
    maxWebsocketConnections: 2,
    maxWebsocketBufferedBytes: 100_000,
    ...overrides
  };
}

const project: ProjectConfig = { id: "test-project", label: "test", path: path.resolve("/tmp") };

function waitForExit(manager: SessionManager): Promise<string> {
  return new Promise((resolve) => {
    const output: string[] = [];
    const offOutput = manager.onOutput((_sessionId, data) => output.push(data));
    const offExit = manager.onExit(() => {
      offOutput();
      offExit();
      resolve(output.join(""));
    });
  });
}

test("PTY child receives only explicitly allowlisted environment variables", async () => {
  process.env.AUTH_TOKEN = "controller-secret-must-not-reach-child";
  process.env.SAFE_AGENT_TEST_VALUE = "safe-value-is-present";
  const manager = new SessionManager(config(), logger);
  const outputPromise = waitForExit(manager);
  const agent: AgentConfig = {
    id: "env",
    label: "env",
    command: "/usr/bin/env",
    args: [],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  manager.createSession({ agent, project });
  const output = await outputPromise;
  assert.match(output, /SAFE_AGENT_TEST_VALUE=safe-value-is-present/);
  assert.doesNotMatch(output, /controller-secret-must-not-reach-child/);
  assert.doesNotMatch(output, /^AUTH_TOKEN=/m);
  await manager.close();
  delete process.env.AUTH_TOKEN;
  delete process.env.SAFE_AGENT_TEST_VALUE;
});

test("session capacity is enforced and shutdown terminates active PTYs", async () => {
  const manager = new SessionManager(config({ maxSessions: 1 }), logger);
  const agent: AgentConfig = {
    id: "sleep",
    label: "sleep",
    command: "/bin/sh",
    args: ["-c", "sleep 30"],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  const session = manager.createSession({ agent, project });
  assert.equal(session.state, "running");
  assert.throws(() => manager.createSession({ agent, project }), SessionCapacityError);
  await manager.close();
});
