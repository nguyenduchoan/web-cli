import type { AgentConfig } from "../lib/types";

type Props = {
  agents: AgentConfig[];
  selectedAgentId?: string;
  onSelect: (agentId: string) => void;
};

export function AgentTabs({ agents, selectedAgentId, onSelect }: Props) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Agent selection">
      {agents.map((agent) => {
        const active = agent.id === selectedAgentId;
        return (
          <button
            key={agent.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(agent.id)}
            className={`min-h-11 shrink-0 border px-4 text-sm font-semibold transition ${
              active
                ? "border-signal-400 bg-signal-500 text-black"
                : "border-white/10 bg-white/[0.04] text-zinc-200 active:bg-white/10"
            }`}
          >
            {agent.label}
          </button>
        );
      })}
    </div>
  );
}

