import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getMessaging,
  isSupported as isFirebaseMessagingSupported,
  onMessage,
  onRegistered,
  register,
  unregister,
  type Messaging
} from "firebase/messaging";
import {
  registerPushDevice,
  unregisterPushDevice,
  sendTestNotification,
  type NotificationConfig
} from "./api";

export type PushState =
  | "unconfigured"
  | "unsupported"
  | "unregistered"
  | "registering"
  | "unregistering"
  | "registered"
  | "permission_denied"
  | "register_error"
  | "unregister_error";

const DEVICE_ID_KEY = "web_cli_device_id";
const PUSH_CONSENT_KEY = "web_cli_push_consent";

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function hasPushConsent(): boolean {
  return localStorage.getItem(PUSH_CONSENT_KEY) === "true";
}

export function clearPushConsent(): void {
  localStorage.removeItem(PUSH_CONSENT_KEY);
}

export function validateFid(fid: string): boolean {
  if (typeof fid !== "string" || fid.length !== 22) return false;
  const first = fid[0].toLowerCase();
  if (first !== "c" && first !== "d" && first !== "e" && first !== "f") return false;
  return /^[a-zA-Z0-9_-]{22}$/.test(fid);
}

let firebaseApp: FirebaseApp | undefined;
let firebaseMessaging: Messaging | undefined;
let registrationGeneration = 0;
let unsubscribeOnMessage: (() => void) | undefined;
let unsubscribeOnRegistered: (() => void) | undefined;
let activeRegistration: AbortController | undefined;

type RegistrationToken = {
  generation: number;
  controller: AbortController;
};

function beginRegistration(): RegistrationToken {
  cleanupPushListeners();
  const controller = new AbortController();
  activeRegistration = controller;
  return { generation: registrationGeneration, controller };
}

async function cancellable<T>(promise: Promise<T>, token: RegistrationToken): Promise<T> {
  const signal = token.controller.signal;
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const value = await Promise.race([promise, cancelled]);
    if (!isCurrent(token)) throw new Error("Đăng ký bị hủy bỏ.");
    return value;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function isCurrent(token: RegistrationToken): boolean {
  return token.generation === registrationGeneration;
}

function assertCurrent(token: RegistrationToken): void {
  if (!isCurrent(token) || token.controller.signal.aborted) {
    throw token.controller.signal.reason ?? new Error("Đăng ký bị hủy bỏ.");
  }
}

export function cleanupPushListeners(): void {
  registrationGeneration += 1;
  activeRegistration?.abort();
  activeRegistration = undefined;
  if (unsubscribeOnMessage) {
    try {
      unsubscribeOnMessage();
    } catch {
      // ignore
    }
    unsubscribeOnMessage = undefined;
  }
  if (unsubscribeOnRegistered) {
    try {
      unsubscribeOnRegistered();
    } catch {
      // ignore
    }
    unsubscribeOnRegistered = undefined;
  }
}

export async function isPushEnvironmentSupported(): Promise<boolean> {
  if (
    typeof window === "undefined" ||
    !window.isSecureContext ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return false;
  }

  try {
    return await isFirebaseMessagingSupported();
  } catch {
    return false;
  }
}

export function getFirebaseMessaging(config: NotificationConfig): Messaging | undefined {
  if (!config.enabled) return undefined;
  if (firebaseMessaging) return firebaseMessaging;

  const apps = getApps();
  firebaseApp = apps.length > 0 ? apps[0] : initializeApp(config.firebaseConfig, "web-cli-frontend");
  firebaseMessaging = getMessaging(firebaseApp);
  return firebaseMessaging;
}

export async function registerPushNotification(
  config: NotificationConfig,
  onForegroundAttention?: (data: { eventId: string; sessionId: string }) => void
): Promise<{ state: PushState; error?: string }> {
  return registerPushNotificationInternal(config, onForegroundAttention, true);
}

export async function refreshPushRegistration(
  config: NotificationConfig,
  onForegroundAttention?: (data: { eventId: string; sessionId: string }) => void
): Promise<{ state: PushState; error?: string }> {
  return registerPushNotificationInternal(config, onForegroundAttention, false);
}

async function registerPushNotificationInternal(
  config: NotificationConfig,
  onForegroundAttention: ((data: { eventId: string; sessionId: string }) => void) | undefined,
  requestPermission: boolean
): Promise<{ state: PushState; error?: string }> {
  const token = beginRegistration();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let fidCleanup: (() => void) | undefined;
  let succeeded = false;

  try {
    if (!config.enabled) return { state: "unconfigured" };
    // Bound support/worker/SDK waits as well as FID delivery. Permission prompts
    // remain user controlled; the deadline restarts after explicit permission.
    const startDeadline = () => {
      if (deadline !== undefined) clearTimeout(deadline);
      deadline = setTimeout(() => token.controller.abort(new Error("Quá thời gian đăng ký Firebase.")), 20_000);
    };
    startDeadline();
    const supported = await cancellable(isPushEnvironmentSupported(), token);
    assertCurrent(token);
    if (!supported) return { state: "unsupported" };
    if (Notification.permission === "denied") {
      return { state: "permission_denied" };
    }
    if (!requestPermission && (!hasPushConsent() || Notification.permission !== "granted")) {
      return { state: "unregistered" };
    }
    if (requestPermission) {
      clearTimeout(deadline);
      const permission = await cancellable(Notification.requestPermission(), token);
      assertCurrent(token);
      if (permission !== "granted") return { state: "permission_denied" };
      startDeadline();
    }

    const swReg = await cancellable(navigator.serviceWorker.register("/api/web-cli/firebase-messaging-sw.js", {
      scope: "/api/web-cli/"
    }), token);
    assertCurrent(token);
    await cancellable(navigator.serviceWorker.ready, token);
    assertCurrent(token);

    // Firebase's register() prompts when permission is "default". Recheck immediately
    // before entering the SDK so a silent refresh can never prompt after an async wait.
    const permission = Notification.permission as NotificationPermission;
    if (permission !== "granted") {
      return { state: permission === "denied" ? "permission_denied" : "unregistered" };
    }

    const messaging = getFirebaseMessaging(config);
    if (!messaging) {
      return { state: "register_error", error: "Không thể khởi tạo Firebase Messaging." };
    }

    const deviceId = getDeviceId();

    const fidPromise = new Promise<string>((resolve) => {
      const rawCleanup = onRegistered(messaging, fid => {
        if (isCurrent(token)) resolve(fid);
      });
      let active = true;
      fidCleanup = () => {
        if (!active) return;
        active = false;
        try { rawCleanup(); } catch { /* best effort */ }
      };
      unsubscribeOnRegistered = fidCleanup;
    });

    // Observe both promises immediately: SDK failure or cancellation must not
    // leave an independently rejecting FID promise behind.
    const [, fid] = await cancellable(Promise.all([
      register(messaging, { vapidKey: config.vapidPublicKey, serviceWorkerRegistration: swReg }),
      fidPromise
    ]), token);
    assertCurrent(token);

    if (!validateFid(fid)) {
      throw new Error("Mã đăng ký Firebase không hợp lệ.");
    }

    await cancellable(registerPushDevice("", { deviceId, fid }, token.controller.signal), token);
    assertCurrent(token);

    // The listener is installed only after Firebase and backend registration succeed.
    if (onForegroundAttention) {
      const rawCleanup = onMessage(messaging, (payload) => {
        const data = payload.data as Record<string, string> | undefined;
        if (data && data.type === "attention" && data.sessionId && isCurrent(token)) {
          onForegroundAttention({ eventId: data.eventId, sessionId: data.sessionId });
        }
      });
      let active = true;
      unsubscribeOnMessage = () => {
        if (!active) return;
        active = false;
        try { rawCleanup(); } catch { /* best effort */ }
      };
    }
    if (!isCurrent(token)) return { state: "unregistered" };
    localStorage.setItem(PUSH_CONSENT_KEY, "true");
    succeeded = true;
    return { state: "registered" };
  } catch (err) {
    if (!isCurrent(token)) return { state: "unregistered" };
    return {
      state: "register_error",
      error: err instanceof Error ? err.message : "Đăng ký thông báo thất bại."
    };
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    fidCleanup?.();
    if (unsubscribeOnRegistered === fidCleanup) unsubscribeOnRegistered = undefined;
    if (!succeeded && isCurrent(token)) cleanupPushListeners();
  }
}

export async function unregisterPushNotification(
  config: NotificationConfig
): Promise<{ state: PushState; error?: string }> {
  const token = beginRegistration();
  const deadline = setTimeout(() => token.controller.abort(new Error("Quá thời gian tắt thông báo.")), 20_000);

  try {
    await cancellable(unregisterPushDevice("", getDeviceId(), token.controller.signal), token);
    assertCurrent(token);

    const messaging = getFirebaseMessaging(config);
    if (messaging) {
      try {
        await cancellable(unregister(messaging), token);
      } catch {
        // Best effort SDK unregister
      }
    }

    if (!isCurrent(token)) return { state: "unregistered" };
    clearPushConsent();
    return { state: "unregistered" };
  } catch (err) {
    if (!isCurrent(token)) return { state: "unregistered" };
    return {
      state: "unregister_error",
      error: err instanceof Error ? err.message : "Không thể tắt thông báo."
    };
  } finally {
    clearTimeout(deadline);
  }
}

export async function testPushNotification(): Promise<{ queued: boolean; eventId: string }> {
  const deviceId = getDeviceId();
  return sendTestNotification("", deviceId);
}
