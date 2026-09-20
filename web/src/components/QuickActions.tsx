const CODEX_SHIFT_LEFT = "\x1b[1;2D";

const actions = [
  { label: "Ctrl+C", value: "\x03", title: "Ngắt tác vụ đang chạy" },
  { label: "Tab", value: "\t", title: "Hoàn thành lệnh" },
  { label: "Enter", value: "\r", title: "Gửi phím Enter" },
  { label: "↑", value: "\x1b[A", title: "Lệnh trước / di chuyển lên" },
  { label: "↓", value: "\x1b[B", title: "Lệnh sau / di chuyển xuống" },
  { label: "←", value: "\x1b[D", title: "Di chuyển trái" },
  { label: "→", value: "\x1b[C", title: "Di chuyển phải" },
  { label: "Esc", value: "\x1b", title: "Thoát lựa chọn" }
];

export interface QuickActionsProps {
  disabled: boolean;
  agentId?: string;
  onSend: (data: string) => void;
  onSendKey?: (data: string) => void;
}

export function QuickActions({ disabled, agentId, onSend, onSendKey }: QuickActionsProps) {
  const isCodex = agentId === "codex";

  return (
    <div className="shortcut-row" aria-label="Phím tắt terminal">
      {isCodex && (
        <button
          type="button"
          disabled={disabled}
          title="Shift + mũi tên trái — trả lời câu hỏi Codex"
          aria-label="Shift + mũi tên trái — trả lời câu hỏi Codex"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => (onSendKey ? onSendKey(CODEX_SHIFT_LEFT) : onSend(CODEX_SHIFT_LEFT))}
          className="control shrink-0 border-signal-400/40 text-signal-400 font-semibold"
        >
          Shift + ←
        </button>
      )}
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          disabled={disabled}
          title={action.title}
          aria-label={action.title}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onSend(action.value)}
          className="control shrink-0"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
