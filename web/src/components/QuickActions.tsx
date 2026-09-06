const actions = [
  { label: "Ctrl+C", value: "\x03", title: "Ngắt tác vụ đang chạy" },
  { label: "Tab", value: "\t", title: "Hoàn thành lệnh" },
  { label: "Enter", value: "\r", title: "Gửi phím Enter" },
  { label: "↑", value: "\x1b[A", title: "Lệnh trước / di chuyển lên" },
  { label: "↓", value: "\x1b[B", title: "Lệnh sau / di chuyển xuống" },
  { label: "←", value: "\x1b[D", title: "Di chuyển trái" },
  { label: "→", value: "\x1b[C", title: "Di chuyển phải" },
  { label: "Esc", value: "\x1b", title: "Thoát lựa chọn" },
];
export function QuickActions({ disabled, onSend }: { disabled: boolean; onSend: (data: string) => void }) {
  return <div className="shortcut-row" aria-label="Phím tắt terminal">
    {actions.map((action) => <button key={action.label} type="button" disabled={disabled} title={action.title} aria-label={action.title} onPointerDown={(e) => e.preventDefault()} onClick={() => onSend(action.value)} className="control shrink-0">{action.label}</button>)}
  </div>;
}
