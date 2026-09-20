import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { AgentConfig, AppConfig, ProjectConfig } from "../src/config.js";
import {
  InvalidSubpathError,
  PathNotFoundError,
  PathTraversalError,
  SessionAlreadyRestartedError,
  SessionOperationInProgressError,
  SessionStopTimeoutError
} from "../src/httpErrors.js";
import { SessionCapacityError, SessionManager } from "../src/sessionManager.js";

import { fileURLToPath } from "node:url";

const logger = { info() {}, warn() {}, error() {} };

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureAgentPath = path.resolve(testDir, "fixtures/terminal-agent.cjs");

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
    maxSessions: 3,
    sessionIdleTtlMs: 60_000,
    sessionRetentionMs: 60_000,
    maxRetainedSessions: 50,
    shutdownTimeoutMs: 2_000,
    maxWebsocketConnections: 2,
    maxWebsocketBufferedBytes: 100_000,
    ...overrides
  };
}

const project: ProjectConfig = { id: "test-project", label: "test", path: path.resolve("/tmp") };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForOutput(manager: SessionManager, sessionId: string, matcher: RegExp, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    let accumulated = manager.getOutputBuffer(sessionId);
    if (matcher.test(accumulated)) {
      return resolve(accumulated);
    }
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timeout waiting for output matching ${matcher}. Output received: ${accumulated}`));
    }, timeoutMs);

    const off = manager.onOutput((id, data) => {
      if (id === sessionId) {
        accumulated += data;
        if (matcher.test(accumulated)) {
          clearTimeout(timer);
          off();
          resolve(accumulated);
        }
      }
    });
  });
}

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

test("S01: two codex sessions with same root and subpath run independently", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s01-"));
  const subDir = path.join(tmpDir, "sub");
  fs.mkdirSync(subDir);

  const testProject: ProjectConfig = { id: "p1", label: "project-1", path: tmpDir };
  const manager = new SessionManager(config({ maxSessions: 3 }), logger);

  const codexAgent: AgentConfig = {
    id: "codex",
    label: "Codex CLI",
    command: process.execPath,
    args: [fixtureAgentPath],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  const sessionA = manager.createSession({
    agent: codexAgent,
    project: testProject,
    subpath: "sub",
    ptyArgs: ["--marker", "MARKER_A"]
  });

  const sessionB = manager.createSession({
    agent: codexAgent,
    project: testProject,
    subpath: "sub",
    ptyArgs: ["--marker", "MARKER_B"]
  });

  assert.notEqual(sessionA.id, sessionB.id);
  assert.equal(sessionA.workingDirectoryId, sessionB.workingDirectoryId);
  assert.equal(sessionA.subpath, "sub");
  assert.equal(sessionB.subpath, "sub");

  await waitForOutput(manager, sessionA.id, /\[MARKER:MARKER_A\]/);
  await waitForOutput(manager, sessionB.id, /\[MARKER:MARKER_B\]/);

  // Neither kills each other; both remain running
  assert.equal(manager.getSession(sessionA.id)?.state, "running");
  assert.equal(manager.getSession(sessionB.id)?.state, "running");

  await manager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("S02: codex + shell with same cwd; kill/restart one does not affect the other", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s02-"));
  const testProject: ProjectConfig = { id: "p2", label: "project-2", path: tmpDir };
  const manager = new SessionManager(config({ maxSessions: 3 }), logger);

  const codexAgent: AgentConfig = {
    id: "codex",
    label: "Codex CLI",
    command: process.execPath,
    args: [fixtureAgentPath],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  const shellAgent: AgentConfig = {
    id: "shell",
    label: "Terminal",
    command: process.execPath,
    args: [fixtureAgentPath],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  const sessionCodex = manager.createSession({ agent: codexAgent, project: testProject });
  const sessionShell = manager.createSession({ agent: shellAgent, project: testProject });

  await waitForOutput(manager, sessionCodex.id, /AGENT_STARTED/);
  await waitForOutput(manager, sessionShell.id, /AGENT_STARTED/);

  // Kill codex session
  manager.killSession(sessionCodex.id);
  assert.equal(manager.getSession(sessionCodex.id)?.state, "stopping");
  assert.equal(manager.getSession(sessionShell.id)?.state, "running");

  // Wait for codex exit
  await delay(200);
  assert.equal(manager.getSession(sessionShell.id)?.state, "running");

  // Write input to shell
  manager.writeInput(sessionShell.id, "PING\n");
  await waitForOutput(manager, sessionShell.id, /PONG/);

  await manager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("S03: different agents, different cwd do not expose absolute path", async () => {
  const tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), "s03-a-"));
  const tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), "s03-b-"));
  const projA: ProjectConfig = { id: "p-a", label: "root-a", path: tmpDirA };
  const projB: ProjectConfig = { id: "p-b", label: "root-b", path: tmpDirB };

  const manager = new SessionManager(config(), logger);
  const agent: AgentConfig = {
    id: "agent-test",
    label: "Agent Test",
    command: process.execPath,
    args: [fixtureAgentPath],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  const sA = manager.createSession({ agent, project: projA });
  const sB = manager.createSession({ agent, project: projB });

  assert.equal(sA.rootProjectLabel, "root-a");
  assert.equal(sB.rootProjectLabel, "root-b");
  assert.notEqual(sA.workingDirectoryId, sB.workingDirectoryId);

  // Assert absolute paths are not exposed in public session
  const rawStrA = JSON.stringify(sA);
  assert.equal(rawStrA.includes(tmpDirA), false);
  const rawStrB = JSON.stringify(sB);
  assert.equal(rawStrB.includes(tmpDirB), false);

  await manager.close();
  fs.rmSync(tmpDirA, { recursive: true, force: true });
  fs.rmSync(tmpDirB, { recursive: true, force: true });
});

test("S04: same agent with different subpath yields different workingDirectoryId", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s04-"));
  fs.mkdirSync(path.join(tmpDir, "sub1"));
  fs.mkdirSync(path.join(tmpDir, "sub2"));
  const testProject: ProjectConfig = { id: "p4", label: "proj4", path: tmpDir };

  const manager = new SessionManager(config(), logger);
  const agent: AgentConfig = {
    id: "shell",
    label: "Terminal",
    command: process.execPath,
    args: [fixtureAgentPath],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  const sRoot = manager.createSession({ agent, project: testProject });
  const sSub1 = manager.createSession({ agent, project: testProject, subpath: "sub1" });
  const sSub2 = manager.createSession({ agent, project: testProject, subpath: "sub2" });

  assert.notEqual(sRoot.workingDirectoryId, sSub1.workingDirectoryId);
  assert.notEqual(sSub1.workingDirectoryId, sSub2.workingDirectoryId);
  assert.equal(sSub1.subpath, "sub1");
  assert.equal(sSub2.subpath, "sub2");
  assert.equal(sSub1.workingDirectoryLabel, "proj4/sub1");

  await manager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("S05: invalid subpath, path traversal, or non-directory throws and does not consume slot", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s05-"));
  const filePath = path.join(tmpDir, "file.txt");
  fs.writeFileSync(filePath, "hello");
  const testProject: ProjectConfig = { id: "p5", label: "proj5", path: tmpDir };

  const manager = new SessionManager(config({ maxSessions: 1 }), logger);
  const agent: AgentConfig = {
    id: "shell",
    label: "Terminal",
    command: process.execPath,
    args: [fixtureAgentPath],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  // Traversal
  assert.throws(
    () => manager.createSession({ agent, project: testProject, subpath: "../" }),
    PathTraversalError
  );

  // Not found
  assert.throws(
    () => manager.createSession({ agent, project: testProject, subpath: "non-existent-folder" }),
    PathNotFoundError
  );

  // File instead of folder
  assert.throws(
    () => manager.createSession({ agent, project: testProject, subpath: "file.txt" }),
    InvalidSubpathError
  );

  // Active count should still be 0, so valid creation succeeds
  assert.equal(manager.getActiveCount(), 0);
  const validSession = manager.createSession({ agent, project: testProject });
  assert.equal(validSession.state, "running");

  await manager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("S06: capacity enforcement with active and reserved calculation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s06-"));
  const testProject: ProjectConfig = { id: "p6", label: "proj6", path: tmpDir };
  const manager = new SessionManager(config({ maxSessions: 3 }), logger);
  const agent: AgentConfig = {
    id: "shell",
    label: "Terminal",
    command: process.execPath,
    args: [fixtureAgentPath],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  const s1 = manager.createSession({ agent, project: testProject });
  const s2 = manager.createSession({ agent, project: testProject });
  const s3 = manager.createSession({ agent, project: testProject });

  const cap = manager.getCapacity();
  assert.equal(cap.active, 3);
  assert.equal(cap.reserved, 0);
  assert.equal(cap.max, 3);

  // Attempt to create a 4th session
  assert.throws(() => manager.createSession({ agent, project: testProject }), SessionCapacityError);

  // All 3 original sessions still running
  assert.equal(manager.getSession(s1.id)?.state, "running");
  assert.equal(manager.getSession(s2.id)?.state, "running");
  assert.equal(manager.getSession(s3.id)?.state, "running");

  await manager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("S07: restart when capacity full reserves slot and links replacement session", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s07-"));
  const testProject: ProjectConfig = { id: "p7", label: "proj7", path: tmpDir };
  const manager = new SessionManager(config({ maxSessions: 2 }), logger);
  const agent: AgentConfig = {
    id: "shell",
    label: "Terminal",
    command: process.execPath,
    args: [fixtureAgentPath],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  const s1 = manager.createSession({ agent, project: testProject });
  const s2 = manager.createSession({ agent, project: testProject });

  const restartPromise = manager.restartSession(s1.id);
  const restartResult = await restartPromise;

  assert.ok(restartResult);
  assert.notEqual(restartResult.session.id, s1.id);
  assert.equal(restartResult.replacedSessionId, s1.id);

  const oldS1 = manager.getSession(s1.id);
  assert.equal(oldS1?.replacementSessionId, restartResult.session.id);
  assert.equal(oldS1?.exitReason, "restart");

  const newS1 = manager.getSession(restartResult.session.id);
  assert.equal(newS1?.replacedFromSessionId, s1.id);

  // Restarting old session again must throw session_already_restarted
  await assert.rejects(
    () => manager.restartSession(s1.id),
    SessionAlreadyRestartedError
  );

  await manager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("S09: concurrent restart on same session throws session_operation_in_progress", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s09-"));
  const testProject: ProjectConfig = { id: "p9", label: "proj9", path: tmpDir };
  const manager = new SessionManager(config({ maxSessions: 2 }), logger);
  const agent: AgentConfig = {
    id: "shell",
    label: "Terminal",
    command: process.execPath,
    args: [fixtureAgentPath],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  const s1 = manager.createSession({ agent, project: testProject });

  const p1 = manager.restartSession(s1.id);
  const p2 = manager.restartSession(s1.id);

  const results = await Promise.allSettled([p1, p2]);
  const succeeded = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");

  assert.equal(succeeded.length, 1);
  assert.equal(failed.length, 1);
  assert.ok((failed[0] as PromiseRejectedResult).reason instanceof SessionOperationInProgressError);

  await manager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("S12: PTY spawn error marks session as error/spawn_error and releases slot", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s12-"));
  const testProject: ProjectConfig = { id: "p12", label: "proj12", path: tmpDir };
  const manager = new SessionManager(config({ maxSessions: 1 }), logger);

  const badAgent: AgentConfig = {
    id: "non-existent",
    label: "Non Existent",
    command: "/bin/non-existent-binary-12345",
    args: [],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  const session = manager.createSession({
    agent: badAgent,
    project: testProject,
    ptySpawner: () => {
      throw new Error("PTY spawn binary execution failure");
    }
  });
  assert.equal(session.state, "error");
  assert.equal(session.exitReason, "spawn_error");
  assert.match(session.error || "", /PTY spawn binary execution failure/);

  // Since it failed, active count is 0, so another session can be created
  assert.equal(manager.getActiveCount(), 0);
  const goodAgent: AgentConfig = {
    id: "good",
    label: "Good",
    command: process.execPath,
    args: [fixtureAgentPath],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };
  const goodSession = manager.createSession({ agent: goodAgent, project: testProject });
  assert.equal(goodSession.state, "running");

  await manager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("S13: PTY double that ignores signals triggers stopTimedOut and restart 504", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s13-"));
  const testProject: ProjectConfig = { id: "p13", label: "proj13", path: tmpDir };
  const manager = new SessionManager(config({ maxSessions: 2 }), logger);

  // Mock PTY spawner that creates a fake PTY that refuses to exit
  const mockPtySpawner = (() => {
    const emitter = new EventEmitter();
    return {
      pid: 99999,
      cols: 80,
      rows: 24,
      process: "mock",
      handleFlowControl: false,
      onData: (cb: (data: string) => void) => emitter.on("data", cb),
      onExit: (cb: (exit: { exitCode: number; signal?: number }) => void) => emitter.on("exit", cb),
      write: () => {},
      resize: () => {},
      clear: () => {},
      kill: () => {
        // Deliberately do not emit exit to simulate an unkillable process
      },
      pause: () => {},
      resume: () => {}
    } as any;
  }) as any;

  const agent: AgentConfig = {
    id: "mock-agent",
    label: "Mock Agent",
    command: "mock",
    args: [],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  const s = manager.createSession({ agent, project: testProject, ptySpawner: mockPtySpawner });
  assert.equal(s.state, "running");

  // Restarting should fail with SessionStopTimeoutError (HTTP 504)
  await assert.rejects(
    () => manager.restartSession(s.id),
    SessionStopTimeoutError
  );

  const updated = manager.getSession(s.id);
  assert.equal(updated?.state, "stopping");
  assert.equal(updated?.stopTimedOut, true);

  await manager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("S14: exitReason tracking across natural, kill, and repeated kill does not reset deadline", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s14-"));
  const testProject: ProjectConfig = { id: "p14", label: "proj14", path: tmpDir };
  const manager = new SessionManager(config(), logger);

  const agent: AgentConfig = {
    id: "shell",
    label: "Terminal",
    command: process.execPath,
    args: [fixtureAgentPath],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  // 1. Natural exit
  const sNatural = manager.createSession({ agent, project: testProject });
  manager.writeInput(sNatural.id, "EXIT:0\n");
  await delay(200);
  const naturalRecord = manager.getSession(sNatural.id);
  assert.equal(naturalRecord?.state, "exited");
  assert.equal(naturalRecord?.exitReason, "natural");

  // 2. Kill and repeated kill
  const sKill = manager.createSession({ agent, project: testProject });
  const k1 = manager.killSession(sKill.id);
  assert.equal(k1?.state, "stopping");
  assert.equal(k1?.exitReason, "user_kill");
  const rev1 = k1?.revision;

  // Repeated kill returns current state, does not reset or error
  const k2 = manager.killSession(sKill.id);
  assert.equal(k2?.state, "stopping");
  assert.equal(k2?.revision, rev1);

  await delay(200);
  assert.equal(manager.getSession(sKill.id)?.state, "exited");
  assert.equal(manager.getSession(sKill.id)?.exitReason, "user_kill");

  await manager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("S15: retention limit of 50 oldest exited/error sessions evicted with removed event", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s15-"));
  const testProject: ProjectConfig = { id: "p15", label: "proj15", path: tmpDir };
  const manager = new SessionManager(config({ maxSessions: 100, maxRetainedSessions: 5 }), logger);

  const agent: AgentConfig = {
    id: "shell",
    label: "Terminal",
    command: process.execPath,
    args: [fixtureAgentPath],
    quickActions: { yesAll: "", skip: "", editFirst: "" }
  };

  const removedIds: string[] = [];
  manager.onRemoved((id) => removedIds.push(id));

  const sessions = [];
  for (let i = 0; i < 7; i++) {
    const s = manager.createSession({ agent, project: testProject });
    sessions.push(s);
    manager.writeInput(s.id, "EXIT:0\n");
    await delay(50);
  }

  // Trigger sweep
  manager.sweep();

  // 7 exited sessions created, maxRetained is 5, so the 2 oldest should be evicted
  assert.equal(removedIds.length, 2);
  assert.equal(removedIds[0], sessions[0].id);
  assert.equal(removedIds[1], sessions[1].id);

  assert.equal(manager.getSession(sessions[0].id), undefined);
  assert.equal(manager.getSession(sessions[1].id), undefined);
  assert.ok(manager.getSession(sessions[6].id));

  await manager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
