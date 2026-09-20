import type { Session } from "../lib/types";

type Props = {
  session: Session;
  isActive: boolean;
  isPending: boolean;
  onSelect: (sessionId: string) => void;
  onReconnect: (sessionId: string) => void;
  onRestart: (sessionId: string) => void;
  onKill: (sessionId: string) => void;
  onNewSessionAtFolder?: (session: Session) => void;
};

export function SessionItem({
  session,
  isActive,
  isPending,
  onSelect,
  onReconnect,
  onRestart,
  onKill,
  onNewSessionAtFolder
}: Props) {
  const getStatusDisplay = () => {
    switch (session.state) {
      case "running":
      case "idle":
        return {
          dotClass: "bg-emerald-400",
          text: "Đang chạy"
        };
      case "stopping":
        return {
          dotClass: "bg-amber-400 animate-pulse",
          text: session.stopTimedOut ? "Dừng quá hạn" : "Đang dừng"
        };
      case "error":
        return {
          dotClass: "bg-red-400",
          text: session.exitReason === "spawn_error" ? "Lỗi khởi chạy" : "Lỗi"
        };
      case "exited":
      default:
        return {
          dotClass: "bg-zinc-500",
          text: "Đã kết thúc"
        };
    }
  };

  const status = getStatusDisplay();
  const displayName = session.name || session.agentLabel;
  const folderLabel = session.workingDirectoryLabel || session.projectLabel;
  const shortId = session.id.slice(0, 6);

  const canRestart = !isPending && (session.state !== "stopping" || Boolean(session.stopTimedOut));
  const canKill = !isPending && session.state === "running";

  return (
    <div
      aria-current={isActive ? "true" : undefined}
      className={`session-item group relative rounded-lg border p-3 transition-colors ${
        isActive
          ? "border-signal-400/60 bg-signal-500/10"
          : "border-white/10 bg-shell-800/60 hover:border-white/20 hover:bg-shell-800"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${status.dotClass}`} />
            <h4 className="truncate text-sm font-semibold text-zinc-100">{displayName}</h4>
            <span className="font-mono text-xs text-zinc-400">{shortId}</span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-zinc-400">
            <span className="text-zinc-300">{session.agentLabel}</span>
            <span>·</span>
            <span className="truncate">{folderLabel}</span>
            <span>·</span>
            <span className="text-zinc-300">{status.text}</span>
          </div>

          {session.attention && (
            <div className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-300">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-400 animate-ping" />
              <span>Có nhắc phản hồi</span>
            </div>
          )}

          {session.error && (
            <p className="mt-1 truncate text-xs text-red-300" title={session.error}>
              {session.error}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-white/5 pt-2">
        {!isActive ? (
          <button
            type="button"
            className="control min-h-[44px] flex-1 py-1 text-xs font-semibold active:bg-white/15"
            onClick={() => onSelect(session.id)}
            aria-label={`Mở phiên ${displayName}`}
          >
            Mở
          </button>
        ) : (
          <button
            type="button"
            className="control min-h-[44px] flex-1 py-1 text-xs font-semibold text-signal-400 active:bg-white/15"
            onClick={() => onReconnect(session.id)}
            aria-label={`Nối lại phiên ${displayName}`}
          >
            Nối lại
          </button>
        )}

        <button
          type="button"
          disabled={!canRestart}
          className="control min-h-[44px] px-2.5 py-1 text-xs active:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => onRestart(session.id)}
          aria-label={`Khởi động lại phiên ${displayName}`}
        >
          Khởi động lại
        </button>

        {session.state === "running" && (
          <button
            type="button"
            disabled={!canKill}
            className="control min-h-[44px] px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10 active:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => onKill(session.id)}
            aria-label={`Kết thúc phiên ${displayName}`}
          >
            Kết thúc
          </button>
        )}

        {onNewSessionAtFolder && (
          <button
            type="button"
            className="control min-h-[44px] px-2.5 py-1 text-xs text-zinc-300 active:bg-white/15"
            onClick={() => onNewSessionAtFolder(session)}
            title="Tạo phiên mới trong thư mục này"
            aria-label={`Thêm phiên ở thư mục ${folderLabel}`}
          >
            + Ở đây
          </button>
        )}
      </div>
    </div>
  );
}
