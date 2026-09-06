import type { Session } from "../lib/types";
import { StatusBadge } from "./StatusBadge";

type Props = {
  session?: Session;
  wsConnected: boolean;
  canStart: boolean;
  busy: boolean;
  onStart: () => void;
  onKill: () => void;
  onRestart: () => void;
};

export function SessionControls({ session, wsConnected, canStart, busy, onStart, onKill, onRestart }: Props) {
  return (
    <div className="grid gap-3 border-y border-white/10 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge label={session ? session.state : "idle"} state={session?.state ?? "idle"} />
        <StatusBadge label={wsConnected ? "ws connected" : "ws disconnected"} state={wsConnected ? "connected" : "disconnected"} />
        {session ? <span className="text-xs text-zinc-400">{session.agentLabel} / {session.projectLabel}</span> : null}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={onStart}
          disabled={!canStart || busy}
          className="min-h-12 bg-signal-500 px-3 text-sm font-bold text-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          Start
        </button>
        <button
          type="button"
          onClick={onKill}
          disabled={!session || busy || session.state !== "running"}
          className="min-h-12 border border-red-400/50 bg-red-500/10 px-3 text-sm font-bold text-red-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Kill
        </button>
        <button
          type="button"
          onClick={onRestart}
          disabled={!session || busy}
          className="min-h-12 border border-white/10 bg-white/[0.04] px-3 text-sm font-bold text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Restart
        </button>
      </div>
    </div>
  );
}

