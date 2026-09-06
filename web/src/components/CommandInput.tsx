import { FormEvent } from "react";
type Props = { disabled: boolean; value: string; onChange: (value: string) => void; onSend: (data: string) => boolean };
export function CommandInput({ disabled, value, onChange, onSend }: Props) {
  function submit(event: FormEvent) { event.preventDefault(); if (!disabled && value && onSend(value + "\r")) onChange(""); }
  return <form onSubmit={submit} className="flex min-w-0 items-end gap-2">
    <label htmlFor="command-input" className="sr-only">Soạn lệnh hoặc tin nhắn; Enter để xuống dòng</label>
    <textarea id="command-input" rows={2} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} maxLength={8000} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" placeholder="Soạn lệnh / tin nhắn…" className="command-input" />
    <button type="submit" disabled={disabled || !value} onPointerDown={(e) => e.preventDefault()} className="primary shrink-0">Gửi</button>
  </form>;
}
