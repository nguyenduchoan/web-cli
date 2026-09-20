import fs from "node:fs";
import path from "node:path";

export type FirebaseWebConfig = {
  apiKey: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
};

export type PushConfig =
  | {
      enabled: false;
      supportedAgents: string[];
    }
  | {
      enabled: true;
      supportedAgents: string[];
      firebaseWebConfig: FirebaseWebConfig;
      vapidPublicKey: string;
      serviceAccountFile: string;
      serviceAccountJson: Record<string, unknown>;
      fcmDataDir: string;
    };

function validateVapidPublicKey(vapidKey: string): void {
  try {
    const raw = Buffer.from(vapidKey, "base64url");
    if (raw.length !== 65 || raw[0] !== 0x04) {
      throw new Error(
        "FIREBASE_VAPID_PUBLIC_KEY must be a valid base64url uncompressed P-256 public key (65 bytes starting with 0x04)"
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("FIREBASE_VAPID_PUBLIC_KEY")) {
      throw err;
    }
    throw new Error(
      "FIREBASE_VAPID_PUBLIC_KEY is not a valid base64url string"
    );
  }
}

export function loadPushConfig(authDataDir: string): PushConfig {
  const rawEnabled = process.env.FCM_ENABLED;
  const isEnabled = ["1", "true", "yes", "on"].includes((rawEnabled || "").toLowerCase());

  const supportedAgents = ["codex"];

  if (!isEnabled) {
    return {
      enabled: false,
      supportedAgents
    };
  }

  const requiredFields = [
    "FIREBASE_API_KEY",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_MESSAGING_SENDER_ID",
    "FIREBASE_APP_ID",
    "FIREBASE_VAPID_PUBLIC_KEY",
    "FIREBASE_SERVICE_ACCOUNT_FILE"
  ] as const;

  const missing = requiredFields.filter((key) => !process.env[key] || !process.env[key]!.trim());
  if (missing.length > 0) {
    throw new Error(`FCM is enabled but missing required environment variable(s): ${missing.join(", ")}`);
  }

  const apiKey = process.env.FIREBASE_API_KEY!.trim();
  const projectId = process.env.FIREBASE_PROJECT_ID!.trim();
  const messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID!.trim();
  const appId = process.env.FIREBASE_APP_ID!.trim();
  const vapidPublicKey = process.env.FIREBASE_VAPID_PUBLIC_KEY!.trim();
  const serviceAccountFile = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_FILE!.trim());

  validateVapidPublicKey(vapidPublicKey);

  if (!fs.existsSync(serviceAccountFile)) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_FILE does not exist: ${serviceAccountFile}`);
  }

  const fileStat = fs.statSync(serviceAccountFile);
  if (!fileStat.isFile()) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_FILE is not a file: ${serviceAccountFile}`);
  }

  let serviceAccountJson: Record<string, unknown>;
  try {
    const content = fs.readFileSync(serviceAccountFile, "utf8");
    serviceAccountJson = JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to parse FIREBASE_SERVICE_ACCOUNT_FILE as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (serviceAccountJson.project_id !== projectId) {
    throw new Error(
      `FIREBASE_SERVICE_ACCOUNT_FILE project_id (${String(serviceAccountJson.project_id)}) does not match FIREBASE_PROJECT_ID (${projectId})`
    );
  }

  const fcmDataDir = process.env.FCM_DATA_DIR?.trim()
    ? path.resolve(process.env.FCM_DATA_DIR.trim())
    : path.join(authDataDir, "push");

  return {
    enabled: true,
    supportedAgents,
    firebaseWebConfig: {
      apiKey,
      projectId,
      messagingSenderId,
      appId
    },
    vapidPublicKey,
    serviceAccountFile,
    serviceAccountJson,
    fcmDataDir
  };
}
