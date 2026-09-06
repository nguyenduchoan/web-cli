import type { SessionState } from "../lib/types";

const styles: Record<SessionState | "disconnected" | "connected", string> = {
  idle: "bg-zinc-700 text-zinc-100",
  running: "bg-signal-500 text-black",
  stopping: "bg-warn-400 text-black",
  exited: "bg-zinc-600 text-zinc-100",
  error: "bg-red-500 text-white",
  disconnected: "bg-warn-400 text-black",
  connected: "bg-signal-500 text-black"
};

type Props = {
  label: string;
  state: SessionState | "disconnected" | "connected";
};

export function StatusBadge({ label, state }: Props) {
  return (
    <span className={`inline-flex min-h-7 items-center rounded-full px-3 text-xs font-semibold ${styles[state]}`}>
      {label}
    </span>
  );
}
