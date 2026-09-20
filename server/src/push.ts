import { initializeApp, cert, type App } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";
import type { PushSender, PushMessage } from "./pushDispatcher.js";
import type { PushConfig } from "./pushConfig.js";

export class FirebasePushSender implements PushSender {
  private messaging: Messaging;

  constructor(app: App) {
    this.messaging = getMessaging(app);
  }

  async send(message: PushMessage): Promise<string> {
    return this.messaging.send({
      token: message.token,
      data: message.data,
      webpush: message.webpush
    });
  }
}

export function initializeFirebaseApp(config: PushConfig): App | undefined {
  if (!config.enabled) return undefined;

  return initializeApp(
    {
      credential: cert(config.serviceAccountJson),
      projectId: config.firebaseWebConfig.projectId
    },
    "web-cli-push"
  );
}
