import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AgentTabs } from "./components/AgentTabs";
import { CommandInput } from "./components/CommandInput";
import { LoginScreen } from "./components/LoginScreen";
import { ProjectSelector } from "./components/ProjectSelector";
import { QuickActions } from "./components/QuickActions";
import type { TerminalPaneHandle } from "./components/TerminalPane";
import { authStatus, createSession, killSession, listAgents, listProjects, listSessions, logout, restartSession, type AuthStatus } from "./lib/api";
import type { AgentConfig, ProjectConfig, Session } from "./lib/types";
const TerminalPane = lazy(() => import("./components/TerminalPane").then((module) => ({ default: module.TerminalPane })));
const SESSION_KEY = "web-cli-last-session";
export default function App() {
  const terminalRef = useRef<TerminalPaneHandle>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [auth, setAuth] = useState<AuthStatus>();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("shell");
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [selectedSubpath, setSelectedSubpath] = useState<string>();
  const [session, setSession] = useState<Session>();
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [fontSize, setFontSize] = useState(14);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [notice, setNotice] = useState("");
  const draftKey = session?.id ?? "new";
  const draft = drafts[draftKey] ?? "";
  const updateDraft = (value: string) => setDrafts((current) => ({ ...current, [draftKey]: value }));
  const showError = useCallback((message: string) => setError(message), []);
  const updateSession = useCallback((next: Session) => {
    setSession(next); localStorage.setItem(SESSION_KEY, next.id);
    setSessions((current) => [next, ...current.filter((item) => item.id !== next.id)]);
  }, []);
  const connectionChanged = useCallback((next: boolean) => { setConnected(next); if (next) setError(""); }, []);
  const load = useCallback(async () => {
    const status = await authStatus(); setAuth(status);
    if (!status.authenticated) return;
    const [agentResult, projectResult, sessionResult] = await Promise.all([listAgents(""), listProjects(""), listSessions()]);
    setAgents(agentResult.agents); setProjects(projectResult.projects); setSessions(sessionResult.sessions);
    setSelectedProjectId((current) => current ?? projectResult.projects[0]?.id);
    const previous = localStorage.getItem(SESSION_KEY);
    const restored = sessionResult.sessions.find((item) => item.id === previous) ?? sessionResult.sessions.find((item) => item.state === "running");
    if (restored) updateSession(restored); else { setSession(undefined); setPanel(true); }
  }, [updateSession]);
  useEffect(() => {
    localStorage.removeItem("agent-controller-token"); sessionStorage.removeItem("agent-controller-token");
    void load().catch((err) => showError(err.message));
    const expired = () => { setAuth({ authenticated: false, setupRequired: false }); setSession(undefined); setPanel(false); setError("Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại để tiếp tục."); };
    window.addEventListener("web-cli-auth-expired", expired);
    return () => window.removeEventListener("web-cli-auth-expired", expired);
  }, [load, showError]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => { document.documentElement.style.setProperty("--app-height", `${viewport?.height ?? window.innerHeight}px`); document.documentElement.style.setProperty("--app-top", `${viewport?.offsetTop ?? 0}px`); };
    resize(); viewport?.addEventListener("resize", resize); viewport?.addEventListener("scroll", resize); window.addEventListener("resize", resize);
    return () => { viewport?.removeEventListener("resize", resize); viewport?.removeEventListener("scroll", resize); window.removeEventListener("resize", resize); };
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (panel && auth?.authenticated) dialog?.showModal(); else dialog?.close();
  }, [panel, auth?.authenticated]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(""), 3000); return () => clearTimeout(timer); } }, [notice]);
  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError("");
    try { await action(); } catch (err) { showError(err instanceof Error ? err.message : "Thao tác thất bại."); } finally { setBusy(false); }
  }
  async function start() {
    if (!selectedProjectId) return;
    await run(async () => { const result = await createSession("", { agentId: selectedAgentId, projectId: selectedProjectId, subpath: selectedSubpath }); updateSession(result.session); setPanel(false); });
  }
  function send(data: string): boolean { return terminalRef.current?.sendInput(data) ?? false; }
  function shortcut(data: string) {
    if (data === "\x03") { send(data); return; }
    // Flush the draft before terminal keys so Tab/arrow/Enter act on visible text.
    if (send(draft + data) && draft) updateDraft("");
  }
  async function copy() {
    try { setNotice(await terminalRef.current?.copy() ? "Đã sao chép phần chọn hoặc 500 dòng gần nhất." : "Chưa có nội dung để sao chép."); }
    catch { showError("Trình duyệt chưa cho phép sao chép. Hãy mở trang bằng HTTPS."); }
  }
  if (!auth) return <main className="login-page"><div className="login-card"><h1 className="text-xl">Web CLI</h1><p className="mt-3">{error || "Đang kiểm tra đăng nhập…"}</p>{error && <button className="primary mt-4" onClick={() => void load().catch((err) => showError(err.message))}>Thử lại</button>}</div></main>;
  if (!auth.authenticated) return <LoginScreen setupRequired={auth.setupRequired} onLogin={load} error={error} />;
  const usable = session?.state === "running" && connected;
  return <main className="controller">
    <header className="controller-header">
      <div className="min-w-0"><h1 className="font-semibold">Web CLI <span className="text-xs font-normal text-zinc-400">· Máy chủ</span></h1><p role="status" className={`text-xs ${connected ? "text-signal-400" : "text-amber-300"}`}>{session ? connected ? session.state === "running" ? "Đã kết nối" : "Phiên đã kết thúc" : "Đang nối lại…" : "Chưa mở phiên"}</p></div>
      <button className="control" onClick={() => { setPanel(true); void listSessions().then((result) => setSessions(result.sessions)).catch((err) => showError(err.message)); }}>Phiên & dự án</button>
    </header>
    <div className="terminal-toolbar">
      <select aria-label="Chuyển phiên terminal" value={session?.id ?? ""} onChange={(e) => { const next = sessions.find((item) => item.id === e.target.value); if (next) updateSession(next); }} className="min-w-0 flex-1">
        {!session && <option value="">Chọn phiên</option>}{sessions.map((item) => <option key={item.id} value={item.id}>{item.agentLabel} · {item.projectLabel} · {item.id.slice(0, 4)}{item.state === "running" ? "" : " (đã dừng)"}</option>)}
      </select>
      <button className="control" title="Sao chép phần chọn hoặc 500 dòng cuối" aria-label="Sao chép nội dung terminal" onClick={() => void copy()}>Chép</button>
      <button className="control" aria-label="Cuộn xuống cuối terminal" onClick={() => terminalRef.current?.scrollToBottom()}>↓ cuối</button>
    </div>
    {error && <div role="alert" className="controller-error"><span>{error}</span><button aria-label="Đóng thông báo" onClick={() => setError("")}>×</button></div>}
    <Suspense fallback={<div className="terminal-pane p-4">Đang tải terminal…</div>}><TerminalPane ref={terminalRef} session={session} onSessionUpdate={updateSession} onConnectedChange={connectionChanged} onError={showError} fontSize={fontSize} reconnectKey={reconnectKey} /></Suspense>
    <section className="composer">
      <QuickActions disabled={!usable} onSend={shortcut} />
      <CommandInput disabled={!usable} value={draft} onChange={updateDraft} onSend={send} />
    </section>
    {notice && <div role="status" className="toast">{notice}</div>}
    <dialog ref={dialogRef} className="settings-dialog" onCancel={() => setPanel(false)} onClick={(e) => { if (e.target === dialogRef.current) setPanel(false); }}>
      <div className="space-y-4"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Phiên & dự án</h2><button className="control" onClick={() => setPanel(false)} aria-label="Đóng bảng thiết lập">Đóng</button></div>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <AgentTabs agents={agents} selectedAgentId={selectedAgentId} onSelect={setSelectedAgentId} />
        <ProjectSelector token="" projects={projects} selectedProjectId={selectedProjectId} selectedSubpath={selectedSubpath} onSelect={(projectId, subpath) => { setSelectedProjectId(projectId); setSelectedSubpath(subpath); }} />
        <button className="primary w-full" disabled={busy || !selectedProjectId} onClick={() => void start()}>{busy ? "Đang xử lý…" : "Tạo phiên mới"}</button>
        {session && <section className="space-y-2 border-t border-white/10 pt-3"><h3 className="break-words text-sm">Phiên hiện tại: {session.agentLabel} / {session.projectLabel}</h3><div className="grid grid-cols-2 gap-2">
          <button className="control" onClick={() => { setReconnectKey((key) => key + 1); setPanel(false); }}>Nối lại</button>
          <button className="control" onClick={() => { setPanel(false); setTimeout(() => terminalRef.current?.focus(), 0); }}>Gõ trực tiếp</button>
          <button className="control" disabled={busy} onClick={() => { if (window.confirm("Khởi động lại sẽ kết thúc tác vụ của phiên này. Tiếp tục?")) void run(async () => { const result = await restartSession("", session.id); const latest = await listSessions(); setSessions(latest.sessions); updateSession(result.session); setPanel(false); }); }}>Khởi động lại</button>
          <button className="control text-red-300" disabled={busy || session.state !== "running"} onClick={() => { if (window.confirm("Kết thúc phiên và tác vụ đang chạy trong phiên này?")) void run(async () => { const result = await killSession("", session.id); updateSession(result.session); }); }}>Kết thúc phiên</button>
        </div></section>}
        <label className="flex items-center justify-between gap-3 text-sm">Cỡ chữ terminal<select aria-label="Cỡ chữ terminal" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))}>{[12, 14, 16, 18, 20].map((size) => <option key={size} value={size}>{size} px</option>)}</select></label>
        <p className="text-xs text-zinc-400">Ô soạn giữ nội dung trước khi gửi. Enter trên bàn phím để xuống dòng; nút Tab gửi phần đang soạn vào terminal để hoàn thành lệnh. Chưa có AI gợi ý trong lúc gõ.</p>
        <button className="control w-full" disabled={busy} onClick={() => void run(async () => { await logout(); setSession(undefined); setSessions([]); setDrafts({}); setPanel(false); setAuth({ authenticated: false, setupRequired: false }); })}>Đăng xuất · {auth.username}</button>
      </div>
    </dialog>
  </main>;
}
