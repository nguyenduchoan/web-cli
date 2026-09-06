import crypto from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { PublicSession, SessionManager } from "./sessionManager.js";
import type { WebAuth } from "./webAuth.js";

const wsInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(8192) }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(20).max(300),
    rows: z.number().int().min(5).max(120)
  }),
  z.object({ type: z.literal("ping"), nonce: z.string().max(128).optional() })
]);

type TicketRecord = { sessionId: string; expiresAt: number; authKey: string };

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
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
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly maxPendingTickets: number;
  private started = false;

  constructor(
    private readonly server: Server,
    private readonly config: AppConfig,
    private readonly sessions: SessionManager,
    private readonly auth: WebAuth
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

  issueTicket(sessionId: string, authKey: string): { ticket: string; expiresAt: string } {
    this.cleanupExpiredTickets();
    while (this.tickets.size >= this.maxPendingTickets) {
      const oldest = this.tickets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tickets.delete(oldest);
    }
    const ticket = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.config.websocketTicketTtlMs;
    this.tickets.set(ticket, { sessionId, expiresAt, authKey });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer);
    this.server.off("upgrade", this.handleUpgrade);
    this.tickets.clear();
    for (const client of this.wss.clients) client.close(1001, "Server shutting down");
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
      if (this.wss.clients.size === 0) resolve();
    });
  }

  private readonly handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
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
    const ticket = request.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim()).find((value) => value.startsWith("ticket."))?.slice(7);
    if (!authKey || !this.auth.valid(authKey) || !ticket || !this.consumeTicket(ticket, sessionId, authKey)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const session = this.sessions.getSession(sessionId);
    if (!session) {
      rejectUpgrade(socket, 404, "Session Not Found");
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => this.attach(ws, session, authKey));
  };

  private isAllowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return false;
    const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "").split(",", 1)[0].trim();
    const protocol = forwardedProtocol === "https" ? "https" : "http";
    const sameOrigin = request.headers.host ? `${protocol}://${request.headers.host}` : "";
    return origin === sameOrigin || this.config.clientOrigins.includes(origin);
  }

  private consumeTicket(ticket: string, sessionId: string, authKey: string): boolean {
    const record = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return Boolean(record && record.sessionId === sessionId && record.expiresAt >= Date.now() && record.authKey === authKey);
  }

  private cleanupExpiredTickets(): void {
    const now = Date.now();
    for (const [ticket, record] of this.tickets) {
      if (record.expiresAt < now) this.tickets.delete(ticket);
    }
  }

  private sendJson(ws: WebSocket, payload: unknown): boolean {
    if (!this.auth.valid(this.socketAuth.get(ws))) { ws.close(4001, "Authentication expired"); return false; }
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > this.config.maxWebsocketBufferedBytes) {
      ws.close(1013, "Client is too slow");
      return false;
    }
    ws.send(JSON.stringify(payload));
    return true;
  }

  private attach(ws: WebSocket, session: PublicSession, authKey: string): void {
    this.socketAuth.set(ws, authKey);
    const sessionId = session.id;
    let alive = true;
    let cleaned = false;
    let messageWindowStartedAt = Date.now();
    let messageCount = 0;
    let messageBytes = 0;

    this.wss.emit("connection", ws);
    const authTimer = setInterval(() => { if (!this.auth.valid(authKey)) ws.close(4001, "Authentication expired"); }, 5_000);
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

    this.sendJson(ws, { type: "state", session });
    const outputBuffer = this.sessions.getOutputBuffer(sessionId);
    if (outputBuffer) this.sendJson(ws, { type: "output", data: outputBuffer });

    const offOutput = this.sessions.onOutput((changedSessionId, data) => {
      if (changedSessionId === sessionId) this.sendJson(ws, { type: "output", data });
    });
    const offState = this.sessions.onState((changedSessionId, nextSession) => {
      if (changedSessionId === sessionId) this.sendJson(ws, { type: "state", session: nextSession });
    });
    const offExit = this.sessions.onExit((changedSessionId, exitCode, signal) => {
      if (changedSessionId === sessionId) this.sendJson(ws, { type: "exit", exitCode, signal });
    });

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      clearInterval(authTimer);
      offOutput();
      offState();
      offExit();
    };

    ws.on("message", (raw) => {
      if (!this.auth.valid(authKey)) { ws.close(4001, "Authentication expired"); return; }
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
          if (!this.sessions.writeInput(sessionId, parsed.data)) {
            this.sendJson(ws, { type: "error", message: "Session is not running" });
          }
          return;
        }
        if (parsed.type === "resize") {
          this.sessions.resize(sessionId, parsed.cols, parsed.rows);
          return;
        }
        this.sendJson(ws, { type: "pong", ts: Date.now(), nonce: parsed.nonce });
      } catch {
        this.sendJson(ws, { type: "error", message: "Invalid WebSocket payload" });
      }
    });

    ws.once("close", cleanup);
    ws.once("error", cleanup);
  }
}
