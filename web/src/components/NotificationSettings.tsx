import { useState, useEffect } from "react";
import {
  fetchNotificationConfig,
  type NotificationConfig
} from "../lib/api";
import {
  isPushEnvironmentSupported,
  hasPushConsent,
  registerPushNotification,
  unregisterPushNotification,
  testPushNotification,
  type PushState
} from "../lib/push";

interface NotificationSettingsProps {
  onForegroundAttention?: (data: { eventId: string; sessionId: string }) => void;
}

export function NotificationSettings({ onForegroundAttention }: NotificationSettingsProps) {
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [pushState, setPushState] = useState<PushState>("unregistered");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function init() {
      const supported = await isPushEnvironmentSupported();
      if (!supported) {
        if (mounted) setPushState("unsupported");
        return;
      }

      try {
        const conf = await fetchNotificationConfig();
        if (!mounted) return;
        setConfig(conf);

        if (!conf.enabled) {
          setPushState("unconfigured");
          return;
        }

        if (Notification.permission === "denied") {
          setPushState("permission_denied");
          return;
        }

        if (hasPushConsent() && Notification.permission === "granted") {
          setPushState("registered");
        } else {
          setPushState("unregistered");
        }
      } catch {
        if (mounted) {
          setPushState("unconfigured");
        }
      }
    }

    init();
    return () => {
      mounted = false;
    };
  }, []);

  const handleEnable = async () => {
    if (!config || !config.enabled) return;
    setIsBusy(true);
    setPushState("registering");
    setErrorMessage(null);
    setTestMessage(null);

    const result = await registerPushNotification(config, onForegroundAttention);
    setPushState(result.state);
    if (result.error) {
      setErrorMessage(result.error);
    }
    setIsBusy(false);
  };

  const handleDisable = async () => {
    if (!config || !config.enabled) return;
    setIsBusy(true);
    setPushState("unregistering");
    setErrorMessage(null);
    setTestMessage(null);

    const result = await unregisterPushNotification(config);
    setPushState(result.state);
    if (result.error) {
      setErrorMessage(result.error);
    }
    setIsBusy(false);
  };

  const handleTest = async () => {
    setIsBusy(true);
    setTestMessage(null);
    setErrorMessage(null);

    try {
      const result = await testPushNotification();
      if (result.queued) {
        setTestMessage("Đã xếp hàng gửi thử.");
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Gửi thử thất bại.");
    } finally {
      setIsBusy(false);
    }
  };

  const statusLabel: Record<PushState, { text: string; color: string }> = {
    unconfigured: { text: "Chưa cấu hình Firebase", color: "text-slate-400 bg-slate-800/60 border-slate-700" },
    unsupported: { text: "Trình duyệt chưa hỗ trợ", color: "text-amber-300 bg-amber-950/40 border-amber-800/60" },
    unregistered: { text: "Chưa bật trên thiết bị", color: "text-slate-300 bg-slate-800/60 border-slate-700" },
    registering: { text: "Đang đăng ký...", color: "text-sky-300 bg-sky-950/40 border-sky-800/60 animate-pulse" },
    unregistering: { text: "Đang tắt...", color: "text-slate-400 bg-slate-800/60 border-slate-700 animate-pulse" },
    registered: { text: "Đã bật", color: "text-emerald-300 bg-emerald-950/40 border-emerald-800/60" },
    permission_denied: { text: "Quyền bị chặn", color: "text-rose-300 bg-rose-950/40 border-rose-800/60" },
    register_error: { text: "Lỗi đăng ký", color: "text-rose-300 bg-rose-950/40 border-rose-800/60" },
    unregister_error: { text: "Lỗi tắt thông báo", color: "text-rose-300 bg-rose-950/40 border-rose-800/60" }
  };

  const currentStatus = statusLabel[pushState];

  return (
    <div className="p-3 bg-slate-900/60 border border-slate-800 rounded-xl space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-slate-200 tracking-wide uppercase">
            Thông báo đẩy (FCM)
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5 leading-tight">
            Yêu cầu xác nhận/câu hỏi từ Codex; các agent khác chưa hỗ trợ.
          </p>
        </div>
        <span
          className={`px-2 py-0.5 text-[11px] font-medium rounded-full border shrink-0 ${currentStatus.color}`}
        >
          {currentStatus.text}
        </span>
      </div>

      {pushState === "unsupported" && (
        <div className="text-xs text-amber-200/90 bg-amber-950/30 p-2.5 rounded-lg border border-amber-800/40 leading-relaxed">
          Trình duyệt hoặc môi trường chưa hỗ trợ Web Push. Trên iOS/iPadOS, cần thêm ứng dụng vào Màn hình chính (Add to Home Screen) và mở từ biểu tượng đó để sử dụng.
        </div>
      )}

      {pushState === "permission_denied" && (
        <div className="text-xs text-rose-200/90 bg-rose-950/30 p-2.5 rounded-lg border border-rose-800/40 leading-relaxed">
          Quyền thông báo đang bị chặn. Vui lòng mở Cài đặt trang web của trình duyệt để cấp quyền Thông báo cho Web CLI.
        </div>
      )}

      {errorMessage && (
        <div className="text-xs text-rose-300 bg-rose-950/40 p-2 rounded border border-rose-800/50">
          {errorMessage}
        </div>
      )}

      {testMessage && (
        <div className="text-xs text-emerald-300 bg-emerald-950/40 p-2 rounded border border-emerald-800/50">
          {testMessage}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {pushState !== "registered" && pushState !== "unregistering" && (
          <button
            type="button"
            onClick={handleEnable}
            disabled={isBusy || pushState === "unconfigured" || pushState === "unsupported" || pushState === "permission_denied"}
            className="px-3 py-1.5 min-h-[44px] text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 active:bg-sky-700 disabled:opacity-50 disabled:pointer-events-none rounded-lg transition-colors flex items-center gap-1.5"
          >
            Bật thông báo
          </button>
        )}

        {(pushState === "registered" || pushState === "unregister_error") && (
          <>
            <button
              type="button"
              onClick={handleDisable}
              disabled={isBusy}
              className="px-3 py-1.5 min-h-[44px] text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 active:bg-slate-900 border border-slate-700 rounded-lg transition-colors"
            >
              Tắt trên thiết bị này
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={isBusy}
              className="px-3 py-1.5 min-h-[44px] text-xs font-medium text-sky-400 hover:text-sky-300 bg-sky-950/50 hover:bg-sky-900/50 border border-sky-800/60 rounded-lg transition-colors"
            >
              Gửi thử
            </button>
          </>
        )}
      </div>
    </div>
  );
}
