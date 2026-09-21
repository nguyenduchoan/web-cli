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
  fetchNotificationConfig,
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

export function cleanupPushListeners(): void {
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
  if (!config.enabled) {
    return { state: "unconfigured" };
  }

  const supported = await isPushEnvironmentSupported();
  if (!supported) {
    return { state: "unsupported" };
  }

  if (Notification.permission === "denied") {
    return { state: "permission_denied" };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { state: "permission_denied" };
  }

  const currentGen = ++registrationGeneration;

  try {
    const swReg = await navigator.serviceWorker.register("/api/web-cli/firebase-messaging-sw.js", {
      scope: "/api/web-cli/"
    });
    await navigator.serviceWorker.ready;

    const messaging = getFirebaseMessaging(config);
    if (!messaging) {
      return { state: "register_error", error: "Không thể khởi tạo Firebase Messaging." };
    }

    // Attach foreground listener with prior cleanup to avoid duplicate handlers
    if (unsubscribeOnMessage) {
      try {
        unsubscribeOnMessage();
      } catch {
        // ignore
      }
      unsubscribeOnMessage = undefined;
    }

    if (onForegroundAttention) {
      unsubscribeOnMessage = onMessage(messaging, (payload) => {
        const data = payload.data as Record<string, string> | undefined;
        if (data && data.type === "attention" && data.sessionId) {
          onForegroundAttention({
            eventId: data.eventId,
            sessionId: data.sessionId
          });
        }
      });
    }

    const deviceId = getDeviceId();

    // Register callback for FID with cleanup of prior listeners
    if (unsubscribeOnRegistered) {
      try {
        unsubscribeOnRegistered();
      } catch {
        // ignore
      }
      unsubscribeOnRegistered = undefined;
    }

    const fidPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Quá thời gian lấy mã đăng ký Firebase.")), 20_000);

      unsubscribeOnRegistered = onRegistered(messaging, (fid) => {
        clearTimeout(timeout);
        if (currentGen !== registrationGeneration) {
          reject(new Error("Đăng ký bị hủy bỏ."));
          return;
        }
        resolve(fid);
      });
    });

    await register(messaging, {
      vapidKey: config.vapidPublicKey,
      serviceWorkerRegistration: swReg
    });

    const fid = await fidPromise;
    if (currentGen !== registrationGeneration) {
      return { state: "unregistered" };
    }

    if (!validateFid(fid)) {
      throw new Error("Mã đăng ký Firebase không hợp lệ.");
    }

    await registerPushDevice("", { deviceId, fid });
    localStorage.setItem(PUSH_CONSENT_KEY, "true");

    return { state: "registered" };
  } catch (err) {
    return {
      state: "register_error",
      error: err instanceof Error ? err.message : "Đăng ký thông báo thất bại."
    };
  }
}

export async function unregisterPushNotification(
  config: NotificationConfig
): Promise<{ state: PushState; error?: string }> {
  registrationGeneration++; // Invalidate pending callbacks
  cleanupPushListeners();

  const deviceId = getDeviceId();

  try {
    await unregisterPushDevice("", deviceId);

    const messaging = getFirebaseMessaging(config);
    if (messaging) {
      try {
        await unregister(messaging);
      } catch {
        // Best effort SDK unregister
      }
    }

    clearPushConsent();
    return { state: "unregistered" };
  } catch (err) {
    return {
      state: "unregister_error",
      error: err instanceof Error ? err.message : "Không thể tắt thông báo."
    };
  }
}

export async function testPushNotification(): Promise<{ queued: boolean; eventId: string }> {
  const deviceId = getDeviceId();
  return sendTestNotification("", deviceId);
}
