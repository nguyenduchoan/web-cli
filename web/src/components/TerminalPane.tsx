import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { buildWsUrl, createWsTicket } from "../lib/api";
import { installTerminalTouchScroll } from "../lib/terminalTouchScroll";
import type { ServerMessage, Session } from "../lib/types";
export type TerminalPaneHandle = { sendInput: (data: string) => boolean; focus: () => void; copy: () => Promise<boolean>; scrollToBottom: () => void };
type Props = { session?: Session; onSessionUpdate: (session: Session) => void; onConnectedChange: (connected: boolean) => void; onError: (message: string) => void; fontSize: number; reconnectKey: number };
export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(function TerminalPane({ session, onSessionUpdate, onConnectedChange, onError, fontSize, reconnectKey }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | undefined>(undefined);
  const resizeRef = useRef<(force?: boolean) => void>(() => {});
  const stopScrollRef = useRef<() => void>(() => {});
  const wsRef = useRef<WebSocket | undefined>(undefined);
  function send(payload: unknown): boolean {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload)); return true;
  }
  useImperativeHandle(ref, () => ({
    sendInput(data) {
      stopScrollRef.current();
      if (data.includes("\n") && termRef.current?.modes.bracketedPasteMode) {
        const enter = data.endsWith("\r");
        data = "\x1b[200~" + (enter ? data.slice(0, -1) : data) + "\x1b[201~" + (enter ? "\r" : "");
      }
      if (new TextEncoder().encode(JSON.stringify({ type: "input", data })).length > 16_000) { onError("Nội dung quá dài. Hãy chia thành phần nhỏ hơn; bản nháp vẫn được giữ."); return false; }
      resizeRef.current(true);
      const accepted = send({ type: "input", data }); if (!accepted) onError("Chưa kết nối. Nội dung chưa được gửi."); return accepted;
    },
    focus() { termRef.current?.focus(); },
    scrollToBottom() { stopScrollRef.current(); termRef.current?.scrollToBottom(); },
    async copy() {
      const term = termRef.current; if (!term) return false;
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let i = Math.max(0, buffer.length - 500); i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
      const content = term.getSelection() || lines.join("\n").trimEnd();
      if (!content) return false;
      await navigator.clipboard.writeText(content); return true;
    }
  }));
  useEffect(() => {
    const terminal = new Terminal({ cursorBlink: true, fontSize, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: 1.15, scrollback: 3000, theme: { background: "#0a0b0a", foreground: "#e4e4e7", cursor: "#6ee7b7", selectionBackground: "#134e4a" } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(containerRef.current!);
    termRef.current = terminal;
    let frame = 0;
    let lastSize = "";
    const syncSize = (force = false) => {
      const container = containerRef.current;
      if (document.visibilityState === "hidden" || !container?.clientWidth || !container.clientHeight) return;
      const dimensions = fit.proposeDimensions();
      if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;
      // Keep the browser grid and PTY within the same server protocol limits.
      const cols = Math.min(300, Math.max(20, dimensions.cols));
      const rows = Math.min(120, Math.max(5, dimensions.rows));
      if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
      const size = `${cols}:${rows}`;
      if ((force || size !== lastSize) && send({ type: "resize", cols, rows })) lastSize = size;
    };
    resizeRef.current = syncSize;
    const resize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => syncSize()); };
    // Another device may have resized the shared PTY while this view was inactive.
    const activate = () => syncSize(true);
    window.addEventListener("focus", activate);
    const container = containerRef.current!;
    container.addEventListener("click", activate);
    const touchScroll = installTerminalTouchScroll(terminal, container);
    stopScrollRef.current = touchScroll.stop;
    const observer = new ResizeObserver(resize); observer.observe(containerRef.current!); resize();
    const data = terminal.onData((value) => { if (!send({ type: "input", data: value })) onError("Chưa kết nối. Phím vừa nhập chưa được gửi."); });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("focus", activate); container.removeEventListener("click", activate); touchScroll.dispose(); data.dispose(); terminal.dispose(); termRef.current = undefined; resizeRef.current = () => {}; stopScrollRef.current = () => {}; };
  }, [onError]);
  useEffect(() => { if (termRef.current) { termRef.current.options.fontSize = fontSize; resizeRef.current(true); } }, [fontSize]);
  useEffect(() => {
    const terminal = termRef.current;
    stopScrollRef.current();
    if (!terminal || !session) { terminal?.reset(); return; }
    let stopped = false;
    let connecting = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let lastMessage = Date.now();
    const id = session.id;
    const schedule = () => { if (stopped) return; clearTimeout(timer); timer = setTimeout(() => void connect(), Math.min(15_000, 1000 * 2 ** Math.min(attempt++, 4)) + Math.random() * 400); };
    async function connect() {
      if (stopped || connecting || wsRef.current?.readyState === WebSocket.OPEN) return;
      connecting = true; onConnectedChange(false);
      try {
        const { ticket } = await createWsTicket("", id);
        if (stopped) return;
        const ws = new WebSocket(buildWsUrl(id), ["web-cli", `ticket.${ticket}`]); wsRef.current = ws;
        const openTimeout = setTimeout(() => ws.close(), 10_000);
        ws.addEventListener("open", () => {
          clearTimeout(openTimeout);
          if (stopped || wsRef.current !== ws) { ws.close(); return; }
          connecting = false; attempt = 0; lastMessage = Date.now();
          stopScrollRef.current(); terminal!.reset(); onConnectedChange(true);
          resizeRef.current(true);
          clearInterval(heartbeat);
          heartbeat = setInterval(() => { if (Date.now() - lastMessage > 35_000) ws.close(); else send({ type: "ping" }); }, 15_000);
        });
        ws.addEventListener("message", (event) => {
          if (stopped || wsRef.current !== ws) return;
          lastMessage = Date.now();
          try {
            const message = JSON.parse(String(event.data)) as ServerMessage;
            if (message.type === "output") terminal!.write(message.data);
            else if (message.type === "state") onSessionUpdate(message.session);
            else if (message.type === "error") onError(message.message);
            else if (message.type === "exit") terminal!.writeln(`\r\n[Phiên đã kết thúc: ${message.exitCode ?? "—"}]`);
          } catch { onError("Không đọc được dữ liệu terminal."); }
        });
        ws.addEventListener("close", (event) => {
          clearTimeout(openTimeout); clearInterval(heartbeat);
          if (stopped || wsRef.current !== ws) return;
          wsRef.current = undefined; connecting = false; onConnectedChange(false);
          if (event.code === 4001) { stopped = true; window.dispatchEvent(new Event("web-cli-auth-expired")); return; }
          schedule();
        });
        ws.addEventListener("error", () => ws.close());
      } catch (error) { if (!stopped) { onError(error instanceof Error ? error.message : "Mất kết nối."); connecting = false; schedule(); } }
    }
    const resume = () => { if (document.visibilityState === "hidden") return; resizeRef.current(true); if (wsRef.current?.readyState === WebSocket.OPEN && Date.now() - lastMessage > 35_000) wsRef.current.close(); else if (!connecting) { clearTimeout(timer); void connect(); } };
    window.addEventListener("online", resume); document.addEventListener("visibilitychange", resume);
    void connect();
    return () => { stopped = true; clearTimeout(timer); clearInterval(heartbeat); window.removeEventListener("online", resume); document.removeEventListener("visibilitychange", resume); wsRef.current?.close(); wsRef.current = undefined; onConnectedChange(false); };
  }, [session?.id, onConnectedChange, onError, onSessionUpdate, reconnectKey]);
  return <div className="terminal-pane" aria-label="Nội dung terminal"><div ref={containerRef} className="terminal-container" />{!session && <div className="terminal-empty"><p>Terminal trên máy chủ</p><p className="mt-2 text-sm text-zinc-400">Chọn “Phiên & dự án” để mở terminal hoặc AI.</p></div>}</div>;
});
