import { FormEvent, useState } from "react";
import { beginSetup, confirmSetup, login, type Enrollment } from "../lib/api";

type Props = { setupRequired: boolean; trustedDevice?: boolean; onLogin: () => Promise<void>; error?: string };
export function LoginScreen({ setupRequired, trustedDevice, onLogin, error }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(error ?? "");
  const [recoveryMode, setRecoveryMode] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      if (setupRequired && !enrollment) {
        setEnrollment(await beginSetup(setupCode.trim(), username, password));
        setPassword(""); setSetupCode("");
      } else if (enrollment) {
        const result = await confirmSetup(enrollment.enrollmentId, code);
        setEnrollment(undefined); setRecoveryCodes(result.recoveryCodes); setCode("");
      } else { await login(username, password, code); setPassword(""); setCode(""); await onLogin(); }
    } catch (err) { setMessage(err instanceof Error ? err.message : "Không thể đăng nhập."); }
    finally { setBusy(false); }
  }
  async function copySecret() {
    try { await navigator.clipboard.writeText(enrollment!.secret); setMessage("Đã sao chép khóa thiết lập."); }
    catch { setMessage("Hãy nhấn giữ khóa bên dưới để sao chép."); }
  }
  function downloadRecovery() {
    const url = URL.createObjectURL(new Blob(["Web CLI — mã khôi phục, mỗi mã chỉ dùng một lần cùng mật khẩu:\n" + recoveryCodes!.join("\n")], { type: "text/plain" }));
    const a = document.createElement("a"); a.href = url; a.download = "web-cli-recovery.txt"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <main className="login-page">
    <form onSubmit={submit} className="login-card">
      <p className="text-sm font-semibold text-signal-400">MÁY CHỦ CỦA BẠN</p>
      <h1 className="mt-2 text-2xl font-semibold">Web CLI</h1>
      <p className="mt-2 text-sm text-zinc-300">{recoveryCodes ? "Lưu các mã khôi phục trước khi tiếp tục. Mỗi mã dùng được một lần nếu mất ứng dụng xác thực." : enrollment ? "Thêm Web CLI vào ứng dụng xác thực, rồi nhập mã sáu số để hoàn tất." : setupRequired ? "Tạo tài khoản chủ máy và bật xác thực hai bước (2FA). Đây là bước thiết lập một lần." : trustedDevice ? "Thiết bị này đã được ghi nhớ. Chỉ cần nhập mã xác thực hai bước (2FA)." : "Đăng nhập bằng tài khoản, mật khẩu và mã xác thực hai bước (2FA)."}</p>
      {recoveryCodes ? <>
        <pre className="my-4 select-all overflow-x-auto rounded bg-black/50 p-3 text-sm">{recoveryCodes.join("\n")}</pre>
        <button type="button" className="control w-full" onClick={downloadRecovery}>Tải mã khôi phục</button>
        <button type="button" className="primary mt-3 w-full" onClick={() => void onLogin().catch((err) => setMessage(String(err)))}>Đã lưu, mở terminal</button>
      </> : <>
        {enrollment ? <div className="mt-4 space-y-3">
          <img src={enrollment.qr} width="240" height="240" className="mx-auto rounded-lg" alt="Mã QR để thêm Web CLI vào ứng dụng xác thực" />
          <a className="control flex items-center justify-center" href={enrollment.uri}>Mở ứng dụng xác thực trên điện thoại</a>
          <p className="text-xs text-zinc-400">Hoặc thêm khóa thủ công nếu ứng dụng không mở:</p>
          <code className="block select-all break-all text-sm">{enrollment.secret}</code>
          <button type="button" className="control w-full" onClick={() => void copySecret()}>Sao chép khóa</button>
        </div> : <>
          {setupRequired && <label className="field-label">Mã thiết lập một lần
            <input autoComplete="off" type="password" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} required />
            <span className="text-xs font-normal text-zinc-400">Mã do chủ máy lấy từ tệp thiết lập riêng trên máy chủ.</span>
          </label>}
          {(!trustedDevice || setupRequired) && <><label className="field-label">Tài khoản<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required pattern={setupRequired ? "[a-zA-Z0-9_.-]{3,40}" : undefined} maxLength={40} /></label>
          <label className="field-label">Mật khẩu{setupRequired ? " (ít nhất 12 ký tự)" : ""}<input name="password" type="password" autoComplete={setupRequired ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={setupRequired ? 12 : undefined} maxLength={256} /></label></>}
        </>}
        {(!setupRequired || enrollment) && <label className="field-label">{recoveryMode ? "Mã khôi phục" : "Mã xác thực sáu số"}<input name="code" inputMode={recoveryMode ? "text" : "numeric"} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required pattern={recoveryMode ? undefined : "[0-9]{6}"} maxLength={recoveryMode ? 40 : 6} /></label>}
        {!setupRequired && <button type="button" className="mt-2 min-h-11 text-sm text-signal-400" onClick={() => { setRecoveryMode(!recoveryMode); setCode(""); }}>{recoveryMode ? "Dùng mã từ ứng dụng" : "Tôi cần dùng mã khôi phục"}</button>}
        <button className="primary mt-4 w-full" disabled={busy}>{busy ? "Đang kiểm tra…" : enrollment ? "Xác nhận và bật 2FA" : setupRequired ? "Thiết lập 2FA" : "Đăng nhập"}</button>
      </>}
      {message && <p role="status" className="mt-3 text-sm text-amber-200">{message}</p>}
    </form>
  </main>;
}
