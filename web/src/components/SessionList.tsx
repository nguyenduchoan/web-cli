import { useMemo, useState } from "react";
import type { AgentConfig, Session } from "../lib/types";
import { SessionItem } from "./SessionItem";

type Props = {
  sessions: Session[];
  agents: AgentConfig[];
  activeSessionId?: string;
  isPending: boolean;
  onSelectSession: (sessionId: string) => void;
  onReconnectSession: (sessionId: string) => void;
  onRestartSession: (sessionId: string) => void;
  onKillSession: (sessionId: string) => void;
  onNewSessionAtFolder?: (session: Session) => void;
  onOpenNewSessionDialog: () => void;
};

type GroupedSessions = {
  running: Record<string, { label: string; items: Session[] }>;
  stopping: Record<string, { label: string; items: Session[] }>;
  recent: Record<string, { label: string; items: Session[] }>;
};

export function SessionList({
  sessions,
  agents,
  activeSessionId,
  isPending,
  onSelectSession,
  onReconnectSession,
  onRestartSession,
  onKillSession,
  onNewSessionAtFolder,
  onOpenNewSessionDialog
}: Props) {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedAgentFilter, setSelectedAgentFilter] = useState("all");

  const filteredSessions = useMemo(() => {
    let result = sessions;

    if (selectedAgentFilter !== "all") {
      result = result.filter((s) => s.agentId === selectedAgentFilter);
    }

    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase().trim();
      result = result.filter((s) => {
        const name = (s.name || s.agentLabel).toLowerCase();
        const agent = s.agentLabel.toLowerCase();
        const folder = (s.workingDirectoryLabel || s.projectLabel).toLowerCase();
        const id = s.id.toLowerCase();
        return name.includes(q) || agent.includes(q) || folder.includes(q) || id.includes(q);
      });
    }

    return result;
  }, [sessions, searchTerm, selectedAgentFilter]);

  const grouped = useMemo((): GroupedSessions => {
    const groups: GroupedSessions = {
      running: {},
      stopping: {},
      recent: {}
    };

    for (const session of filteredSessions) {
      let targetSection: Record<string, { label: string; items: Session[] }>;
      if (session.state === "running" || session.state === "idle") {
        targetSection = groups.running;
      } else if (session.state === "stopping") {
        targetSection = groups.stopping;
      } else {
        targetSection = groups.recent;
      }

      const dirId = session.workingDirectoryId || "default";
      const dirLabel = session.workingDirectoryLabel || session.projectLabel;

      if (!targetSection[dirId]) {
        targetSection[dirId] = { label: dirLabel, items: [] };
      }
      targetSection[dirId].items.push(session);
    }

    // Sort items inside each group by createdAt ascending, then id
    for (const section of [groups.running, groups.stopping, groups.recent]) {
      for (const dirId of Object.keys(section)) {
        section[dirId].items.sort((a, b) => {
          const d = a.createdAt.localeCompare(b.createdAt);
          if (d !== 0) return d;
          return a.id.localeCompare(b.id);
        });
      }
    }

    return groups;
  }, [filteredSessions]);

  const renderSection = (title: string, sectionGroups: Record<string, { label: string; items: Session[] }>) => {
    const dirKeys = Object.keys(sectionGroups);
    if (dirKeys.length === 0) return null;

    return (
      <div className="mb-4">
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-zinc-400">{title}</h3>
        <div className="space-y-3">
          {dirKeys.map((dirId) => {
            const { label, items } = sectionGroups[dirId];
            return (
              <div key={dirId} className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                  <svg className="h-3.5 w-3.5 text-zinc-500" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                  </svg>
                  <span className="truncate font-medium text-zinc-300">{label}</span>
                </div>
                <div className="space-y-2">
                  {items.map((session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      isActive={session.id === activeSessionId}
                      isPending={isPending}
                      onSelect={onSelectSession}
                      onReconnect={onReconnectSession}
                      onRestart={onRestartSession}
                      onKill={onKillSession}
                      onNewSessionAtFolder={onNewSessionAtFolder}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const hasAnySession = sessions.length > 0;
  const hasFilteredSession =
    Object.keys(grouped.running).length > 0 ||
    Object.keys(grouped.stopping).length > 0 ||
    Object.keys(grouped.recent).length > 0;

  return (
    <div className="session-list flex flex-col space-y-3">
      {/* Search and Filter Toolbar */}
      {hasAnySession && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <input
              type="search"
              aria-label="Tìm kiếm phiên"
              placeholder="Tìm tên, agent, thư mục…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-11 w-full rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-signal-400"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm("")}
                className="absolute right-2.5 top-2.5 text-xs text-zinc-400 hover:text-zinc-200"
                aria-label="Xóa tìm kiếm"
              >
                ✕
              </button>
            )}
          </div>

          <select
            aria-label="Lọc theo agent"
            value={selectedAgentFilter}
            onChange={(e) => setSelectedAgentFilter(e.target.value)}
            className="h-11 rounded-lg border border-white/10 bg-shell-900 px-2 text-sm text-zinc-300"
          >
            <option value="all">Tất cả agent</option>
            {agents.map((ag) => (
              <option key={ag.id} value={ag.id}>
                {ag.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* List content */}
      {!hasAnySession ? (
        <div className="rounded-xl border border-dashed border-white/15 p-6 text-center">
          <p className="text-sm text-zinc-400">Chưa có phiên nào trên máy chủ.</p>
          <button
            type="button"
            className="primary mt-4 inline-flex min-h-[44px] items-center justify-center px-4"
            onClick={onOpenNewSessionDialog}
          >
            Tạo phiên đầu tiên
          </button>
        </div>
      ) : !hasFilteredSession ? (
        <div className="rounded-lg border border-white/10 p-4 text-center text-sm text-zinc-400">
          Không tìm thấy phiên phù hợp với điều kiện lọc.
        </div>
      ) : (
        <div className="session-groups overflow-y-auto">
          {renderSection("Đang chạy", grouped.running)}
          {renderSection("Đang dừng", grouped.stopping)}
          {renderSection("Gần đây", grouped.recent)}
        </div>
      )}
    </div>
  );
}
