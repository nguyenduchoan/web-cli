import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as pty from "node-pty";
import type { AgentConfig, AppConfig, ProjectConfig } from "./config.js";
import {
  AppHttpError,
  InvalidSubpathError,
  PathNotFoundError,
  PathTraversalError,
  ServerShuttingDownError,
  SessionAlreadyRestartedError,
  SessionCapacityReachedError,
  SessionOperationInProgressError,
  SessionStopTimeoutError
} from "./httpErrors.js";

import { TerminalState } from "./terminalState.js";
import { AttentionDetector, type AttentionEvent } from "./attention.js";

export type SessionState = "idle" | "running" | "stopping" | "exited" | "error";

export type SessionExitReason =
  | "natural"
  | "user_kill"
  | "restart"
  | "idle_timeout"
  | "server_shutdown"
  | "spawn_error";

export type PublicSession = {
  id: string;
  name?: string;
  agentId: string;
  agentLabel: string;
  projectId: string;
  projectLabel: string;
  rootProjectLabel: string;
  subpath?: string;
  workingDirectoryId: string;
  workingDirectoryLabel: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  revision: number;
  outputLastSeq: number;
  replacedFromSessionId?: string;
  replacementSessionId?: string;
  stopTimedOut?: boolean;
  attention?: { eventId: string; createdAt: string };
  exitReason?: SessionExitReason;
  exitCode?: number;
  signal?: number;
  error?: string;
};

export type SessionRecord = {
  id: string;
  name?: string;
  agent: AgentConfig;
  project: ProjectConfig;
  rootPath: string;
  realCwd: string;
  subpath?: string;
  workingDirectoryId: string;
  rootProjectLabel: string;
  workingDirectoryLabel: string;
  state: SessionState;
  exitReason?: SessionExitReason;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
  revision: number;
  outputLastSeq: number;
  replacedFromSessionId?: string;
  replacementSessionId?: string;
  stopTimedOut?: boolean;
  attention?: { eventId: string; createdAt: string };
  attentionDetector?: AttentionDetector;
  exitCode?: number;
  signal?: number;
  error?: string;
  ptyProcess?: pty.IPty;
  terminalState: TerminalState;
  outputBuffer: string;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  stopWatchdogTimer?: NodeJS.Timeout;
  restartLock?: boolean;
};

type OutputListener = (sessionId: string, data: string) => void;
type StateListener = (sessionId: string, session: PublicSession) => void;
type ExitListener = (sessionId: string, exitCode?: number, signal?: number) => void;
type RemovedListener = (sessionId: string) => void;
type AttentionListener = (sessionId: string, attention: { eventId: string; createdAt: string }) => void;

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SessionCapacityError extends SessionCapacityReachedError {}

export class SessionManager {
  readonly serverEpoch = crypto.randomUUID();
  private registryRevision = 1;
  private reservedSlots = 0;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly events = new EventEmitter();
  private readonly cleanupTimer: NodeJS.Timeout;
  private closing = false;

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {
    this.events.setMaxListeners(config.maxWebsocketConnections * 4 + 20);
    const interval = Math.max(10_000, Math.min(60_000, config.sessionIdleTtlMs));
    this.cleanupTimer = setInterval(() => this.sweep(), interval);
    this.cleanupTimer.unref();
  }

  getServerEpoch(): string {
    return this.serverEpoch;
  }

  getRegistryRevision(): number {
    return this.registryRevision;
  }

  getActiveCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (["idle", "running", "stopping"].includes(session.state)) {
        count++;
      }
    }
    return count;
  }

  getCapacity(): { active: number; reserved: number; max: number } {
    return {
      active: this.getActiveCount(),
      reserved: this.reservedSlots,
      max: this.config.maxSessions
    };
  }

  createSession(input: {
    agent: AgentConfig;
    project: ProjectConfig;
    subpath?: string;
    name?: string;
    cols?: number;
    rows?: number;
    isRestartReplacement?: boolean;
    ptySpawner?: typeof pty.spawn;
    ptyArgs?: string[];
  }): PublicSession {
    if (this.closing) {
      throw new ServerShuttingDownError();
    }

    this.sweep();

    const activeCount = this.getActiveCount();
    if (!input.isRestartReplacement && activeCount + this.reservedSlots >= this.config.maxSessions) {
      throw new SessionCapacityError(this.config.maxSessions);
    }

    // Resolve project directory and subpath
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(input.project.path);
    } catch {
      throw new PathNotFoundError(`Project root directory not found: ${input.project.path}`);
    }

    let realCwd = realRoot;
    let canonicalSubpath: string | undefined;

    if (input.subpath && input.subpath.trim() !== "") {
      const rawSubpath = input.subpath.trim();
      if (rawSubpath.length > 500) {
        throw new InvalidSubpathError("Subpath exceeds 500 characters");
      }
      const resolved = path.resolve(realRoot, rawSubpath);
      let resolvedReal: string;
      try {
        resolvedReal = fs.realpathSync(resolved);
      } catch (err: unknown) {
        const error = err as { code?: string; message?: string };
        if (error.code === "ENOENT") {
          throw new PathNotFoundError(`Directory not found: ${rawSubpath}`);
        }
        throw new InvalidSubpathError(`Cannot resolve subpath: ${error.message || "Unknown error"}`);
      }

      const relative = path.relative(realRoot, resolvedReal);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new PathTraversalError("Subpath resolves outside project root");
      }

      const stat = fs.statSync(resolvedReal);
      if (!stat.isDirectory()) {
        throw new InvalidSubpathError("Subpath is not a directory");
      }

      realCwd = resolvedReal;
      const formatted = relative.split(path.sep).join("/");
      canonicalSubpath = formatted === "" ? undefined : formatted;
    }

    // Validate name
    let sessionName: string | undefined;
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (trimmed.length > 0) {
        if (trimmed.length > 80) {
          throw new AppHttpError(400, "validation_error", "Session name must be at most 80 characters");
        }
        sessionName = trimmed;
      }
    }

    // Validate cols and rows
    const cols = input.cols ?? 100;
    const rows = input.rows ?? 30;
    if (cols < 20 || cols > 300 || rows < 5 || rows > 120) {
      throw new AppHttpError(400, "validation_error", "cols must be 20-300 and rows must be 5-120");
    }

    const workingDirectoryId = crypto.createHash("sha256").update(realCwd).digest("hex").slice(0, 32);
    const rootProjectLabel = input.project.label;
    const workingDirectoryLabel = rootProjectLabel + (canonicalSubpath ? `/${canonicalSubpath}` : "");

    const now = new Date();
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const terminalState = new TerminalState(cols, rows);

    const session: SessionRecord = {
      id: crypto.randomUUID(),
      name: sessionName,
      agent: input.agent,
      project: input.project,
      rootPath: realRoot,
      realCwd,
      subpath: canonicalSubpath,
      workingDirectoryId,
      rootProjectLabel,
      workingDirectoryLabel,
      state: "idle",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      revision: 1,
      outputLastSeq: 0,
      terminalState,
      outputBuffer: "",
      exitPromise,
      resolveExit
    };

    if (input.agent.id === "codex") {
      session.attentionDetector = new AttentionDetector(session.id, (event) => {
        this.updateAttention(session.id, event);
      });
    }

    this.sessions.set(session.id, session);
    this.registryRevision++;

    this.start(session, cols, rows, input.ptySpawner, input.ptyArgs);
    return this.toPublic(session);
  }

  getSession(sessionId: string): PublicSession | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.toPublic(session) : undefined;
  }

  getSessionRecord(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): PublicSession[] {
    return [...this.sessions.values()]
      .map((session) => this.toPublic(session))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getOutputBuffer(sessionId: string): string {
    return this.sessions.get(sessionId)?.outputBuffer ?? "";
  }

  killSession(sessionId: string): PublicSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.restartLock) {
      throw new SessionOperationInProgressError(sessionId);
    }
    if (["exited", "error"].includes(session.state)) {
      return this.toPublic(session);
    }
    if (session.state === "stopping") {
      // Repeated kill returns current state without resetting deadline
      return this.toPublic(session);
    }

    session.state = "stopping";
    session.exitReason = "user_kill";
    session.updatedAt = new Date();
    session.revision++;
    this.registryRevision++;
    this.emitState(session);

    this.startStopWatchdog(session, 5_000, 1_000);
    try {
      session.ptyProcess?.kill();
    } catch (error) {
      this.logger.warn({ sessionId: session.id, error: error instanceof Error ? error.message : String(error) }, "PTY stop signal failed");
    }

    return this.toPublic(session);
  }

  async restartSession(
    sessionId: string,
    optionsOrCols?: { cols?: number; rows?: number; ptySpawner?: typeof pty.spawn; ptyArgs?: string[] } | number,
    maybeRows?: number
  ): Promise<{ session: PublicSession; replacedSessionId: string } | undefined> {
    const options = typeof optionsOrCols === "number"
      ? { cols: optionsOrCols, rows: maybeRows }
      : optionsOrCols;
    const previous = this.sessions.get(sessionId);
    if (!previous) return undefined;

    if (previous.restartLock) {
      throw new SessionOperationInProgressError(sessionId);
    }

    if (previous.replacementSessionId) {
      throw new SessionAlreadyRestartedError(sessionId);
    }

    const wasActive = ["idle", "running", "stopping"].includes(previous.state);

    if (wasActive) {
      previous.restartLock = true;
      if (previous.state !== "stopping") {
        previous.state = "stopping";
        previous.exitReason = "restart";
        previous.updatedAt = new Date();
        previous.revision++;
        this.registryRevision++;
        this.emitState(previous);
      } else if (!previous.exitReason) {
        previous.exitReason = "restart";
      }

      await this.stopAndWait(previous, 5_000, 1_000);

      if (previous.ptyProcess) {
        previous.stopTimedOut = true;
        previous.restartLock = false;
        previous.updatedAt = new Date();
        previous.revision++;
        this.registryRevision++;
        this.emitState(previous);
        throw new SessionStopTimeoutError(sessionId);
      }

      // Slot reservation from the stopped session
      this.reservedSlots++;
    } else {
      // Was already exited/error: must check capacity first
      if (this.getActiveCount() + this.reservedSlots >= this.config.maxSessions) {
        throw new SessionCapacityError(this.config.maxSessions);
      }
      this.reservedSlots++;
      previous.restartLock = true;
      previous.exitReason = "restart";
    }

    try {
      const replacement = this.createSession({
        agent: previous.agent,
        project: previous.project,
        subpath: previous.subpath,
        name: previous.name,
        cols: options?.cols,
        rows: options?.rows,
        isRestartReplacement: true,
        ptySpawner: options?.ptySpawner,
        ptyArgs: options?.ptyArgs
      });

      const replacementRecord = this.sessions.get(replacement.id);
      if (replacementRecord) {
        replacementRecord.replacedFromSessionId = previous.id;
        replacementRecord.revision++;
      }

      previous.replacementSessionId = replacement.id;
      previous.restartLock = false;
      previous.updatedAt = new Date();
      previous.revision++;
      this.registryRevision++;
      this.emitState(previous);

      return {
        session: replacementRecord ? this.toPublic(replacementRecord) : replacement,
        replacedSessionId: previous.id
      };
    } finally {
      this.reservedSlots = Math.max(0, this.reservedSlots - 1);
      previous.restartLock = false;
    }
  }

  writeInput(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.ptyProcess || session.state !== "running") return false;
    session.lastActivityAt = new Date();
    session.ptyProcess.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.ptyProcess || session.state !== "running") return false;
    // Note: per plan rule 389, resize is excluded from business activity (does not reset idle timer)
    session.ptyProcess.resize(cols, rows);
    session.terminalState.enqueueResize(cols, rows).then((seq) => {
      session.outputLastSeq = seq;
      this.events.emit("terminal_resize", session.id, seq, cols, rows);
    }).catch(() => {});
    return true;
  }

  getTerminalState(sessionId: string): TerminalState | undefined {
    return this.sessions.get(sessionId)?.terminalState;
  }

  onOutputV2(listener: (sessionId: string, seq: number, data: string) => void): () => void {
    this.events.on("output_v2", listener);
    return () => this.events.off("output_v2", listener);
  }

  onTerminalResize(listener: (sessionId: string, seq: number, cols: number, rows: number) => void): () => void {
    this.events.on("terminal_resize", listener);
    return () => this.events.off("terminal_resize", listener);
  }

  updateAttention(sessionId: string, attention: { eventId: string; createdAt: string }): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.attention = attention;
    session.updatedAt = new Date();
    session.revision++;
    this.registryRevision++;
    this.emitState(session);
    this.events.emit("attention", session.id, attention);
  }

  onOutput(listener: OutputListener): () => void {
    this.events.on("output", listener);
    return () => this.events.off("output", listener);
  }

  onState(listener: StateListener): () => void {
    this.events.on("state", listener);
    return () => this.events.off("state", listener);
  }

  onExit(listener: ExitListener): () => void {
    this.events.on("exit", listener);
    return () => this.events.off("exit", listener);
  }

  onRemoved(listener: RemovedListener): () => void {
    this.events.on("removed", listener);
    return () => this.events.off("removed", listener);
  }

  onAttention(listener: AttentionListener): () => void {
    this.events.on("attention", listener);
    return () => this.events.off("attention", listener);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.cleanupTimer);

    const active = [...this.sessions.values()].filter(
      (session) => session.ptyProcess && ["running", "stopping"].includes(session.state)
    );

    for (const session of active) {
      if (!session.exitReason) {
        session.exitReason = "server_shutdown";
      }
    }

    await Promise.all(active.map((session) => this.stopAndWait(session, 5_000, 1_000)));

    for (const session of this.sessions.values()) {
      session.terminalState.dispose();
      if (session.stopWatchdogTimer) {
        clearTimeout(session.stopWatchdogTimer);
        session.stopWatchdogTimer = undefined;
      }
    }

    this.events.removeAllListeners();
    this.sessions.clear();
  }

  private buildChildEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const name of this.config.childEnvAllowlist) {
      const value = process.env[name];
      if (typeof value === "string") environment[name] = value;
    }
    environment.TERM = "xterm-256color";
    environment.COLORTERM = "truecolor";
    return environment;
  }

  private start(
    session: SessionRecord,
    cols = 100,
    rows = 30,
    ptySpawner: typeof pty.spawn = pty.spawn,
    extraArgs?: string[]
  ): void {
    try {
      this.logger.info(
        { sessionId: session.id, agentId: session.agent.id, projectId: session.project.id, cwd: session.realCwd },
        "Starting PTY session"
      );

      let spawnArgs = extraArgs ? [...session.agent.args, ...extraArgs] : [...session.agent.args];
      if (session.agent.id === "codex" && this.config.push?.enabled) {
        const codexPushArgs = [
          "-c", 'tui.notifications=["approval-requested","plan-mode-prompt"]',
          "-c", 'tui.notification_method="osc9"',
          "-c", 'tui.notification_condition="always"'
        ];
        const dashDashIdx = spawnArgs.indexOf("--");
        if (dashDashIdx !== -1) {
          spawnArgs.splice(dashDashIdx, 0, ...codexPushArgs);
        } else {
          spawnArgs.push(...codexPushArgs);
        }
      }

      const ptyProcess = ptySpawner(session.agent.command, spawnArgs, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: session.realCwd,
        env: this.buildChildEnvironment()
      });

      session.ptyProcess = ptyProcess;
      session.terminalState.setPtyProcess(ptyProcess);
      session.state = "running";
      session.updatedAt = new Date();
      session.lastActivityAt = new Date();
      session.revision++;
      this.registryRevision++;
      this.emitState(session);

      ptyProcess.onData((data) => {
        session.lastActivityAt = new Date();
        session.attentionDetector?.feed(data);
        session.outputBuffer += data;
        if (session.outputBuffer.length > this.config.outputBufferLimit) {
          session.outputBuffer = session.outputBuffer.slice(-this.config.outputBufferLimit);
        }
        if (this.config.logTerminalOutput) {
          this.logger.warn({ sessionId: session.id, bytes: Buffer.byteLength(data) }, "Terminal output observed; content logging remains disabled");
        }
        this.events.emit("output", session.id, data);
        session.terminalState.enqueueWrite(data).then((seq) => {
          session.outputLastSeq = seq;
          this.events.emit("output_v2", session.id, seq, data);
        }).catch((err) => {
          this.logger.warn({ sessionId: session.id, error: String(err) }, "TerminalState write error");
        });
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        if (session.stopWatchdogTimer) {
          clearTimeout(session.stopWatchdogTimer);
          session.stopWatchdogTimer = undefined;
        }

        session.attentionDetector?.destroy();
        session.attentionDetector = undefined;

        session.state = "exited";
        session.exitCode = exitCode;
        session.signal = signal;
        session.ptyProcess = undefined;
        if (!session.exitReason) {
          session.exitReason = "natural";
        }
        session.updatedAt = new Date();
        session.revision++;
        this.registryRevision++;
        session.resolveExit();

        session.terminalState.finalizeOnExit().catch(() => {});

        this.logger.info({ sessionId: session.id, exitCode, signal, reason: session.exitReason }, "PTY session exited");
        this.emitState(session);
        this.events.emit("exit", session.id, exitCode, signal);
      });
    } catch (error) {
      session.state = "error";
      session.exitReason = "spawn_error";
      session.error = error instanceof Error ? error.message : "Unknown PTY spawn error";
      session.updatedAt = new Date();
      session.revision++;
      this.registryRevision++;
      session.resolveExit();
      this.logger.error({ sessionId: session.id, error: session.error }, "Failed to start PTY session");
      this.emitState(session);
    }
  }

  private startStopWatchdog(session: SessionRecord, termTimeoutMs: number, killTimeoutMs: number): void {
    if (session.stopWatchdogTimer) {
      clearTimeout(session.stopWatchdogTimer);
    }

    session.stopWatchdogTimer = setTimeout(() => {
      if (!session.ptyProcess) return;
      this.logger.warn({ sessionId: session.id }, "PTY did not stop within TERM deadline; sending SIGKILL");
      try {
        session.ptyProcess.kill("SIGKILL");
      } catch {}

      session.stopWatchdogTimer = setTimeout(() => {
        if (!session.ptyProcess) return;
        session.stopTimedOut = true;
        session.updatedAt = new Date();
        session.revision++;
        this.registryRevision++;
        this.emitState(session);
        this.logger.error({ sessionId: session.id }, "PTY did not stop within SIGKILL deadline; stop timed out");
      }, killTimeoutMs);
      session.stopWatchdogTimer.unref?.();
    }, termTimeoutMs);

    session.stopWatchdogTimer.unref?.();
  }

  private async stopAndWait(session: SessionRecord, termTimeoutMs: number, killTimeoutMs: number): Promise<void> {
    if (!session.ptyProcess) return;

    try {
      session.ptyProcess.kill();
    } catch {}

    const termPromise = Promise.race([session.exitPromise, delay(termTimeoutMs)]);
    await termPromise;

    if (!session.ptyProcess) return;

    this.logger.warn({ sessionId: session.id }, "PTY did not stop in time; sending SIGKILL");
    try {
      session.ptyProcess.kill("SIGKILL");
    } catch {}

    const killPromise = Promise.race([session.exitPromise, delay(killTimeoutMs)]);
    await killPromise;
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.stopWatchdogTimer) {
      clearTimeout(session.stopWatchdogTimer);
      session.stopWatchdogTimer = undefined;
    }

    session.terminalState.dispose();
    session.outputBuffer = "";
    this.sessions.delete(sessionId);
    this.registryRevision++;
    this.events.emit("removed", sessionId);
  }

  sweep(): void {
    const now = Date.now();

    // 1. Idle timeout check for running sessions
    for (const session of this.sessions.values()) {
      if (session.state === "running" && now - session.lastActivityAt.getTime() > this.config.sessionIdleTtlMs) {
        session.state = "stopping";
        session.exitReason = "idle_timeout";
        session.updatedAt = new Date();
        session.revision++;
        this.registryRevision++;
        this.emitState(session);
        this.startStopWatchdog(session, 5_000, 1_000);
        try {
          session.ptyProcess?.kill();
        } catch {}
      }
    }

    // 2. TTL retention check for exited / error sessions
    for (const session of [...this.sessions.values()]) {
      if (["exited", "error"].includes(session.state) && now - session.updatedAt.getTime() > this.config.sessionRetentionMs) {
        this.removeSession(session.id);
      }
    }

    // 3. Max retained sessions limit (50) for exited / error sessions
    const retained = [...this.sessions.values()]
      .filter((s) => ["exited", "error"].includes(s.state))
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());

    if (retained.length > this.config.maxRetainedSessions) {
      const excessCount = retained.length - this.config.maxRetainedSessions;
      for (let i = 0; i < excessCount; i++) {
        this.removeSession(retained[i].id);
      }
    }
  }

  private emitState(session: SessionRecord): void {
    this.events.emit("state", session.id, this.toPublic(session));
  }

  toPublic(session: SessionRecord): PublicSession {
    return {
      id: session.id,
      name: session.name,
      agentId: session.agent.id,
      agentLabel: session.agent.label,
      projectId: session.project.id,
      projectLabel: session.project.label,
      rootProjectLabel: session.rootProjectLabel,
      subpath: session.subpath,
      workingDirectoryId: session.workingDirectoryId,
      workingDirectoryLabel: session.workingDirectoryLabel,
      state: session.state,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
      revision: session.revision,
      outputLastSeq: session.terminalState ? session.terminalState.currentSeq : session.outputLastSeq,
      replacedFromSessionId: session.replacedFromSessionId,
      replacementSessionId: session.replacementSessionId,
      stopTimedOut: session.stopTimedOut,
      attention: session.attention,
      exitReason: session.exitReason,
      exitCode: session.exitCode,
      signal: session.signal,
      error: session.error
    };
  }
}
