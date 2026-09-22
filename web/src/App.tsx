import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { CommandInput } from "./components/CommandInput";
import { LoginScreen } from "./components/LoginScreen";
import { QuickActions } from "./components/QuickActions";
import { SessionManager } from "./components/SessionManager";
import type { TerminalPaneHandle } from "./components/TerminalPane";
import { useSessions } from "./features/sessions/useSessions";
import { authStatus, listAgents, listProjects, listSessions, logout, type AuthStatus } from "./lib/api";
import { clearPushConsent } from "./lib/push";
import { usePushLifecycle } from "./features/push/usePushLifecycle";
import type { AgentConfig, ProjectConfig, Session } from "./lib/types";

const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then((module) => ({ default: module.TerminalPane }))
);

export default function App() {
  const terminalRef = useRef<TerminalPaneHandle>(null);
  const settingsDialogRef = useRef<HTMLDialogElement>(null);
  const mobileSheetButtonRef = useRef<HTMLButtonElement>(null);

  const [auth, setAuth] = useState<AuthStatus>();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMobileSheetOpen, setIsMobileSheetOpen] = useState(false);
  const [isDesktopSidebarCollapsed, setIsDesktopSidebarCollapsed] = useState(false);
  const [fallbackDraft, setFallbackDraft] = useState("");
  const [fontSize, setFontSize] = useState(14);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [foregroundAttention, setForegroundAttention] = useState<{
    eventId: string;
    sessionId: string;
  } | null>(null);
  const pushLifecycle = usePushLifecycle(Boolean(auth?.authenticated), setForegroundAttention);

  const {
    state: sessionsState,
    activeSession,
    connectionGeneration,
    isInputAllowed,
    switchSession,
    setConnection,
    fetchSessions,
    createNewSession,
    restartCurrentSession,
    killCurrentSession,
    setDraft,
    getDraft,
    addAttention,
    dispatch: dispatchSessions
  } = useSessions({
    token: "",
    isAuthenticated: Boolean(auth?.authenticated)
  });

  const sessionList = sessionsState.sessionOrder
    .map((id) => sessionsState.sessionsById[id])
    .filter((s): s is Session => Boolean(s));

  const draft = activeSession ? getDraft(activeSession.id) : fallbackDraft;
  const updateDraft = (value: string) => {
    if (activeSession) {
      setDraft(activeSession.id, value);
    } else {
      setFallbackDraft(value);
    }
  };

  const showError = useCallback((message: string) => setError(message), []);

  const handleTargetSession = useCallback(
    (sessionId: string) => {
      if (!sessionId) return;
      if (!auth?.authenticated) {
        sessionStorage.setItem("web-cli-target-session", sessionId);
        return;
      }
      const target = sessionsState.sessionsById[sessionId];
      if (target) {
        switchSession(sessionId);
      } else {
        showError("Phiên không còn trên máy chủ");
        setIsMobileSheetOpen(true);
      }
    },
    [auth?.authenticated, sessionsState.sessionsById, switchSession, showError]
  );

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "web-cli-open-session" && event.data.sessionId) {
        handleTargetSession(event.data.sessionId);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [handleTargetSession]);

  useEffect(() => {
    const checkHash = () => {
      const hash = window.location.hash;
      const match = hash.match(/^#session=([0-9a-f-]{36})$/i);
      if (match) {
        handleTargetSession(match[1]);
      }
    };
    checkHash();
    window.addEventListener("hashchange", checkHash);
    return () => window.removeEventListener("hashchange", checkHash);
  }, [handleTargetSession]);

  const handleSessionUpdate = useCallback(
    (next: Session, registryRevision?: number, serverEpoch?: string) => {
      dispatchSessions({
        type: "UPSERT_SESSION",
        payload: {
          session: next,
          registryRevision,
          serverEpoch
        }
      });
    },
    [dispatchSessions]
  );

  const handleConnectedChange = useCallback(
    (connected: boolean, control?: "controller" | "viewer") => {
      setConnection({
        status: connected ? "connected" : "connecting",
        control: control ?? (connected ? "controller" : "none")
      });
      if (connected) setError("");
    },
    [setConnection]
  );

  const handleSessionMissing = useCallback(
    (missingSessionId: string) => {
      setConnection({
        sessionId: missingSessionId,
        status: "missing",
        control: "none"
      });
      void fetchSessions();
    },
    [setConnection, fetchSessions]
  );

  const handleReconnectExhausted = useCallback(
    (sessId: string) => {
      setConnection({
        sessionId: sessId,
        status: "disconnected",
        control: "none"
      });
    },
    [setConnection]
  );

  const load = useCallback(async () => {
    const status = await authStatus();
    setAuth(status);
    if (!status.authenticated) return;

    const [agentResult, projectResult] = await Promise.all([listAgents(""), listProjects("")]);
    setAgents(agentResult.agents);
    setProjects(projectResult.projects);

    try {
      await fetchSessions();
      const sessionResult = await listSessions();

      // Check pending target from notification or hash
      const hashMatch = window.location.hash.match(/^#session=([0-9a-f-]{36})$/i);
      const pendingTarget = sessionStorage.getItem("web-cli-target-session") || hashMatch?.[1];
      if (pendingTarget) {
        sessionStorage.removeItem("web-cli-target-session");
        const found = sessionResult.sessions.find((s) => s.id === pendingTarget);
        if (found) {
          switchSession(pendingTarget);
          return;
        } else {
          showError("Phiên không còn trên máy chủ");
          setIsMobileSheetOpen(true);
          return;
        }
      }

      const previous = sessionStorage.getItem("web-cli-active-session");
      const restored =
        sessionResult.sessions.find((s) => s.id === previous) ??
        sessionResult.sessions.find((s) => s.state === "running");
      if (!restored) {
        setIsMobileSheetOpen(true);
      }
    } catch {
      setIsMobileSheetOpen(true);
    }
  }, [fetchSessions, switchSession, showError]);

  useEffect(() => {
    localStorage.removeItem("agent-controller-token");
    sessionStorage.removeItem("agent-controller-token");
    void load().catch((err) => showError(err.message));

    const expired = () => {
      pushLifecycle.invalidate();
      setForegroundAttention(null);
      setAuth((current) => ({
        authenticated: false,
        setupRequired: false,
        hubEnabled: current?.hubEnabled
      }));
      setIsSettingsOpen(false);
      setIsMobileSheetOpen(false);
      clearPushConsent();
      dispatchSessions({ type: "RESET_SESSIONS" });
      setError("Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại để tiếp tục.");
    };

    window.addEventListener("web-cli-auth-expired", expired);
    return () => window.removeEventListener("web-cli-auth-expired", expired);
  }, [load, showError, pushLifecycle.invalidate]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      document.documentElement.style.setProperty(
        "--app-height",
        `${viewport?.height ?? window.innerHeight}px`
      );
      document.documentElement.style.setProperty("--app-top", `${viewport?.offsetTop ?? 0}px`);
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
    };
  }, []);

  useEffect(() => {
    const dialog = settingsDialogRef.current;
    if (isSettingsOpen && auth?.authenticated) dialog?.showModal();
    else dialog?.close();
  }, [isSettingsOpen, auth?.authenticated]);

  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(""), 3000);
      return () => clearTimeout(timer);
    }
  }, [notice]);

  const handleCloseMobileSheet = useCallback(() => {
    setIsMobileSheetOpen(false);
    mobileSheetButtonRef.current?.focus();
  }, []);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Thao tác thất bại.");
    } finally {
      setBusy(false);
    }
  }

  const handleRestartSession = useCallback(
    (sessionId: string) => {
      const target = sessionsState.sessionsById[sessionId];
      const displayName = target ? target.name || target.agentLabel : sessionId.slice(0, 6);
      const folder = target ? target.workingDirectoryLabel || target.projectLabel : "";

      if (
        window.confirm(
          `Khởi động lại sẽ kết thúc tác vụ của phiên ${displayName} (${folder}). Tiếp tục?`
        )
      ) {
        void run(async () => {
          await restartCurrentSession(sessionId);
        });
      }
    },
    [sessionsState.sessionsById, restartCurrentSession]
  );

  const handleKillSession = useCallback(
    (sessionId: string) => {
      const target = sessionsState.sessionsById[sessionId];
      const displayName = target ? target.name || target.agentLabel : sessionId.slice(0, 6);
      const folder = target ? target.workingDirectoryLabel || target.projectLabel : "";

      if (
        window.confirm(
          `Kết thúc phiên ${displayName} (${folder}) và tác vụ đang chạy trong phiên này?`
        )
      ) {
        void run(async () => {
          await killCurrentSession(sessionId);
        });
      }
    },
    [sessionsState.sessionsById, killCurrentSession]
  );

  const handleCreateSession = useCallback(
    async (input: { agentId: string; projectId: string; subpath?: string; name?: string }) => {
      await run(async () => {
        await createNewSession(input);
      });
    },
    [createNewSession]
  );

  function send(data: string): boolean {
    if (!isInputAllowed()) {
      if (sessionsState.connection.control === "viewer") {
        showError("Chỉ xem — phiên đang được điều khiển ở thiết bị khác");
      } else {
        showError("Chưa kết nối hoặc đang đồng bộ dữ liệu.");
      }
      return false;
    }
    return terminalRef.current?.sendInput(data) ?? false;
  }

  function shortcut(data: string) {
    if (data === "\x03") {
      send(data);
      return;
    }
    // Flush the draft before terminal keys so Tab/arrow/Enter act on visible text.
    if (send(draft + data) && draft) updateDraft("");
  }

  function sendDirectKey(data: string) {
    if (!usable) return;
    send(data);
  }

  async function copy() {
    try {
      setNotice(
        (await terminalRef.current?.copy())
          ? "Đã sao chép phần chọn hoặc 500 dòng gần nhất."
          : "Chưa có nội dung để sao chép."
      );
    } catch {
      showError("Trình duyệt chưa cho phép sao chép. Hãy mở trang bằng HTTPS.");
    }
  }

  if (!auth) {
    return (
      <main className="login-page">
        <div className="login-card">
          <h1 className="text-xl">Web CLI</h1>
          <p className="mt-3">{error || "Đang kiểm tra đăng nhập…"}</p>
          {error && (
            <button
              className="primary mt-4"
              onClick={() => void load().catch((err) => showError(err.message))}
            >
              Thử lại
            </button>
          )}
        </div>
      </main>
    );
  }

  if (!auth.authenticated) {
    return (
      <LoginScreen
        setupRequired={auth.setupRequired}
        trustedDevice={auth.trustedDevice}
        hubEnabled={auth.hubEnabled}
        onLogin={load}
        error={error}
      />
    );
  }

  const isConnected = sessionsState.connection.status === "connected";
  const usable =
    activeSession?.state === "running" &&
    isConnected &&
    sessionsState.connection.control === "controller";

  const statusText = (() => {
    if (!activeSession) {
      if (sessionsState.connection.status === "missing") return "Phiên không còn trên máy chủ";
      return "Chưa mở phiên";
    }
    switch (sessionsState.connection.status) {
      case "connected":
        if (activeSession.state === "running") {
          return sessionsState.connection.control === "viewer"
            ? "Chỉ xem (đang điều khiển ở nơi khác)"
            : "Đã kết nối";
        }
        if (activeSession.state === "stopping") return "Đang dừng";
        return "Đã kết thúc";
      case "syncing":
        return "Đang đồng bộ…";
      case "connecting":
        return "Đang kết nối…";
      case "missing":
        return "Phiên không còn trên máy chủ";
      case "disconnected":
        return "Mất kết nối";
      default:
        return "Đang nối lại…";
    }
  })();

  const capacitySummary = `${sessionsState.capacity.active + sessionsState.capacity.reserved}/${
    sessionsState.capacity.max
  } đang dùng`;

  return (
    <main className="controller">
      <header className="controller-header">
        <div className="flex items-center gap-2 min-w-0">
          {/* Desktop sidebar toggle button */}
          <button
            type="button"
            className="control hidden lg:inline-flex min-h-[44px] min-w-[44px] items-center justify-center p-2 text-zinc-300"
            onClick={() => setIsDesktopSidebarCollapsed(!isDesktopSidebarCollapsed)}
            title={isDesktopSidebarCollapsed ? "Mở danh sách phiên" : "Thu gọn danh sách phiên"}
            aria-label={isDesktopSidebarCollapsed ? "Mở danh sách phiên" : "Thu gọn danh sách phiên"}
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h6a1 1 0 110 2H4a1 1 0 01-1-1z"
                clipRule="evenodd"
              />
            </svg>
          </button>

          <div className="min-w-0">
            <h1 className="truncate font-semibold text-zinc-100">
              Web CLI <span className="text-xs font-normal text-zinc-400">· {capacitySummary}</span>
            </h1>
            <p
              role="status"
              className={`text-xs truncate ${
                isConnected ? "text-signal-400" : "text-amber-300"
              }`}
            >
              {statusText}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Mobile open sessions button */}
          <button
            ref={mobileSheetButtonRef}
            className="control min-h-[44px] px-3 font-medium lg:hidden"
            onClick={() => {
              setIsMobileSheetOpen(true);
              void fetchSessions().catch((err) => showError(err.message));
            }}
            aria-label="Mở danh sách phiên"
          >
            Phiên
          </button>

          {/* Settings button */}
          <button
            type="button"
            className="control min-h-[44px] min-w-[44px] items-center justify-center px-2 text-zinc-400 hover:text-zinc-200"
            onClick={() => setIsSettingsOpen(true)}
            aria-label="Cài đặt hệ thống"
            title="Cài đặt hệ thống"
          >
            ⚙️
          </button>
        </div>
      </header>

      {foregroundAttention && (
        <div className="bg-sky-950/80 border-b border-sky-800/80 px-4 py-2 flex items-center justify-between gap-2 text-xs text-sky-200">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-sky-400 animate-ping shrink-0" />
            <span>Codex cần bạn phản hồi. Mở Web CLI để xem yêu cầu xác nhận hoặc câu hỏi.</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              className="px-2.5 py-1 bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white font-medium rounded transition-colors"
              onClick={() => {
                const targetId = foregroundAttention.sessionId;
                setForegroundAttention(null);
                const target = sessionsState.sessionsById[targetId];
                if (target) {
                  switchSession(targetId);
                } else {
                  showError("Phiên không còn trên máy chủ");
                  setIsMobileSheetOpen(true);
                }
              }}
            >
              Mở phiên
            </button>
            <button
              type="button"
              className="p-1 text-sky-400 hover:text-sky-200 text-base leading-none"
              aria-label="Đóng thông báo"
              onClick={() => setForegroundAttention(null)}
            >
              ×
            </button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="controller-error">
          <span>{error}</span>
          <button aria-label="Đóng thông báo" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}

      {/* Main Body: Desktop Sidebar + Terminal Main Area */}
      <div className="controller-body">
        <SessionManager
          isMobileSheetOpen={isMobileSheetOpen}
          isDesktopSidebarCollapsed={isDesktopSidebarCollapsed}
          sessions={sessionList}
          agents={agents}
          projects={projects}
          activeSessionId={activeSession?.id}
          capacity={sessionsState.capacity}
          isBusy={busy}
          onSelectSession={switchSession}
          onReconnectSession={() => setReconnectKey((k) => k + 1)}
          onRestartSession={handleRestartSession}
          onKillSession={handleKillSession}
          onCreateSession={handleCreateSession}
          onCloseMobileSheet={handleCloseMobileSheet}
          onToggleDesktopSidebar={() => setIsDesktopSidebarCollapsed(!isDesktopSidebarCollapsed)}
          pushSettings={pushLifecycle}
        />

        <div className="controller-main">
          <div className="terminal-toolbar">
            <select
              aria-label="Chuyển phiên terminal"
              value={activeSession?.id ?? ""}
              onChange={(e) => {
                if (e.target.value) switchSession(e.target.value);
              }}
              className="min-w-0 flex-1"
            >
              {!activeSession && <option value="">Chọn phiên</option>}
              {sessionList.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.agentLabel} · {item.workingDirectoryLabel || item.projectLabel} ·{" "}
                  {item.id.slice(0, 6)}
                  {item.state === "running"
                    ? ""
                    : item.state === "stopping"
                    ? " (đang dừng)"
                    : " (đã kết thúc)"}
                </option>
              ))}
            </select>
            <button
              className="control min-h-[44px]"
              title="Sao chép phần chọn hoặc 500 dòng cuối"
              aria-label="Sao chép nội dung terminal"
              onClick={() => void copy()}
            >
              Chép
            </button>
            <button
              className="control min-h-[44px]"
              aria-label="Cuộn xuống cuối terminal"
              onClick={() => terminalRef.current?.scrollToBottom()}
            >
              ↓ cuối
            </button>
            {sessionsState.connection.status === "disconnected" && (
              <button
                className="control min-h-[44px] text-emerald-400 font-semibold"
                aria-label="Nối lại phiên"
                onClick={() => setReconnectKey((k) => k + 1)}
              >
                Nối lại
              </button>
            )}
          </div>

          <Suspense fallback={<div className="terminal-pane p-4">Đang tải terminal…</div>}>
            <TerminalPane
              ref={terminalRef}
              session={activeSession}
              connectionGeneration={connectionGeneration}
              onSessionUpdate={handleSessionUpdate}
              onConnectedChange={handleConnectedChange}
              onAttention={addAttention}
              onError={showError}
              onSessionMissing={handleSessionMissing}
              onReconnectExhausted={handleReconnectExhausted}
              fontSize={fontSize}
              reconnectKey={reconnectKey}
            />
          </Suspense>

          <section className="composer">
            <QuickActions
              disabled={!usable}
              agentId={activeSession?.agentId}
              onSend={shortcut}
              onSendKey={sendDirectKey}
            />
            <CommandInput disabled={!usable} value={draft} onChange={updateDraft} onSend={send} />
          </section>
        </div>
      </div>

      {notice && (
        <div role="status" className="toast">
          {notice}
        </div>
      )}

      {/* Settings Dialog (Font size, Hub link, Logout) */}
      <dialog
        ref={settingsDialogRef}
        className="settings-dialog"
        onCancel={() => setIsSettingsOpen(false)}
        onClick={(e) => {
          if (e.target === settingsDialogRef.current) setIsSettingsOpen(false);
        }}
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <h2 className="text-lg font-semibold">Cài đặt</h2>
            <button
              className="control min-h-[44px] min-w-[44px] px-2 text-zinc-400 hover:text-zinc-200"
              onClick={() => setIsSettingsOpen(false)}
              aria-label="Đóng bảng thiết lập"
            >
              ✕
            </button>
          </div>

          <label className="flex items-center justify-between gap-3 text-sm">
            Cỡ chữ terminal
            <select
              aria-label="Cỡ chữ terminal"
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
            >
              {[12, 14, 16, 18, 20].map((size) => (
                <option key={size} value={size}>
                  {size} px
                </option>
              ))}
            </select>
          </label>

          <p className="text-xs text-zinc-400">
            Ô soạn giữ nội dung trước khi gửi. Enter trên bàn phím để xuống dòng; nút Tab gửi phần đang
            soạn vào terminal để hoàn thành lệnh.
          </p>

          {auth.hubEnabled && (
            <a href="/" className="control flex min-h-[44px] w-full items-center justify-center">
              ← Về Server Hub
            </a>
          )}

          <button
            className="control w-full min-h-[44px] text-red-300 hover:bg-red-500/10"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                pushLifecycle.invalidate();
                setForegroundAttention(null);
                try {
                  await logout();
                } catch (error) {
                  void pushLifecycle.resume();
                  throw error;
                }
                clearPushConsent();
                setIsSettingsOpen(false);
                dispatchSessions({ type: "RESET_SESSIONS" });
                setAuth({
                  authenticated: false,
                  setupRequired: false,
                  hubEnabled: auth.hubEnabled
                });
              })
            }
          >
            Đăng xuất · {auth.username}
          </button>
        </div>
      </dialog>
    </main>
  );
}
