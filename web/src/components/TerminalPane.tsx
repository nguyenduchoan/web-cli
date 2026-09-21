import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { installTerminalTouchScroll } from "../lib/terminalTouchScroll";
import { ReconnectManager } from "../lib/reconnectPolicy";
import { TerminalConnectionSession } from "../lib/terminalConnection";
import { XtermOperationQueue } from "../lib/xtermOperationQueue";
import type { Session } from "../lib/types";

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
  const queueRef = useRef<XtermOperationQueue>(new XtermOperationQueue());
  const connSessionRef = useRef<TerminalConnectionSession | undefined>(undefined);
  const resizeRef = useRef<(force?: boolean) => void>(() => {});
  const stopScrollRef = useRef<() => void>(() => {});

  const roleRef = useRef<"controller" | "viewer">("viewer");
  const sessionIdRef = useRef<string | undefined>(session?.id);
  sessionIdRef.current = session?.id;

  const [role, setRole] = useState<"controller" | "viewer">("viewer");
  const [connected, setConnected] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);

  function send(payload: unknown): boolean {
    return connSessionRef.current?.send(payload) ?? false;
  }

  useImperativeHandle(ref, () => ({
    sendInput(data) {
      stopScrollRef.current();
      if (!connected || !connSessionRef.current?.syncComplete) {
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
      if (roleRef.current !== "controller" || !connSessionRef.current?.syncComplete) return;

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
      if (!connSessionRef.current?.syncComplete || roleRef.current !== "controller") return;
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
    const queue = queueRef.current;
    stopScrollRef.current();

    if (!terminal || !session) {
      terminal?.reset();
      setConnected(false);
      setSyncing(false);
      onConnectedChange(false);
      return;
    }

    let disposed = false;
    const currentSessionId = session.id;

    // Switch flow:
    // 1. block input synchronously
    setConnected(false);
    setSyncing(false);
    onConnectedChange(false, roleRef.current);

    // 2. invalidate old connection/controller
    connSessionRef.current?.dispose();
    connSessionRef.current = undefined;

    // 3. mark old xterm generation stale
    queue.invalidate();

    // 4. await global xterm write barrier
    void (async () => {
      await queue.barrier();
      if (disposed || sessionIdRef.current !== currentSessionId) {
        return;
      }

      // 5. only then: reset xterm and attach/sync new session
      terminal.reset();

      const connectionSession = new TerminalConnectionSession({
        sessionId: currentSessionId,
        queue,
        reconnectManager: new ReconnectManager(),
        callbacks: {
          onConnectedChange: (isConnected, currentRole) => {
            if (disposed || sessionIdRef.current !== currentSessionId) return;
            setConnected(isConnected);
            onConnectedChange(isConnected, currentRole);
          },
          onRoleChange: (newRole) => {
            if (disposed || sessionIdRef.current !== currentSessionId) return;
            roleRef.current = newRole;
            setRole(newRole);
          },
          onSyncingChange: (isSyncing) => {
            if (disposed || sessionIdRef.current !== currentSessionId) return;
            setSyncing(isSyncing);
          },
          onResizeRequired: () => {
            if (disposed || sessionIdRef.current !== currentSessionId) return;
            resizeRef.current(true);
          },
          onSessionUpdate: (s, regRev, sEpoch) => {
            if (disposed || sessionIdRef.current !== currentSessionId) return;
            onSessionUpdate(s, regRev, sEpoch);
          },
          onAttention: (evt) => {
            if (disposed || sessionIdRef.current !== currentSessionId) return;
            onAttention?.(evt);
          },
          onError: (errMsg) => {
            if (disposed || sessionIdRef.current !== currentSessionId) return;
            onError(errMsg);
          },
          onSessionMissing: (sId) => {
            if (disposed || sessionIdRef.current !== currentSessionId) return;
            onSessionMissing?.(sId);
          },
          onReconnectExhausted: (sId) => {
            if (disposed || sessionIdRef.current !== currentSessionId) return;
            onReconnectExhausted?.(sId);
          },
          onAuthExpired: () => {
            window.dispatchEvent(new Event("web-cli-auth-expired"));
          },
          writeTerminal: (data) =>
            new Promise<void>((resolve) => {
              if (disposed || sessionIdRef.current !== currentSessionId) {
                resolve();
                return;
              }
              terminal.write(data, resolve);
            }),
          resetTerminal: () => {
            terminal.reset();
          },
          resizeTerminal: (cols, rows) => {
            terminal.resize(cols, rows);
          },
          writelnTerminal: (data) => {
            terminal.writeln(data);
          }
        }
      });

      connSessionRef.current = connectionSession;
      connectionSession.start();
    })();

    const resume = () => {
      if (document.visibilityState === "hidden") return;
      resizeRef.current(true);
      const conn = connSessionRef.current;
      if (conn?.ws?.readyState === WebSocket.OPEN && Date.now() - conn["lastMessageTime"] > 35_000) {
        conn.ws.close();
      } else if (conn && !conn.connecting && !conn.connected && !conn.stopped) {
        void conn.connect();
      }
    };

    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);

    return () => {
      disposed = true;
      connSessionRef.current?.dispose();
      connSessionRef.current = undefined;
      queue.invalidate();
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      setConnected(false);
      setSyncing(false);
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
