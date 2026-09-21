import { useEffect, useRef, useState } from "react";
import type { AgentConfig, ProjectConfig, Session } from "../lib/types";
import { NewSessionDialog } from "./NewSessionDialog";
import { SessionList } from "./SessionList";
import { NotificationSettings } from "./NotificationSettings";

type Props = {
  isMobileSheetOpen: boolean;
  isDesktopSidebarCollapsed: boolean;
  sessions: Session[];
  agents: AgentConfig[];
  projects: ProjectConfig[];
  activeSessionId?: string;
  capacity: { active: number; reserved: number; max: number };
  isBusy: boolean;
  onSelectSession: (sessionId: string) => void;
  onReconnectSession: (sessionId: string) => void;
  onRestartSession: (sessionId: string) => void;
  onKillSession: (sessionId: string) => void;
  onCreateSession: (input: {
    agentId: string;
    projectId: string;
    subpath?: string;
    name?: string;
  }) => Promise<void>;
  onCloseMobileSheet: () => void;
  onToggleDesktopSidebar: () => void;
  onForegroundAttention?: (data: { eventId: string; sessionId: string }) => void;
};

export function SessionManager({
  isMobileSheetOpen,
  isDesktopSidebarCollapsed,
  sessions,
  agents,
  projects,
  activeSessionId,
  capacity,
  isBusy,
  onSelectSession,
  onReconnectSession,
  onRestartSession,
  onKillSession,
  onCreateSession,
  onCloseMobileSheet,
  onToggleDesktopSidebar,
  onForegroundAttention
}: Props) {
  const mobileDialogRef = useRef<HTMLDialogElement>(null);
  const [isNewDialogOpen, setIsNewDialogOpen] = useState(false);
  const [newDialogPrefill, setNewDialogPrefill] = useState<
    { agentId?: string; projectId?: string; subpath?: string; workingDirectoryId?: string } | undefined
  >();

  const pendingNewSessionRef = useRef<{
    prefill?: { agentId?: string; projectId?: string; subpath?: string; workingDirectoryId?: string };
    returnToSessionManagerOnCancel?: boolean;
  } | null>(null);

  // Handle native dialog open / close for mobile sheet
  useEffect(() => {
    const dialog = mobileDialogRef.current;
    if (!dialog) return;

    if (isMobileSheetOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else {
      if (dialog.open) {
        dialog.close();
      }
    }
  }, [isMobileSheetOpen]);

  const handleMobileDialogClose = () => {
    onCloseMobileSheet();
    const pending = pendingNewSessionRef.current;
    if (pending) {
      pendingNewSessionRef.current = null;
      setNewDialogPrefill(pending.prefill);
      setIsNewDialogOpen(true);
    }
  };

  const handleOpenNewSession = (prefill?: {
    agentId?: string;
    projectId?: string;
    subpath?: string;
    workingDirectoryId?: string;
  }) => {
    if (isMobileSheetOpen) {
      pendingNewSessionRef.current = {
        prefill,
        returnToSessionManagerOnCancel: true
      };
      onCloseMobileSheet();
    } else {
      setNewDialogPrefill(prefill);
      setIsNewDialogOpen(true);
    }
  };

  const handleNewSessionAtFolder = (session: Session) => {
    handleOpenNewSession({
      agentId: session.agentId,
      projectId: session.projectId,
      subpath: session.subpath,
      workingDirectoryId: session.workingDirectoryId
    });
  };

  const capacitySummary = `${capacity.active + capacity.reserved}/${capacity.max} đang sử dụng`;
  const isCapacityFull = capacity.active + capacity.reserved >= capacity.max;

  const sessionContent = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 pb-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Quản lý phiên</h2>
          <p className="text-xs text-zinc-400">{capacitySummary}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isCapacityFull || isBusy}
            onClick={() => handleOpenNewSession()}
            className="control inline-flex min-h-[44px] items-center gap-1.5 px-3 text-xs font-semibold text-signal-400 active:bg-white/15 disabled:opacity-40"
            aria-label="Tạo phiên mới"
          >
            + Phiên mới
          </button>
          {/* Close button for mobile sheet */}
          <button
            type="button"
            className="control min-h-[44px] min-w-[44px] px-2 text-zinc-400 hover:text-zinc-200 lg:hidden"
            onClick={onCloseMobileSheet}
            aria-label="Đóng bảng phiên"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="mt-3 flex-1 overflow-y-auto space-y-4">
        <SessionList
          sessions={sessions}
          agents={agents}
          activeSessionId={activeSessionId}
          isPending={isBusy}
          onSelectSession={(id) => {
            onSelectSession(id);
            onCloseMobileSheet();
          }}
          onReconnectSession={(id) => {
            onReconnectSession(id);
            onCloseMobileSheet();
          }}
          onRestartSession={onRestartSession}
          onKillSession={onKillSession}
          onNewSessionAtFolder={handleNewSessionAtFolder}
          onOpenNewSessionDialog={() => handleOpenNewSession()}
        />

        <div className="pt-2 border-t border-white/10">
          <NotificationSettings onForegroundAttention={onForegroundAttention} />
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar (hidden on screens < 1024px) */}
      <aside
        className={`hidden lg:flex lg:flex-col border-r border-white/10 bg-shell-900 transition-all duration-200 ${
          isDesktopSidebarCollapsed ? "w-0 p-0 overflow-hidden border-none" : "w-[280px] p-3 shrink-0"
        }`}
        aria-label="Thanh bên quản lý phiên"
      >
        {!isDesktopSidebarCollapsed && sessionContent}
      </aside>

      {/* Mobile Bottom Sheet Modal (hidden on screens >= 1024px) */}
      <dialog
        ref={mobileDialogRef}
        className="mobile-session-sheet lg:hidden"
        onCancel={onCloseMobileSheet}
        onClose={handleMobileDialogClose}
        onClick={(e) => {
          if (e.target === mobileDialogRef.current) onCloseMobileSheet();
        }}
      >
        <div className="flex h-full max-h-[85dvh] flex-col p-4">
          {sessionContent}
        </div>
      </dialog>

      {/* New Session Dialog */}
      <NewSessionDialog
        isOpen={isNewDialogOpen}
        agents={agents}
        projects={projects}
        existingSessions={sessions}
        capacity={capacity}
        prefill={newDialogPrefill}
        isBusy={isBusy}
        onClose={() => setIsNewDialogOpen(false)}
        onSubmit={async (input) => {
          await onCreateSession(input);
          setIsNewDialogOpen(false);
          onCloseMobileSheet();
        }}
      />
    </>
  );
}
