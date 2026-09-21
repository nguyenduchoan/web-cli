import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { ApiError, buildWsUrl, createWsTicket } from "../lib/api";
import { installTerminalTouchScroll } from "../lib/terminalTouchScroll";
import { TerminalSyncController } from "../lib/terminalSync";
import type { ServerMessageV2, Session } from "../lib/types";

export type TerminalPaneHandle = {
  sendInput: (data: string) => boolean;
  focus: () => void;
  copy: () => Promise<boolean>;
  scrollToBottom: () => void;
};

type Props = {
  session?: Session;
  connectionGeneration?: number;
  onSessionUpdate: (session: Session, registryRevision?: number, serverEpoch?: string) => void;
  onConnectedChange: (connected: boolean, control?: "controller" | "viewer") => void;
  onAttention?: (event: { sessionId: string; eventId: string; createdAt: string }) => void;
  onError: (message: string) => void;
  onSessionMissing?: (sessionId: string) => void;
  onReconnectExhausted?: (sessionId: string) => void;
  fontSize: number;
  reconnectKey: number;
};

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(function TerminalPane(
  {
    session,
    connectionGeneration = 0,
    onSessionUpdate,
    onConnectedChange,
    onAttention,
    onError,
    onSessionMissing,
    onReconnectExhausted,
    fontSize,
    reconnectKey
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | undefined>(undefined);
  const resizeRef = useRef<(force?: boolean) => void>(() => {});
  const stopScrollRef = useRef<() => void>(() => {});
  const wsRef = useRef<WebSocket | undefined>(undefined);

  const roleRef = useRef<"controller" | "viewer">("viewer");
  const syncCompleteRef = useRef<boolean>(false);
  const expectedSeqRef = useRef<number>(0);
  const syncIdRef = useRef<string>("");
  const sessionIdRef = useRef<string | undefined>(session?.id);
  sessionIdRef.current = session?.id;

  const [role, setRole] = useState<"controller" | "viewer">("viewer");
  const [connected, setConnected] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);

  function send(payload: unknown): boolean {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  useImperativeHandle(ref, () => ({
    sendInput(data) {
      stopScrollRef.current();
      if (!connected || !syncCompleteRef.current) {
        onError("Chưa kết nối hoặc đang đồng bộ dữ liệu.");
        return false;
      }
      if (roleRef.current !== "controller") {
        onError("Chỉ xem — phiên đang được điều khiển ở thiết bị khác");
        return false;
      }

      if (data.includes("\n") && termRef.current?.modes.bracketedPasteMode) {
        const enter = data.endsWith("\r");
        data = "\x1b[200~" + (enter ? data.slice(0, -1) : data) + "\x1b[201~" + (enter ? "\r" : "");
      }

      if (new TextEncoder().encode(JSON.stringify({ type: "input", data })).length > 16_000) {
        onError("Nội dung quá dài. Hãy chia thành phần nhỏ hơn; bản nháp vẫn được giữ.");
        return false;
      }

      resizeRef.current(true);
      const accepted = send({ type: "input", data });
      if (!accepted) onError("Chưa kết nối. Nội dung chưa được gửi.");
      return accepted;
    },
    focus() {
      termRef.current?.focus();
    },
    scrollToBottom() {
      stopScrollRef.current();
      termRef.current?.scrollToBottom();
    },
    async copy() {
      const term = termRef.current;
      if (!term) return false;
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let i = Math.max(0, buffer.length - 500); i < buffer.length; i++) {
        lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
      }
      const content = term.getSelection() || lines.join("\n").trimEnd();
      if (!content) return false;
      await navigator.clipboard.writeText(content);
      return true;
    }
  }));

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      lineHeight: 1.15,
      scrollback: 3000,
      theme: {
        background: "#0a0b0a",
        foreground: "#e4e4e7",
        cursor: "#6ee7b7",
        selectionBackground: "#134e4a"
      }
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current!);
    termRef.current = terminal;

    let frame = 0;
    let lastSize = "";

    const syncSize = (force = false) => {
      const container = containerRef.current;
      if (document.visibilityState === "hidden" || !container?.clientWidth || !container.clientHeight) return;

      // Only controller resizes server PTY
      if (roleRef.current !== "controller" || !syncCompleteRef.current) return;

      const dimensions = fit.proposeDimensions();
      if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;

      const cols = Math.min(300, Math.max(20, dimensions.cols));
      const rows = Math.min(120, Math.max(5, dimensions.rows));
      if (terminal.cols !== cols || terminal.rows !== rows) {
        terminal.resize(cols, rows);
      }
      const size = `${cols}:${rows}`;
      if ((force || size !== lastSize) && send({ type: "resize", cols, rows })) {
        lastSize = size;
      }
    };

    resizeRef.current = syncSize;

    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => syncSize());
    };

    const activate = () => syncSize(true);
    window.addEventListener("focus", activate);
    const container = containerRef.current!;
    container.addEventListener("click", activate);
    const touchScroll = installTerminalTouchScroll(terminal, container);
    stopScrollRef.current = touchScroll.stop;
    const observer = new ResizeObserver(resize);
    observer.observe(containerRef.current!);
    resize();

    const data = terminal.onData((value) => {
      if (!syncCompleteRef.current || roleRef.current !== "controller") return;
      if (!send({ type: "input", data: value })) {
        onError("Chưa kết nối. Phím vừa nhập chưa được gửi.");
      }
    });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("focus", activate);
      container.removeEventListener("click", activate);
      touchScroll.dispose();
      data.dispose();
      terminal.dispose();
      termRef.current = undefined;
      resizeRef.current = () => {};
      stopScrollRef.current = () => {};
    };
  }, [onError]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      resizeRef.current(true);
    }
  }, [fontSize]);

  useEffect(() => {
    const terminal = termRef.current;
    stopScrollRef.current();

    if (!terminal || !session) {
      terminal?.reset();
      setConnected(false);
      setSyncing(false);
      onConnectedChange(false);
      return;
    }

    let stopped = false;
    let connecting = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let lastMessage = Date.now();

    const currentSessionId = session.id;
    const currentGen = connectionGeneration;

    const MAX_RECONNECT_ATTEMPTS = 5;
    const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];

    const schedule = () => {
      if (stopped) return;
      clearTimeout(timer);

      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        stopped = true;
        connecting = false;
        setConnected(false);
        setSyncing(false);
        syncCompleteRef.current = false;
        onConnectedChange(false, roleRef.current);
        onReconnectExhausted?.(currentSessionId);
        return;
      }

      const baseDelay = RECONNECT_DELAYS[attempt] ?? 15_000;
      attempt += 1;
      const delay = baseDelay + Math.random() * 400;
      timer = setTimeout(() => void connect(), delay);
    };

    const syncCtrl = new TerminalSyncController({
      sessionId: currentSessionId,
      generation: currentGen,
      writeTerminal: (data) =>
        new Promise<void>((resolve) => {
          if (stopped || sessionIdRef.current !== currentSessionId) {
            resolve();
            return;
          }
          terminal!.write(data, () => resolve());
        }),
      resetTerminal: () => {
        terminal!.reset();
      },
      resizeTerminal: (cols, rows) => {
        terminal!.resize(cols, rows);
      },
      onSyncComplete: (syncedRole) => {
        if (stopped || sessionIdRef.current !== currentSessionId) return;
        attempt = 0;
        syncCompleteRef.current = true;
        roleRef.current = syncedRole;
        setRole(syncedRole);
        setSyncing(false);
        setConnected(true);
        onConnectedChange(true, syncedRole);
        if (syncedRole === "controller") {
          resizeRef.current(true);
        }
      },
      onMismatchOrGap: () => {
        if (stopped || sessionIdRef.current !== currentSessionId) return;
        wsRef.current?.close();
        schedule();
      }
    });

    async function connect() {
      if (stopped || connecting || wsRef.current?.readyState === WebSocket.OPEN) return;
      connecting = true;
      setConnected(false);
      onConnectedChange(false, roleRef.current);

      try {
        const { ticket } = await createWsTicket("", currentSessionId, { protocolVersion: 2 });
        if (stopped || sessionIdRef.current !== currentSessionId) return;

        const ws = new WebSocket(buildWsUrl(currentSessionId), ["web-cli", `ticket.${ticket}`]);
        wsRef.current = ws;

        const openTimeout = setTimeout(() => ws.close(), 10_000);

        ws.addEventListener("open", () => {
          clearTimeout(openTimeout);
          if (stopped || wsRef.current !== ws || sessionIdRef.current !== currentSessionId) {
            ws.close();
            return;
          }
          connecting = false;
          lastMessage = Date.now();
          stopScrollRef.current();

          clearInterval(heartbeat);
          heartbeat = setInterval(() => {
            if (Date.now() - lastMessage > 35_000) ws.close();
            else send({ type: "ping" });
          }, 15_000);
        });

        ws.addEventListener("message", (event) => {
          if (stopped || wsRef.current !== ws || sessionIdRef.current !== currentSessionId) return;
          lastMessage = Date.now();

          try {
            const message = JSON.parse(String(event.data)) as ServerMessageV2;

            switch (message.type) {
              case "sync_start": {
                syncCompleteRef.current = false;
                setSyncing(true);
                setConnected(false);
                roleRef.current = message.control;
                setRole(message.control);
                onConnectedChange(false, message.control);
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
                roleRef.current = message.role;
                setRole(message.role);
                onConnectedChange(syncCtrl.syncComplete, message.role);
                if (message.role === "controller" && syncCtrl.syncComplete) {
                  resizeRef.current(true);
                }
                break;
              }

              case "state": {
                onSessionUpdate(message.session, message.registryRevision, message.serverEpoch);
                break;
              }

              case "exit": {
                terminal!.writeln(`\r\n[Phiên đã kết thúc: ${message.exitCode ?? "—"}]`);
                if (message.session) {
                  onSessionUpdate(message.session, message.registryRevision, message.serverEpoch);
                }
                break;
              }

              case "removed": {
                terminal!.writeln("\r\n[Phiên đã bị xóa khỏi máy chủ]");
                break;
              }

              case "attention": {
                onAttention?.({
                  sessionId: message.sessionId,
                  eventId: message.eventId,
                  createdAt: message.createdAt
                });
                break;
              }

              case "error": {
                if (message.code === "control_locked") {
                  onError("Chỉ xem — phiên đang được điều khiển ở thiết bị khác");
                } else {
                  onError(message.message);
                }
                break;
              }

              case "pong":
                break;

              default: {
                // Fallback for v1 legacy output message
                const legacy = message as unknown as { type: string; data?: string; session?: Session };
                if (legacy.type === "output" && legacy.data) {
                  terminal!.write(legacy.data);
                } else if (legacy.type === "state" && legacy.session) {
                  onSessionUpdate(legacy.session);
                }
                break;
              }
            }
          } catch {
            onError("Không đọc được dữ liệu terminal.");
          }
        });

        ws.addEventListener("close", (event) => {
          clearTimeout(openTimeout);
          clearInterval(heartbeat);
          if (stopped || wsRef.current !== ws || sessionIdRef.current !== currentSessionId) return;

          wsRef.current = undefined;
          connecting = false;
          setConnected(false);
          setSyncing(false);
          syncCompleteRef.current = false;
          onConnectedChange(false, roleRef.current);

          if (event.code === 4001) {
            stopped = true;
            window.dispatchEvent(new Event("web-cli-auth-expired"));
            return;
          }
          if (event.code === 4004) {
            stopped = true;
            onSessionMissing?.(currentSessionId);
            return;
          }
          if (event.code === 4003) {
            stopped = true;
            onError("Không có quyền truy cập phiên (403)");
            return;
          }
          schedule();
        });

        ws.addEventListener("error", () => ws.close());
      } catch (error) {
        if (!stopped && sessionIdRef.current === currentSessionId) {
          connecting = false;
          setConnected(false);
          setSyncing(false);
          syncCompleteRef.current = false;
          onConnectedChange(false, roleRef.current);

          if (error instanceof ApiError) {
            if (error.status === 404 || error.code === "unknown_session") {
              stopped = true;
              onSessionMissing?.(currentSessionId);
              return;
            }
            if (error.status === 401) {
              stopped = true;
              return;
            }
            if (error.status === 403) {
              stopped = true;
              onError(error.message || "Không có quyền truy cập phiên (403)");
              return;
            }
          }

          onError(error instanceof Error ? error.message : "Mất kết nối.");
          schedule();
        }
      }
    }

    const resume = () => {
      if (document.visibilityState === "hidden") return;
      resizeRef.current(true);
      if (wsRef.current?.readyState === WebSocket.OPEN && Date.now() - lastMessage > 35_000) {
        wsRef.current.close();
      } else if (!connecting) {
        clearTimeout(timer);
        void connect();
      }
    };

    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);

    void connect();

    return () => {
      stopped = true;
      syncCtrl.invalidate();
      clearTimeout(timer);
      clearInterval(heartbeat);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      wsRef.current?.close();
      wsRef.current = undefined;
      setConnected(false);
      setSyncing(false);
      syncCompleteRef.current = false;
      onConnectedChange(false, roleRef.current);
    };
  }, [
    session?.id,
    connectionGeneration,
    onConnectedChange,
    onError,
    onSessionUpdate,
    onAttention,
    reconnectKey
  ]);

  return (
    <div className="terminal-pane relative" aria-label="Nội dung terminal">
      {role === "viewer" && connected && (
        <div
          role="status"
          className="viewer-banner flex items-center justify-between border-b border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs text-amber-300"
        >
          <span>Chỉ xem — phiên đang được điều khiển ở thiết bị khác</span>
        </div>
      )}
      {syncing && (
        <div className="absolute right-3 top-2 z-10 rounded bg-shell-900/80 px-2 py-0.5 text-xs text-zinc-400">
          Đang đồng bộ…
        </div>
      )}
      <div ref={containerRef} className="terminal-container" />
      {!session && (
        <div className="terminal-empty">
          <p>Terminal trên máy chủ</p>
          <p className="mt-2 text-sm text-zinc-400">Chọn “Phiên & dự án” để mở terminal hoặc AI.</p>
        </div>
      )}
    </div>
  );
});
