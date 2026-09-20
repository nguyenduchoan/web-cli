import crypto from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { PublicSession, SessionManager } from "./sessionManager.js";
import type { WebAuth } from "./webAuth.js";
import { chunkUnicodeString, type SnapshotResult } from "./terminalState.js";

const wsInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(8192) }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(20).max(300),
    rows: z.number().int().min(5).max(120)
  }),
  z.object({ type: z.literal("ping"), nonce: z.string().max(128).optional() })
]);

type TicketRecord = {
  sessionId: string;
  expiresAt: number;
  authKey: string;
  protocolVersion: 1 | 2;
};

type ClientRole = "controller" | "viewer";

type AttachedClient = {
  ws: WebSocket;
  authKey: string;
  protocolVersion: 1 | 2;
  role: ClientRole;
  attachedAt: number;
  syncComplete: boolean;
  syncId?: string;
  liveQueue: Array<Record<string, unknown>>;
  cleaned: boolean;
};

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.end(`HTTP/1.1 ${statusCode} ${message}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  const deadline = setTimeout(() => socket.destroy(), 1000);
  deadline.unref();
  socket.once("close", () => clearTimeout(deadline));
}

function parseUrl(request: IncomingMessage): URL | undefined {
  try {
    return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  } catch {
    return undefined;
  }
}

export class WebSocketBridge {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly socketAuth = new WeakMap<WebSocket, string>();
  private readonly clientsBySession = new Map<string, AttachedClient[]>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly maxPendingTickets: number;
  private started = false;
  private closing = false;

  constructor(
    private readonly server: Server,
    private readonly config: AppConfig,
    private readonly sessions: SessionManager,
    private readonly auth: WebAuth,
    private readonly logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void } = { info() {}, warn() {}, error() {} }
  ) {
    this.maxPendingTickets = Math.max(16, config.maxWebsocketConnections * 4);
    this.cleanupTimer = setInterval(() => this.cleanupExpiredTickets(), Math.max(10_000, config.websocketTicketTtlMs));
    this.cleanupTimer.unref();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.server.on("upgrade", this.handleUpgrade);
  }

  issueTicket(sessionId: string, authKey: string, protocolVersion: 1 | 2 = 1): { ticket: string; expiresAt: string; protocolVersion: number } {
    this.cleanupExpiredTickets();
    while (this.tickets.size >= this.maxPendingTickets) {
      const oldest = this.tickets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tickets.delete(oldest);
    }
    const ticket = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.config.websocketTicketTtlMs;
    this.tickets.set(ticket, { sessionId, expiresAt, authKey, protocolVersion });
    return { ticket, expiresAt: new Date(expiresAt).toISOString(), protocolVersion };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.cleanupTimer);
    this.server.off("upgrade", this.handleUpgrade);
    this.tickets.clear();

    for (const client of this.wss.clients) {
      try {
        client.close(1001, "Server shutting down");
      } catch {}
    }

    // Give 1 second for graceful close, then terminate remaining
    const terminationTimer = setTimeout(() => {
      for (const client of this.wss.clients) {
        try {
          client.terminate();
        } catch {}
      }
    }, 1000);
    terminationTimer.unref();

    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        clearTimeout(terminationTimer);
        resolve();
      });
      if (this.wss.clients.size === 0) {
        clearTimeout(terminationTimer);
        resolve();
      }
    });

    this.clientsBySession.clear();
  }

  private readonly handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (this.closing) {
      rejectUpgrade(socket, 503, "Server Shutting Down");
      return;
    }

    const url = parseUrl(request);
    const match = url?.pathname.match(/^(?:\/(?:api\/)?web-cli)?\/api\/sessions\/([^/]+)\/ws$/);
    if (!url || !match) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    if (!this.isAllowedOrigin(request)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    if (this.wss.clients.size >= this.config.maxWebsocketConnections) {
      rejectUpgrade(socket, 503, "Capacity Reached");
      return;
    }

    let sessionId: string;
    try {
      sessionId = decodeURIComponent(match[1]);
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }

    const authKey = this.auth.sessionKey(request);
    const protocols = request.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((value) => value.trim()) ?? [];
    const ticket = protocols.find((value) => value.startsWith("ticket."))?.slice(7);

    if (!authKey || !this.auth.valid(authKey) || !ticket) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const ticketRecord = this.consumeTicket(ticket, sessionId, authKey);
    if (!ticketRecord) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const session = this.sessions.getSession(sessionId);
    if (!session) {
      rejectUpgrade(socket, 404, "Session Not Found");
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.attach(ws, session, authKey, ticketRecord.protocolVersion);
    });
  };

  private isAllowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return false;
    const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "").split(",", 1)[0].trim();
    const protocol = forwardedProtocol === "https" ? "https" : "http";
    const sameOrigin = request.headers.host ? `${protocol}://${request.headers.host}` : "";
    return origin === sameOrigin || this.config.clientOrigins.includes(origin);
  }

  private consumeTicket(ticket: string, sessionId: string, authKey: string): TicketRecord | undefined {
    const record = this.tickets.get(ticket);
    if (!record) return undefined;
    this.tickets.delete(ticket);
    if (record.sessionId === sessionId && record.expiresAt >= Date.now() && record.authKey === authKey) {
      return record;
    }
    return undefined;
  }

  private cleanupExpiredTickets(): void {
    const now = Date.now();
    for (const [ticket, record] of this.tickets) {
      if (record.expiresAt < now) this.tickets.delete(ticket);
    }
  }

  private sendJson(ws: WebSocket, payload: unknown): boolean {
    if (!this.auth.valid(this.socketAuth.get(ws))) {
      ws.close(4001, "Authentication expired");
      return false;
    }
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > this.config.maxWebsocketBufferedBytes) {
      ws.close(1013, "Client is too slow");
      return false;
    }
    ws.send(JSON.stringify(payload));
    return true;
  }

  private attach(ws: WebSocket, session: PublicSession, authKey: string, protocolVersion: 1 | 2): void {
    this.socketAuth.set(ws, authKey);
    const sessionId = session.id;
    const serverEpoch = this.sessions.getServerEpoch();

    // Determine controller vs viewer role
    let clients = this.clientsBySession.get(sessionId);
    if (!clients) {
      clients = [];
      this.clientsBySession.set(sessionId, clients);
    }

    const hasController = clients.some((c) => c.role === "controller");
    const role: ClientRole = hasController ? "viewer" : "controller";

    const clientRecord: AttachedClient = {
      ws,
      authKey,
      protocolVersion,
      role,
      attachedAt: Date.now(),
      syncComplete: protocolVersion === 1,
      liveQueue: [],
      cleaned: false
    };
    clients.push(clientRecord);

    let alive = true;
    let messageWindowStartedAt = Date.now();
    let messageCount = 0;
    let messageBytes = 0;

    this.wss.emit("connection", ws);

    const authTimer = setInterval(() => {
      if (!this.auth.valid(authKey)) ws.close(4001, "Authentication expired");
    }, 5_000);
    authTimer.unref();

    ws.on("pong", () => {
      alive = true;
    });

    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 30_000);
    heartbeat.unref();

    // Cleanup handler on close/error/promote
    const cleanup = () => {
      if (clientRecord.cleaned) return;
      clientRecord.cleaned = true;
      clearInterval(heartbeat);
      clearInterval(authTimer);

      offOutput();
      offOutputV2();
      offResize();
      offState();
      offExit();
      offRemoved();
      offAttention();

      // Remove from session clients
      const currentClients = this.clientsBySession.get(sessionId);
      if (currentClients) {
        const idx = currentClients.indexOf(clientRecord);
        if (idx !== -1) currentClients.splice(idx, 1);

        // If this client was controller, promote the oldest remaining client
        if (clientRecord.role === "controller" && currentClients.length > 0) {
          const nextController = currentClients[0];
          nextController.role = "controller";
          if (nextController.protocolVersion === 2) {
            this.sendJson(nextController.ws, {
              type: "control",
              sessionId,
              serverEpoch,
              role: "controller"
            });
          }
        }

        if (currentClients.length === 0) {
          this.clientsBySession.delete(sessionId);
        }
      }
    };

    ws.once("close", cleanup);
    ws.once("error", cleanup);

    // Event listeners from SessionManager
    const offOutput = this.sessions.onOutput((changedSessionId, data) => {
      if (changedSessionId !== sessionId) return;
      if (protocolVersion === 1) {
        this.sendJson(ws, { type: "output", data });
      }
    });

    const offOutputV2 = this.sessions.onOutputV2((changedSessionId, seq, data) => {
      if (changedSessionId !== sessionId || protocolVersion !== 2) return;
      const msg = { type: "output", sessionId, serverEpoch, seq, data };
      if (!clientRecord.syncComplete) {
        clientRecord.liveQueue.push(msg);
      } else {
        this.sendJson(ws, msg);
      }
    });

    const offResize = this.sessions.onTerminalResize((changedSessionId, seq, cols, rows) => {
      if (changedSessionId !== sessionId || protocolVersion !== 2) return;
      const msg = { type: "terminal_resize", sessionId, serverEpoch, seq, cols, rows };
      if (!clientRecord.syncComplete) {
        clientRecord.liveQueue.push(msg);
      } else {
        this.sendJson(ws, msg);
      }
    });

    const offState = this.sessions.onState((changedSessionId, nextSession) => {
      if (changedSessionId !== sessionId) return;
      if (protocolVersion === 1) {
        this.sendJson(ws, { type: "state", session: nextSession });
      } else {
        const msg = {
          type: "state",
          sessionId,
          serverEpoch,
          registryRevision: this.sessions.getRegistryRevision(),
          session: nextSession
        };
        if (!clientRecord.syncComplete) {
          clientRecord.liveQueue.push(msg);
        } else {
          this.sendJson(ws, msg);
        }
      }
    });

    const offExit = this.sessions.onExit((changedSessionId, exitCode, signal) => {
      if (changedSessionId !== sessionId) return;
      if (protocolVersion === 1) {
        this.sendJson(ws, { type: "exit", exitCode, signal });
      } else {
        const currentSession = this.sessions.getSession(sessionId);
        const msg = {
          type: "exit",
          sessionId,
          serverEpoch,
          registryRevision: this.sessions.getRegistryRevision(),
          session: currentSession
        };
        if (!clientRecord.syncComplete) {
          clientRecord.liveQueue.push(msg);
        } else {
          this.sendJson(ws, msg);
        }
      }
    });

    const offRemoved = this.sessions.onRemoved((changedSessionId) => {
      if (changedSessionId !== sessionId) return;
      if (protocolVersion === 2) {
        this.sendJson(ws, {
          type: "removed",
          sessionId,
          serverEpoch,
          registryRevision: this.sessions.getRegistryRevision()
        });
      }
      ws.close(4004, "Session removed");
    });

    const offAttention = this.sessions.onAttention((changedSessionId, attention) => {
      if (changedSessionId !== sessionId || protocolVersion !== 2) return;
      const msg = {
        type: "attention",
        sessionId,
        serverEpoch,
        eventId: attention.eventId,
        createdAt: attention.createdAt
      };
      if (!clientRecord.syncComplete) {
        clientRecord.liveQueue.push(msg);
      } else {
        this.sendJson(ws, msg);
      }
    });

    // Start protocol handshake
    if (protocolVersion === 1) {
      // Protocol v1: legacy
      this.sendJson(ws, { type: "state", session });
      const outputBuffer = this.sessions.getOutputBuffer(sessionId);
      if (outputBuffer) {
        this.sendJson(ws, { type: "output", data: outputBuffer });
      }
    } else {
      // Protocol v2: snapshot synchronization
      const terminalState = this.sessions.getTerminalState(sessionId);
      const syncId = crypto.randomUUID();
      clientRecord.syncId = syncId;

      const syncDeadline = setTimeout(() => {
        if (!clientRecord.syncComplete && !clientRecord.cleaned) {
          ws.close(1013, "Sync deadline exceeded");
        }
      }, 10_000);
      syncDeadline.unref();

      const snapshotPromise: Promise<SnapshotResult> = ["exited", "error"].includes(session.state)
        ? (terminalState ? terminalState.finalizeOnExit() : Promise.resolve({
            baseSeq: 0,
            cols: 100,
            rows: 30,
            data: "",
            historyTruncated: false
          }))
        : (terminalState ? terminalState.createSnapshotBarrier() : Promise.resolve({
            baseSeq: 0,
            cols: 100,
            rows: 30,
            data: "",
            historyTruncated: false
          }));

      snapshotPromise
        .then((snapshot) => {
          if (clientRecord.cleaned || ws.readyState !== WebSocket.OPEN) return;

          // 1. Send sync_start
          this.sendJson(ws, {
            type: "sync_start",
            sessionId,
            serverEpoch,
            syncId,
            session: this.sessions.getSession(sessionId),
            baseSeq: snapshot.baseSeq,
            cols: snapshot.cols,
            rows: snapshot.rows,
            control: clientRecord.role,
            historyTruncated: snapshot.historyTruncated
          });

          // 2. Send snapshot chunks (<= 16 KiB UTF-8)
          const chunks = chunkUnicodeString(snapshot.data, 16 * 1024);
          for (let i = 0; i < chunks.length; i++) {
            this.sendJson(ws, {
              type: "snapshot_chunk",
              sessionId,
              serverEpoch,
              syncId,
              index: i,
              data: chunks[i]
            });
          }

          // 3. Send sync_end
          this.sendJson(ws, {
            type: "sync_end",
            sessionId,
            serverEpoch,
            syncId,
            baseSeq: snapshot.baseSeq,
            chunkCount: chunks.length
          });

          clearTimeout(syncDeadline);
          clientRecord.syncComplete = true;

          // 4. Drain queued live operations with seq > baseSeq
          const queued = clientRecord.liveQueue;
          clientRecord.liveQueue = [];
          for (const msg of queued) {
            if (msg.type === "output" || msg.type === "terminal_resize") {
              const seq = msg.seq as number;
              if (seq > snapshot.baseSeq) {
                this.sendJson(ws, msg);
              }
            } else {
              this.sendJson(ws, msg);
            }
          }
        })
        .catch((err) => {
          clearTimeout(syncDeadline);
          this.logger.error({ sessionId, error: String(err) }, "Failed to generate snapshot for sync");
          this.sendJson(ws, {
            type: "error",
            sessionId,
            serverEpoch,
            code: "terminal_snapshot_too_large",
            message: "Terminal snapshot exceeds limit"
          });
          ws.close(1011, "Snapshot error");
        });
    }

    // Message handler
    ws.on("message", (raw) => {
      if (!this.auth.valid(authKey)) {
        ws.close(4001, "Authentication expired");
        return;
      }

      const now = Date.now();
      if (now - messageWindowStartedAt >= 1_000) {
        messageWindowStartedAt = now;
        messageCount = 0;
        messageBytes = 0;
      }
      messageCount += 1;
      messageBytes += Buffer.byteLength(raw.toString());
      if (messageCount > 200 || messageBytes > 256 * 1024) {
        ws.close(1008, "Input rate exceeded");
        return;
      }

      try {
        const parsed = wsInputSchema.parse(JSON.parse(raw.toString()));
        if (parsed.type === "input") {
          this.auth.valid(authKey, true);

          // Viewer guard (Section 7.7)
          if (clientRecord.role === "viewer") {
            this.sendJson(ws, {
              type: "error",
              sessionId,
              serverEpoch,
              code: "control_locked",
              message: "Terminal input is locked because another connection is controlling this session"
            });
            return;
          }

          if (!clientRecord.syncComplete) {
            // Cannot send input while sync is underway
            return;
          }

          if (!this.sessions.writeInput(sessionId, parsed.data)) {
            this.sendJson(ws, {
              type: "error",
              sessionId,
              serverEpoch,
              code: "session_not_running",
              message: "Session is not running"
            });
          }
          return;
        }

        if (parsed.type === "resize") {
          // Viewer guard
          if (clientRecord.role === "viewer") {
            this.sendJson(ws, {
              type: "error",
              sessionId,
              serverEpoch,
              code: "control_locked",
              message: "Terminal resize is locked because another connection is controlling this session"
            });
            return;
          }

          if (!clientRecord.syncComplete) {
            return;
          }

          this.sessions.resize(sessionId, parsed.cols, parsed.rows);
          return;
        }

        if (parsed.type === "ping") {
          this.sendJson(ws, { type: "pong", ts: Date.now(), nonce: parsed.nonce });
        }
      } catch {
        this.sendJson(ws, {
          type: "error",
          sessionId,
          serverEpoch,
          code: "invalid_payload",
          message: "Invalid WebSocket payload"
        });
      }
    });
  }
}
