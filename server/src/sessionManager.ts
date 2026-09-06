import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import * as pty from "node-pty";
import type { AgentConfig, AppConfig, ProjectConfig } from "./config.js";

export type SessionState = "idle" | "running" | "stopping" | "exited" | "error";

export type PublicSession = {
  id: string;
  agentId: string;
  agentLabel: string;
  projectId: string;
  projectLabel: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
  exitCode?: number;
  signal?: number;
  error?: string;
};

type SessionRecord = {
  id: string;
  agent: AgentConfig;
  project: ProjectConfig;
  state: SessionState;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
  exitCode?: number;
  signal?: number;
  error?: string;
  ptyProcess?: pty.IPty;
  outputBuffer: string;
  exitPromise: Promise<void>;
  resolveExit: () => void;
};

type OutputListener = (sessionId: string, data: string) => void;
type StateListener = (sessionId: string, session: PublicSession) => void;
type ExitListener = (sessionId: string, exitCode?: number, signal?: number) => void;
type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export class SessionCapacityError extends Error {
  readonly statusCode = 429;
  readonly code = "session_capacity_reached";

  constructor(maxSessions: number) {
    super(`Maximum of ${maxSessions} active sessions reached`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly events = new EventEmitter();
  private readonly cleanupTimer: NodeJS.Timeout;
  private closing = false;

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {
    this.events.setMaxListeners(config.maxWebsocketConnections * 3 + 10);
    const interval = Math.max(30_000, Math.min(60_000, config.sessionIdleTtlMs));
    this.cleanupTimer = setInterval(() => this.sweep(), interval);
    this.cleanupTimer.unref();
  }

  createSession(input: {
    agent: AgentConfig;
    project: ProjectConfig;
    cols?: number;
    rows?: number;
  }): PublicSession {
    if (this.closing) throw new Error("Session manager is shutting down");
    this.sweep();
    const activeCount = [...this.sessions.values()]
      .filter((session) => ["idle", "running", "stopping"].includes(session.state)).length;
    if (activeCount >= this.config.maxSessions) {
      throw new SessionCapacityError(this.config.maxSessions);
    }

    const now = new Date();
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const session: SessionRecord = {
      id: crypto.randomUUID(),
      agent: input.agent,
      project: input.project,
      state: "idle",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      outputBuffer: "",
      exitPromise,
      resolveExit
    };

    this.sessions.set(session.id, session);
    this.start(session, input.cols, input.rows);
    return this.toPublic(session);
  }

  getSession(sessionId: string): PublicSession | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.toPublic(session) : undefined;
  }

  listSessions(): PublicSession[] {
    return [...this.sessions.values()].map((session) => this.toPublic(session)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getOutputBuffer(sessionId: string): string {
    return this.sessions.get(sessionId)?.outputBuffer ?? "";
  }

  killSession(sessionId: string): PublicSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    this.requestStop(session, "API kill request");
    return this.toPublic(session);
  }

  async restartSession(sessionId: string, cols?: number, rows?: number): Promise<PublicSession | undefined> {
    const previous = this.sessions.get(sessionId);
    if (!previous) return undefined;
    await this.stopAndWait(previous, 5_000);
    return this.createSession({ agent: previous.agent, project: previous.project, cols, rows });
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
    session.lastActivityAt = new Date();
    session.ptyProcess.resize(cols, rows);
    return true;
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

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.cleanupTimer);
    const active = [...this.sessions.values()].filter((session) => session.ptyProcess);
    await Promise.all(active.map((session) => this.stopAndWait(session, this.config.shutdownTimeoutMs)));
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

  private start(session: SessionRecord, cols = 100, rows = 30): void {
    try {
      this.logger.info(
        { sessionId: session.id, agentId: session.agent.id, projectId: session.project.id, cwd: session.project.path },
        "Starting PTY session"
      );

      const ptyProcess = pty.spawn(session.agent.command, session.agent.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: session.project.path,
        env: this.buildChildEnvironment()
      });

      session.ptyProcess = ptyProcess;
      session.state = "running";
      session.updatedAt = new Date();
      session.lastActivityAt = new Date();
      this.emitState(session);

      ptyProcess.onData((data) => {
        session.lastActivityAt = new Date();
        session.outputBuffer += data;
        if (session.outputBuffer.length > this.config.outputBufferLimit) {
          session.outputBuffer = session.outputBuffer.slice(-this.config.outputBufferLimit);
        }
        if (this.config.logTerminalOutput) {
          this.logger.warn({ sessionId: session.id, bytes: Buffer.byteLength(data) }, "Terminal output observed; content logging remains disabled");
        }
        this.events.emit("output", session.id, data);
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        session.state = "exited";
        session.exitCode = exitCode;
        session.signal = signal;
        session.ptyProcess = undefined;
        session.updatedAt = new Date();
        session.resolveExit();
        this.logger.info({ sessionId: session.id, exitCode, signal }, "PTY session exited");
        this.emitState(session);
        this.events.emit("exit", session.id, exitCode, signal);
      });
    } catch (error) {
      session.state = "error";
      session.error = error instanceof Error ? error.message : "Unknown PTY spawn error";
      session.updatedAt = new Date();
      session.resolveExit();
      this.logger.error({ sessionId: session.id, error: session.error }, "Failed to start PTY session");
      this.emitState(session);
    }
  }

  private requestStop(session: SessionRecord, reason: string): void {
    if (!session.ptyProcess || !["running", "stopping"].includes(session.state)) return;
    if (session.state !== "stopping") {
      session.state = "stopping";
      session.updatedAt = new Date();
      this.emitState(session);
      this.logger.info({ sessionId: session.id, agentId: session.agent.id, reason }, "Stopping PTY session");
    }
    try {
      session.ptyProcess.kill();
    } catch (error) {
      this.logger.warn({ sessionId: session.id, error: error instanceof Error ? error.message : String(error) }, "PTY stop signal failed");
    }
  }

  private async stopAndWait(session: SessionRecord, timeoutMs: number): Promise<void> {
    if (!session.ptyProcess) return;
    this.requestStop(session, "shutdown or restart");
    await Promise.race([session.exitPromise, delay(timeoutMs)]);
    if (!session.ptyProcess) return;
    this.logger.warn({ sessionId: session.id }, "PTY did not stop in time; sending SIGKILL");
    try {
      session.ptyProcess.kill("SIGKILL");
    } catch {
      // The process may have exited between the timeout and the signal.
    }
    await Promise.race([session.exitPromise, delay(1_000)]);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.state === "running" && now - session.lastActivityAt.getTime() > this.config.sessionIdleTtlMs) {
        this.requestStop(session, "idle timeout");
        continue;
      }
      if (["exited", "error"].includes(session.state) && now - session.updatedAt.getTime() > this.config.sessionRetentionMs) {
        this.sessions.delete(id);
      }
    }
  }

  private emitState(session: SessionRecord): void {
    this.events.emit("state", session.id, this.toPublic(session));
  }

  private toPublic(session: SessionRecord): PublicSession {
    return {
      id: session.id,
      agentId: session.agent.id,
      agentLabel: session.agent.label,
      projectId: session.project.id,
      projectLabel: session.project.label,
      state: session.state,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      exitCode: session.exitCode,
      signal: session.signal,
      error: session.error
    };
  }
}
