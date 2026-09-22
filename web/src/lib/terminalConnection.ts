import { ApiError, buildWsUrl, createWsTicket } from "./api.js";
import { ReconnectManager } from "./reconnectPolicy.js";
import { TerminalSyncController } from "./terminalSync.js";
import { XtermOperationQueue } from "./xtermOperationQueue.js";
import type { ServerMessageV2, Session } from "./types.js";

const WS_CONNECTING = 0;
const WS_OPEN = 1;

export type TerminalConnectionCallbacks = {
  onConnectedChange: (connected: boolean, control?: "controller" | "viewer") => void;
  onSessionUpdate?: (session: Session, registryRevision?: number, serverEpoch?: string) => void;
  onAttention?: (event: { sessionId: string; eventId: string; createdAt: string }) => void;
  onError: (message: string) => void;
  onSessionMissing?: (sessionId: string) => void;
  onReconnectExhausted?: (sessionId: string) => void;
  onAuthExpired?: () => void;
  onRoleChange?: (role: "controller" | "viewer") => void;
  onSyncingChange?: (syncing: boolean) => void;
  onResizeRequired?: () => void;
  writeTerminal: (data: string) => Promise<void>;
  resetTerminal: () => void;
  resizeTerminal: (cols: number, rows: number) => void;
  writelnTerminal?: (data: string) => void;
};

export type TerminalConnectionOptions = {
  sessionId: string;
  queue: XtermOperationQueue;
  callbacks: TerminalConnectionCallbacks;
  reconnectManager?: ReconnectManager;
  createTicket?: (sessionId: string) => Promise<{ ticket: string }>;
  createWebSocket?: (url: string, protocols: string[]) => WebSocket;
  setTimeoutFn?: (callback: () => void, ms: number) => any;
  clearTimeoutFn?: (id: any) => void;
  setIntervalFn?: (callback: () => void, ms: number) => any;
  clearIntervalFn?: (id: any) => void;
  randomJitterFn?: () => number;
};

export class TerminalConnectionSession {
  public sessionId: string;
  public queue: XtermOperationQueue;
  public callbacks: TerminalConnectionCallbacks;
  public reconnectManager: ReconnectManager;

  private createTicket: (sessionId: string) => Promise<{ ticket: string }>;
  private createWebSocket: (url: string, protocols: string[]) => WebSocket;
  private setTimeoutFn: (callback: () => void, ms: number) => any;
  private clearTimeoutFn: (id: any) => void;
  private setIntervalFn: (callback: () => void, ms: number) => any;
  private clearIntervalFn: (id: any) => void;
  private randomJitterFn: () => number;

  public attemptGeneration = 0;
  public currentSyncCtrl: TerminalSyncController | undefined;
  public ws: WebSocket | undefined;
  public stopped = false;
  public connecting = false;
  public connected = false;
  public syncing = false;
  public syncComplete = false;
  public role: "controller" | "viewer" = "viewer";

  private retryTimer: any = undefined;
  private cleanupCurrentAttempt: (() => void) | undefined;
  private disposed = false;
  private lastMessageTime = Date.now();

  constructor(options: TerminalConnectionOptions) {
    this.sessionId = options.sessionId;
    this.queue = options.queue;
    this.callbacks = options.callbacks;
    this.reconnectManager = options.reconnectManager ?? new ReconnectManager();

    this.createTicket =
      options.createTicket ??
      ((sid: string) => createWsTicket("", sid, { protocolVersion: 2 }));
    this.createWebSocket =
      options.createWebSocket ??
      ((url: string, protocols: string[]) => new WebSocket(url, protocols));
    this.setTimeoutFn = options.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((id) => clearTimeout(id));
    this.setIntervalFn = options.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((id) => clearInterval(id));
    this.randomJitterFn = options.randomJitterFn ?? (() => Math.random() * 400);
  }

  private setConnected(connected: boolean): void {
    this.connected = connected;
    this.callbacks.onConnectedChange(connected, this.role);
  }

  private setSyncing(syncing: boolean): void {
    this.syncing = syncing;
    this.callbacks.onSyncingChange?.(syncing);
  }

  public send(payload: unknown): boolean {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  public start(): void {
    if (this.stopped) return;
    void this.connect();
  }

  public manualReconnect(): void {
    // Manual retry is only valid once the previous attempt has released its socket.
    if (this.disposed || this.connecting || this.ws) return;
    this.stopped = false;
    this.reconnectManager.onManualReconnect();
    this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = undefined;
    void this.connect();
  }

  public async connect(): Promise<void> {
    // The close handler releases ownership, including CLOSED before its event is delivered.
    // Browser resume events must also respect an already scheduled backoff.
    if (this.stopped || this.connecting || this.ws || this.retryTimer !== undefined) return;
    this.connecting = true;
    this.setConnected(false);

    const currentAttempt = ++this.attemptGeneration;
    this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = undefined;

    try {
      const { ticket } = await this.createTicket(this.sessionId);
      if (this.stopped || this.attemptGeneration !== currentAttempt) return;

      const ws = this.createWebSocket(buildWsUrl(this.sessionId), ["web-cli", `ticket.${ticket}`]);
      this.ws = ws;

      let heartbeatTimer: any = undefined;
      let openTimeout: any = undefined;
      const ownsAttempt = () =>
        !this.stopped && this.attemptGeneration === currentAttempt && this.ws === ws;
      const clearOpenTimeout = () => {
        if (openTimeout !== undefined) this.clearTimeoutFn(openTimeout);
        openTimeout = undefined;
      };
      const cleanupAttempt = () => {
        clearOpenTimeout();
        if (heartbeatTimer !== undefined) this.clearIntervalFn(heartbeatTimer);
        heartbeatTimer = undefined;
        if (this.cleanupCurrentAttempt === cleanupAttempt) this.cleanupCurrentAttempt = undefined;
      };
      this.cleanupCurrentAttempt = cleanupAttempt;
      openTimeout = this.setTimeoutFn(() => {
        if (!ownsAttempt() || openTimeout === undefined || ws.readyState !== WS_CONNECTING) return;
        try {
          ws.close();
        } catch {}
      }, 10_000);

      const attemptQueueGen = this.queue.invalidate();

      const syncCtrl = new TerminalSyncController({
        sessionId: this.sessionId,
        generation: attemptQueueGen,
        queue: this.queue,
        writeTerminal: async (data) => {
          if (this.stopped || this.attemptGeneration !== currentAttempt) {
            return;
          }
          await this.callbacks.writeTerminal(data);
        },
        resetTerminal: () => {
          this.callbacks.resetTerminal();
        },
        resizeTerminal: (cols, rows) => {
          this.callbacks.resizeTerminal(cols, rows);
        },
        onSyncComplete: (syncedRole) => {
          if (
            this.stopped ||
            this.attemptGeneration !== currentAttempt ||
            this.ws !== ws ||
            ws.readyState !== 1
          ) {
            return;
          }
          this.reconnectManager.onSyncSuccess();
          this.syncComplete = true;
          this.role = syncedRole;
          this.callbacks.onRoleChange?.(syncedRole);
          this.setSyncing(false);
          this.setConnected(true);
          if (syncedRole === "controller") {
            this.callbacks.onResizeRequired?.();
          }
        },
        onMismatchOrGap: () => {
          if (this.stopped || this.attemptGeneration !== currentAttempt) return;
          this.attemptGeneration += 1;
          syncCtrl.invalidate();
          this.syncComplete = false;
          this.setSyncing(false);
          this.setConnected(false);
          try {
            ws.close();
          } catch {}
        }
      });
      this.currentSyncCtrl = syncCtrl;

      ws.addEventListener("open", () => {
        clearOpenTimeout();
        if (!ownsAttempt()) {
          try {
            ws.close();
          } catch {}
          return;
        }

        this.connecting = false;
        this.lastMessageTime = Date.now();

        if (heartbeatTimer !== undefined) this.clearIntervalFn(heartbeatTimer);
        heartbeatTimer = this.setIntervalFn(() => {
          if (!ownsAttempt() || ws.readyState !== WS_OPEN) return;
          if (Date.now() - this.lastMessageTime > 35_000) {
            try {
              ws.close();
            } catch {}
          } else {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 15_000);
      });

      ws.addEventListener("message", (event) => {
        if (this.stopped || this.attemptGeneration !== currentAttempt || this.ws !== ws) return;
        this.lastMessageTime = Date.now();

        try {
          const message = JSON.parse(String(event.data)) as ServerMessageV2;
          switch (message.type) {
            case "sync_start": {
              this.syncComplete = false;
              this.setSyncing(true);
              this.setConnected(false);
              this.role = message.control;
              this.callbacks.onRoleChange?.(message.control);
              this.callbacks.onConnectedChange(false, message.control);
              syncCtrl.handleSyncStart(message);
              break;
            }

            case "snapshot_chunk": {
              syncCtrl.handleSnapshotChunk(message);
              break;
            }

            case "sync_end": {
              void syncCtrl.handleSyncEnd(message);
              break;
            }

            case "output": {
              syncCtrl.handleOutput(message);
              break;
            }

            case "terminal_resize": {
              syncCtrl.handleTerminalResize(message);
              break;
            }

            case "control": {
              syncCtrl.role = message.role;
              this.role = message.role;
              this.callbacks.onRoleChange?.(message.role);
              this.callbacks.onConnectedChange(syncCtrl.syncComplete, message.role);
              if (message.role === "controller" && syncCtrl.syncComplete) {
                this.callbacks.onResizeRequired?.();
              }
              break;
            }

            case "state": {
              this.callbacks.onSessionUpdate?.(
                message.session,
                message.registryRevision,
                message.serverEpoch
              );
              break;
            }

            case "exit": {
              this.callbacks.writelnTerminal?.(
                `\r\n[Phiên đã kết thúc: ${message.exitCode ?? "—"}]`
              );
              if (message.session) {
                this.callbacks.onSessionUpdate?.(
                  message.session,
                  message.registryRevision,
                  message.serverEpoch
                );
              }
              break;
            }

            case "removed": {
              this.callbacks.writelnTerminal?.("\r\n[Phiên đã bị xóa khỏi máy chủ]");
              break;
            }

            case "attention": {
              this.callbacks.onAttention?.({
                sessionId: message.sessionId,
                eventId: message.eventId,
                createdAt: message.createdAt
              });
              break;
            }

            case "error": {
              if (message.code === "control_locked") {
                this.callbacks.onError("Chỉ xem — phiên đang được điều khiển ở thiết bị khác");
              } else {
                this.callbacks.onError(message.message);
              }
              break;
            }

            case "pong":
              break;

            default:
              break;
          }
        } catch {
          this.callbacks.onError("Không đọc được dữ liệu terminal.");
        }
      });

      ws.addEventListener("close", (event) => {
        cleanupAttempt();
        if (this.ws !== ws) return;

        this.ws = undefined;
        if (this.stopped) return;

        this.attemptGeneration += 1;
        syncCtrl.invalidate();

        this.connecting = false;
        this.setSyncing(false);
        this.setConnected(false);
        this.syncComplete = false;

        const decision = this.reconnectManager.handleCloseCode(event.code);
        if (decision.action === "stop") {
          this.stopped = true;
          if (decision.reason === "auth_expired") {
            this.callbacks.onAuthExpired?.();
          } else if (decision.reason === "session_missing") {
            this.callbacks.onSessionMissing?.(this.sessionId);
          } else if (decision.reason === "forbidden") {
            this.callbacks.onError("Không có quyền truy cập phiên (403)");
          } else if (decision.reason === "max_attempts_reached") {
            this.callbacks.onReconnectExhausted?.(this.sessionId);
          }
          return;
        }

        const jitter = this.randomJitterFn();
        this.scheduleRetry(decision.delayMs + jitter);
      });

      ws.addEventListener("error", () => {
        try {
          ws.close();
        } catch {}
      });
    } catch (error) {
      if (this.stopped || this.attemptGeneration !== currentAttempt) return;

      this.attemptGeneration += 1;
      this.connecting = false;
      this.setSyncing(false);
      this.setConnected(false);
      this.syncComplete = false;

      let status = 0;
      let code: string | undefined;
      if (error instanceof ApiError) {
        status = error.status;
        code = error.code;
      }
      const decision = this.reconnectManager.handleTicketError(status, code);
      if (decision.action === "stop") {
        this.stopped = true;
        if (decision.reason === "auth_expired") {
          this.callbacks.onAuthExpired?.();
        } else if (decision.reason === "session_missing") {
          this.callbacks.onSessionMissing?.(this.sessionId);
        } else if (decision.reason === "forbidden") {
          this.callbacks.onError("Không có quyền truy cập phiên (403)");
        } else if (decision.reason === "max_attempts_reached") {
          this.callbacks.onReconnectExhausted?.(this.sessionId);
        }
        return;
      }

      this.callbacks.onError(error instanceof Error ? error.message : "Mất kết nối.");
      const jitter = this.randomJitterFn();
      this.scheduleRetry(decision.delayMs + jitter);
    }
  }

  private scheduleRetry(delayMs: number): void {
    const generation = this.attemptGeneration;
    const timer = this.setTimeoutFn(() => {
      if (this.stopped || this.attemptGeneration !== generation || this.retryTimer !== timer) return;
      this.retryTimer = undefined;
      void this.connect();
    }, delayMs);
    this.retryTimer = timer;
  }

  public dispose(): void {
    this.disposed = true;
    this.stopped = true;
    this.attemptGeneration += 1;
    this.currentSyncCtrl?.invalidate();
    this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = undefined;
    this.cleanupCurrentAttempt?.();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = undefined;
    }
    this.connecting = false;
    this.setConnected(false);
    this.setSyncing(false);
    this.syncComplete = false;
  }
}
