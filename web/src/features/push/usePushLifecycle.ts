import { useCallback, useEffect, useRef, useState } from "react";
import { fetchNotificationConfig, type NotificationConfig } from "../../lib/api";
import {
  cleanupPushListeners,
  hasPushConsent,
  refreshPushRegistration,
  registerPushNotification,
  unregisterPushNotification,
  testPushNotification,
  type PushState
} from "../../lib/push";

type Attention = { eventId: string; sessionId: string };
type Snapshot = {
  config: NotificationConfig | null;
  pushState: PushState;
  errorMessage: string | null;
  testMessage: string | null;
  isBusy: boolean;
};

export type PushSettingsModel = Snapshot & {
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  test: () => Promise<void>;
};

const initialSnapshot: Snapshot = {
  config: null,
  pushState: "unregistered",
  errorMessage: null,
  testMessage: null,
  isBusy: false
};

// App is the sole owner. Settings views only receive this shared state/actions.
export function usePushLifecycle(isAuthenticated: boolean, onForegroundAttention: (event: Attention) => void) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot);
  const authenticatedRef = useRef(isAuthenticated);
  const attentionRef = useRef(onForegroundAttention);
  const mountedRef = useRef(false);
  const activeRef = useRef(false);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const configRef = useRef<NotificationConfig | null>(null);
  const configRequestRef = useRef<AbortController | null>(null);
  authenticatedRef.current = isAuthenticated;
  attentionRef.current = onForegroundAttention;

  const invalidate = useCallback(() => {
    generationRef.current++;
    activeRef.current = false;
    busyRef.current = false;
    configRef.current = null;
    configRequestRef.current?.abort();
    configRequestRef.current = null;
    cleanupPushListeners();
    if (mountedRef.current) setSnapshot(initialSnapshot);
  }, []);

  const isCurrent = useCallback((generation: number) =>
    mountedRef.current && activeRef.current && authenticatedRef.current && generationRef.current === generation, []);

  const foregroundHandler = useCallback((generation: number) => (event: Attention) => {
    if (isCurrent(generation)) attentionRef.current(event);
  }, [isCurrent]);

  const resume = useCallback(async () => {
    invalidate();
    if (!mountedRef.current || !authenticatedRef.current) return;
    activeRef.current = true;
    busyRef.current = true;
    const generation = generationRef.current;
    const controller = new AbortController();
    configRequestRef.current = controller;
    setSnapshot({ ...initialSnapshot, isBusy: true });
    try {
      const config = await fetchNotificationConfig("", controller.signal);
      if (!isCurrent(generation)) return;
      configRef.current = config;
      setSnapshot({
        ...initialSnapshot,
        config,
        pushState: config.enabled && hasPushConsent() ? "registering" : "unregistered",
        isBusy: true
      });
      const result = await refreshPushRegistration(config, foregroundHandler(generation));
      if (!isCurrent(generation)) return;
      setSnapshot(current => ({ ...current, pushState: result.state, errorMessage: result.error ?? null }));
    } catch (error) {
      if (!isCurrent(generation)) return;
      setSnapshot(current => ({
        ...current,
        pushState: "register_error",
        errorMessage: error instanceof Error ? error.message : "Không thể tải cấu hình thông báo."
      }));
    } finally {
      if (configRequestRef.current === controller) configRequestRef.current = null;
      if (isCurrent(generation)) {
        busyRef.current = false;
        setSnapshot(current => ({ ...current, isBusy: false }));
      }
    }
  }, [foregroundHandler, invalidate, isCurrent]);

  useEffect(() => {
    mountedRef.current = true;
    void resume();
    return () => {
      mountedRef.current = false;
      // Unmount/StrictMode cleanup must preserve the user's stored consent.
      invalidate();
    };
  }, [isAuthenticated, invalidate, resume]);

  const changeRegistration = useCallback(async (enable: boolean) => {
    if (!activeRef.current || !authenticatedRef.current || busyRef.current) return;
    // Ref locking also covers two settings buttons clicked before React commits.
    busyRef.current = true;
    const generation = generationRef.current;
    setSnapshot(current => ({ ...current, isBusy: true, errorMessage: null, testMessage: null,
      pushState: enable ? "registering" : "unregistering" }));
    try {
      const config = configRef.current ?? await fetchNotificationConfig();
      if (!isCurrent(generation)) return;
      configRef.current = config;
      const result = enable
        ? await registerPushNotification(config, foregroundHandler(generation))
        : await unregisterPushNotification(config);
      if (!isCurrent(generation)) return;
      setSnapshot(current => ({ ...current, config, pushState: result.state, errorMessage: result.error ?? null }));
    } catch (error) {
      if (!isCurrent(generation)) return;
      setSnapshot(current => ({ ...current, pushState: enable ? "register_error" : "unregister_error",
        errorMessage: error instanceof Error ? error.message : "Không thể cập nhật thông báo." }));
    } finally {
      if (isCurrent(generation)) {
        busyRef.current = false;
        setSnapshot(current => ({ ...current, isBusy: false }));
      }
    }
  }, [foregroundHandler, isCurrent]);

  const enable = useCallback(() => changeRegistration(true), [changeRegistration]);
  const disable = useCallback(() => changeRegistration(false), [changeRegistration]);
  const test = useCallback(async () => {
    if (!activeRef.current || !authenticatedRef.current || busyRef.current) return;
    busyRef.current = true;
    const generation = generationRef.current;
    setSnapshot(current => ({ ...current, isBusy: true, errorMessage: null, testMessage: null }));
    try {
      const result = await testPushNotification();
      if (isCurrent(generation) && result.queued) {
        setSnapshot(current => ({ ...current, testMessage: "Đã xếp hàng gửi thử." }));
      }
    } catch (error) {
      if (isCurrent(generation)) setSnapshot(current => ({ ...current,
        errorMessage: error instanceof Error ? error.message : "Gửi thử thất bại." }));
    } finally {
      if (isCurrent(generation)) {
        busyRef.current = false;
        setSnapshot(current => ({ ...current, isBusy: false }));
      }
    }
  }, [isCurrent]);

  return { ...snapshot, enable, disable, test, invalidate, resume };
}
