import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentConfig, ProjectConfig, Session } from "../lib/types";
import { AgentTabs } from "./AgentTabs";
import { ProjectSelector } from "./ProjectSelector";

type Props = {
  isOpen: boolean;
  agents: AgentConfig[];
  projects: ProjectConfig[];
  existingSessions: Session[];
  capacity: { active: number; reserved: number; max: number };
  prefill?: { agentId?: string; projectId?: string; subpath?: string; workingDirectoryId?: string };
  isBusy: boolean;
  onClose: () => void;
  onSubmit: (input: {
    agentId: string;
    projectId: string;
    subpath?: string;
    name?: string;
  }) => Promise<void>;
};

export function NewSessionDialog({
  isOpen,
  agents,
  projects,
  existingSessions,
  capacity,
  prefill,
  isBusy,
  onClose,
  onSubmit
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const lastAgentIdRef = useRef<string>("");
  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    prefill?.agentId || (agents.length > 0 ? agents[0].id : "shell")
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selectedSubpath, setSelectedSubpath] = useState<string | undefined>();
  const [selectedWorkingDirectoryId, setSelectedWorkingDirectoryId] = useState<string>("");
  const [sessionName, setSessionName] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (isOpen) {
      if (prefill) {
        setSelectedAgentId(prefill.agentId || lastAgentIdRef.current || (agents[0]?.id ?? "shell"));
        setSelectedProjectId(prefill.projectId || (projects[0]?.id ?? ""));
        setSelectedSubpath(prefill.subpath);
        setSelectedWorkingDirectoryId(prefill.workingDirectoryId || "");
      } else {
        const agent = lastAgentIdRef.current || (agents[0]?.id ?? "shell");
        setSelectedAgentId(agent);
        const defaultProj = projects[0];
        setSelectedProjectId(defaultProj?.id || "");
        setSelectedSubpath(undefined);
        setSelectedWorkingDirectoryId(defaultProj?.workingDirectoryId || "");
      }
      setSessionName("");
      setError("");
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [isOpen, prefill, projects, agents]);

  const isCapacityFull = capacity.active + capacity.reserved >= capacity.max;

  // Same-folder conflict warning check via canonical workingDirectoryId
  const conflictingSessions = useMemo(() => {
    if (selectedAgentId === "shell") return [];
    if (!selectedWorkingDirectoryId) return [];

    return existingSessions.filter((s) => {
      if (s.agentId === "shell") return false;
      if (s.state !== "running" && s.state !== "idle" && s.state !== "stopping") return false;
      return s.workingDirectoryId === selectedWorkingDirectoryId;
    });
  }, [selectedAgentId, selectedWorkingDirectoryId, existingSessions]);

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId) {
      setError("Vui lòng chọn thư mục dự án.");
      return;
    }
    if (isCapacityFull) {
      setError("Đã đạt giới hạn số phiên tối đa trên máy chủ.");
      return;
    }

    setError("");
    try {
      await onSubmit({
        agentId: selectedAgentId,
        projectId: selectedProjectId,
        subpath: selectedSubpath,
        name: sessionName.trim() || undefined
      });
      setSessionName("");
      onClose();
    } catch (err) {
      // Form fields are preserved on failure
      setError(err instanceof Error ? err.message : "Tạo phiên thất bại.");
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog new-session-dialog"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <form onSubmit={handleFormSubmit} className="space-y-4">
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <h2 className="text-lg font-semibold text-zinc-100">Tạo phiên mới</h2>
          <button
            type="button"
            className="control min-h-[44px] min-w-[44px] px-2 text-zinc-400 hover:text-zinc-200"
            onClick={onClose}
            aria-label="Đóng dialog tạo phiên mới"
          >
            ✕
          </button>
        </div>

        {error && (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
            {error}
          </div>
        )}

        {isCapacityFull && (
          <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
            Máy chủ đã đạt công suất tối đa ({capacity.active + capacity.reserved}/{capacity.max} phiên đang sử dụng).
            Hãy kết thúc một phiên đang chạy trước khi tạo mới.
          </div>
        )}

        {/* Step 1: Agent selection */}
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase text-zinc-400">1. Chọn Agent</label>
          <AgentTabs
            agents={agents}
            selectedAgentId={selectedAgentId}
            onSelect={(id) => {
              lastAgentIdRef.current = id;
              setSelectedAgentId(id);
            }}
          />
        </div>

        {/* Step 2: Project & Subpath selection */}
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase text-zinc-400">2. Chọn Dự án & Thư mục</label>
          <ProjectSelector
            token=""
            projects={projects}
            selectedProjectId={selectedProjectId}
            selectedSubpath={selectedSubpath}
            onSelect={(projId, sub, workingDirectoryId) => {
              setSelectedProjectId(projId);
              setSelectedSubpath(sub);
              if (workingDirectoryId) {
                setSelectedWorkingDirectoryId(workingDirectoryId);
              } else {
                const proj = projects.find((p) => p.id === projId);
                setSelectedWorkingDirectoryId(proj?.workingDirectoryId || "");
              }
            }}
          />
        </div>

        {/* Inline Same-folder conflict warning */}
        {conflictingSessions.length > 0 && (
          <div
            role="status"
            className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-200"
          >
            <p className="font-semibold text-amber-300">
              ⚠️ Các phiên này dùng chung tệp. Thay đổi có thể xung đột:
            </p>
            <ul className="mt-1 list-disc pl-4 space-y-0.5 text-zinc-300">
              {conflictingSessions.slice(0, 3).map((s) => (
                <li key={s.id} className="truncate">
                  {s.name || s.agentLabel} ({s.id.slice(0, 6)})
                </li>
              ))}
              {conflictingSessions.length > 3 && (
                <li>và {conflictingSessions.length - 3} phiên khác…</li>
              )}
            </ul>
          </div>
        )}

        {/* Step 3: Optional session name */}
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase text-zinc-400">
            3. Tên phiên (tùy chọn)
          </label>
          <input
            type="text"
            placeholder="Ví dụ: Fix bug mobile, Test prompt…"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            className="h-11 w-full rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-signal-400"
            maxLength={60}
          />
        </div>

        {/* Submit & Cancel actions */}
        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            className="control min-h-[44px] flex-1"
            onClick={onClose}
          >
            Hủy
          </button>
          <button
            type="submit"
            disabled={isBusy || !selectedProjectId || isCapacityFull}
            className="primary min-h-[44px] flex-1 font-semibold disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isBusy ? "Đang tạo phiên…" : "Xác nhận tạo phiên"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
