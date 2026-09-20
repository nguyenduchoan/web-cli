/// <reference lib="webworker" />

import { initializeApp } from "firebase/app";
import { getMessaging, onBackgroundMessage } from "firebase/messaging/sw";

declare const self: ServiceWorkerGlobalScope & {
  __FIREBASE_CONFIG__?: {
    apiKey: string;
    projectId: string;
    messagingSenderId: string;
    appId: string;
  } | null;
};

function isValidUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function isValidTimestamp(isoString: string): boolean {
  const time = Date.parse(isoString);
  if (Number.isNaN(time)) return false;
  const now = Date.now();
  // createdAt không cũ quá 300 giây, không vượt tương lai 60 giây
  if (now - time > 300_000) return false;
  if (time - now > 60_000) return false;
  return true;
}

const seenEventIds: string[] = [];
function markSeen(id: string): boolean {
  if (seenEventIds.includes(id)) return false;
  seenEventIds.push(id);
  if (seenEventIds.length > 100) seenEventIds.shift();
  return true;
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Custom notificationclick listener registered before Firebase handler
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = (event.notification.data ?? {}) as {
    type?: string;
    eventId?: string;
    sessionId?: string;
  };

  const isAttention = data.type === "attention" && data.sessionId && isValidUuid(data.sessionId);
  const targetHash = isAttention ? `#session=${data.sessionId}` : "";
  const targetUrl = new URL(`/api/web-cli/${targetHash}`, self.location.origin).href;

  const clickPromise = (async () => {
    const clientsList = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    const cliClient = clientsList.find((client) => {
      try {
        const clientUrl = new URL(client.url);
        return clientUrl.origin === self.location.origin && clientUrl.pathname.startsWith("/api/web-cli");
      } catch {
        return false;
      }
    });

    if (cliClient) {
      await cliClient.focus();
      if (isAttention && data.sessionId) {
        cliClient.postMessage({
          type: "web-cli-open-session",
          sessionId: data.sessionId
        });
      }
    } else {
      await self.clients.openWindow(targetUrl);
    }
  })();

  event.waitUntil(clickPromise);
});

// Initialize Firebase only when config is injected and enabled
const firebaseConfig = self.__FIREBASE_CONFIG__;
if (firebaseConfig && firebaseConfig.apiKey) {
  const app = initializeApp(firebaseConfig);
  const messaging = getMessaging(app);

  onBackgroundMessage(messaging, async (payload) => {
    const data = payload.data as Record<string, string> | undefined;
    if (!data) return;

    const type = data.type;
    const eventId = data.eventId;
    const sessionId = data.sessionId;
    const createdAt = data.createdAt;

    if (!eventId || !isValidUuid(eventId) || !markSeen(eventId)) return;
    if (!createdAt || !isValidTimestamp(createdAt)) return;

    let title = "";
    let body = "";

    if (type === "attention") {
      if (!sessionId || !isValidUuid(sessionId)) return;
      title = "Codex cần bạn phản hồi";
      body = "Mở Web CLI để xem yêu cầu xác nhận hoặc câu hỏi.";
    } else if (type === "test") {
      if (sessionId !== "") return;
      title = "Thông báo thử Web CLI";
      body = "Thiết bị đã nhận thông báo thử.";
    } else {
      return;
    }

    const notificationOptions: NotificationOptions = {
      body,
      tag: eventId,
      icon: "/api/web-cli/icon-192.png",
      data: {
        type,
        eventId,
        sessionId
      }
    };

    await self.registration.showNotification(title, notificationOptions);
  });
}
