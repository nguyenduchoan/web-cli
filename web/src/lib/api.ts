import type { AgentConfig, BrowseResult, ProjectConfig, Session } from "./types";

export const API_BASE_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL) ||
  (typeof window !== "undefined" ? `${window.location.origin}/api/web-cli` : "/api/web-cli");

export class ApiError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;
  loginUrl?: string;

  constructor(message: string, status: number, code?: string, retryAfterMs?: number, loginUrl?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.loginUrl = loginUrl;
  }
}

export type ApiErrorBody = {
  error?: string;
  message?: string;
  code?: string;
  loginUrl?: string;
};

export function extractApiErrorInfo(
  status: number,
  body: unknown
): { message: string; code?: string; loginUrl?: string } {
  let message = `Request failed with status ${status}`;
  let code: string | undefined;
  let loginUrl: string | undefined;

  if (body && typeof body === "object") {
    const b = body as ApiErrorBody;
    code = b.code ?? b.error;
    loginUrl = b.loginUrl;
    message = b.message || b.error || message;
  }

  return { message, code, loginUrl };
}

async function request<T>(path: string, _token: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("Request timeout")), 15_000);

  if (init.signal) {
    if (init.signal.aborted) {
      clearTimeout(timeoutId);
      controller.abort(init.signal.reason);
    } else {
      init.signal.addEventListener("abort", () => {
        clearTimeout(timeoutId);
        controller.abort(init.signal?.reason);
      });
    }
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      window.dispatchEvent(new Event("web-cli-auth-expired"));
    }

    let retryAfterMs: number | undefined;
    const retryAfterHeader = response.headers.get("Retry-After");
    if (retryAfterHeader) {
      const seconds = parseInt(retryAfterHeader, 10);
      if (!Number.isNaN(seconds)) {
        retryAfterMs = seconds * 1000;
      } else {
        const parsedDate = Date.parse(retryAfterHeader);
        if (!Number.isNaN(parsedDate)) {
          retryAfterMs = Math.max(0, parsedDate - Date.now());
        }
      }
    }

    let message = `Request failed with status ${response.status}`;
    let code: string | undefined;
    let loginUrl: string | undefined;

    try {
      const body = (await response.json()) as ApiErrorBody;
      const extracted = extractApiErrorInfo(response.status, body);
      code = extracted.code;
      loginUrl = extracted.loginUrl;
      message = extracted.message;

      if (body.loginUrl === "/login") {
        const hash = window.location.hash;
        const target = hash && hash.startsWith("#session=") ? `/login${hash}` : "/login";
        window.location.replace(target);
      }
    } catch {
      // Keep generic message.
    }

    throw new ApiError(message, response.status, code, retryAfterMs, loginUrl);
  }

  return response.json() as Promise<T>;
}

export function health(token: string) {
  return request<{ ok: boolean }>("/api/health", token);
}

export type AuthStatus = { authenticated: boolean; setupRequired: boolean; trustedDevice?: boolean; username?: string; hubEnabled?: boolean };
export type Enrollment = { enrollmentId: string; secret: string; uri: string; qr: string };
export const authStatus = () => request<AuthStatus>("/api/auth/status", "");
export const login = (username: string, password: string, code: string) => request("/api/auth/login", "", { method: "POST", body: JSON.stringify({ username: username || undefined, password: password || undefined, code }) });
export const logout = () => request("/api/auth/logout", "", { method: "POST", body: "{}" });
export const beginSetup = (setupCode: string, username: string, password: string) => request<Enrollment>("/api/auth/setup", "", { method: "POST", body: JSON.stringify({ setupCode, username, password }) });
export const confirmSetup = (enrollmentId: string, code: string) => request<{ recoveryCodes: string[] }>("/api/auth/setup/confirm", "", { method: "POST", body: JSON.stringify({ enrollmentId, code }) });

export type ListSessionsResponse = {
  sessions: Session[];
  serverEpoch?: string;
  registryRevision?: number;
  capacity?: { active: number; reserved: number; max: number };
};

export const listSessions = (_token?: string, options?: { signal?: AbortSignal }) =>
  request<ListSessionsResponse>("/api/sessions", "", { signal: options?.signal });

export function listAgents(token: string, options?: { signal?: AbortSignal }) {
  return request<{ agents: AgentConfig[] }>("/api/agents", token, { signal: options?.signal });
}

export function listProjects(token: string, options?: { signal?: AbortSignal }) {
  return request<{ projects: ProjectConfig[] }>("/api/projects", token, { signal: options?.signal });
}

export function browseProject(token: string, projectId: string, subpath?: string, options?: { signal?: AbortSignal }) {
  const params = new URLSearchParams();
  if (subpath) params.set("subpath", subpath);
  const query = params.toString();
  return request<BrowseResult>(`/api/browse/${encodeURIComponent(projectId)}${query ? `?${query}` : ""}`, token, {
    signal: options?.signal
  });
}

export type MutationSessionResponse = {
  session: Session;
  serverEpoch?: string;
  registryRevision?: number;
  capacity?: { active: number; reserved: number; max: number };
};

export function createSession(
  token: string,
  input: { agentId: string; projectId: string; subpath?: string; cols?: number; rows?: number },
  options?: { idempotencyKey?: string; signal?: AbortSignal }
) {
  const headers: Record<string, string> = {};
  if (options?.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  return request<MutationSessionResponse>("/api/sessions", token, {
    method: "POST",
    headers,
    signal: options?.signal,
    body: JSON.stringify(input)
  });
}

export function killSession(token: string, sessionId: string, options?: { signal?: AbortSignal }) {
  return request<MutationSessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, token, {
    method: "POST",
    signal: options?.signal,
    body: JSON.stringify({})
  });
}

export function restartSession(
  token: string,
  sessionId: string,
  input: { cols?: number; rows?: number } = {},
  options?: { idempotencyKey?: string; signal?: AbortSignal }
) {
  const headers: Record<string, string> = {};
  if (options?.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  return request<MutationSessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/restart`, token, {
    method: "POST",
    headers,
    signal: options?.signal,
    body: JSON.stringify(input)
  });
}

export function createWsTicket(
  token: string,
  sessionId: string,
  input: { protocolVersion?: 1 | 2 } = { protocolVersion: 2 },
  options?: { signal?: AbortSignal }
) {
  return request<{ ticket: string; expiresAt: string; protocolVersion?: 1 | 2 }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/ws-ticket`,
    token,
    {
      method: "POST",
      signal: options?.signal,
      body: JSON.stringify({ protocolVersion: input.protocolVersion ?? 2 })
    }
  );
}

export function buildWsUrl(sessionId: string): string {
  const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const url = new URL(API_BASE_URL, base);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sessionId)}/ws`;
  url.search = "";
  return url.toString();
}

export type NotificationConfig =
  | {
      enabled: false;
      supportedAgents: string[];
    }
  | {
      enabled: true;
      supportedAgents: string[];
      firebaseConfig: {
        apiKey: string;
        projectId: string;
        messagingSenderId: string;
        appId: string;
      };
      vapidPublicKey: string;
    };

export function fetchNotificationConfig(token: string = "", signal?: AbortSignal): Promise<NotificationConfig> {
  return request<NotificationConfig>("/api/notifications/config", token, { signal });
}

export function registerPushDevice(
  token: string = "",
  input: { deviceId: string; fid: string },
  signal?: AbortSignal
): Promise<{ ok: boolean; expiresAt: string }> {
  return request<{ ok: boolean; expiresAt: string }>("/api/notifications/devices", token, {
    method: "POST",
    signal,
    body: JSON.stringify(input)
  });
}

export function unregisterPushDevice(
  token: string = "",
  deviceId: string,
  signal?: AbortSignal
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/notifications/devices/${encodeURIComponent(deviceId)}`, token, {
    method: "DELETE",
    signal
  });
}

export function sendTestNotification(
  token: string = "",
  deviceId: string,
  signal?: AbortSignal
): Promise<{ queued: boolean; eventId: string }> {
  return request<{ queued: boolean; eventId: string }>("/api/notifications/test", token, {
    method: "POST",
    signal,
    body: JSON.stringify({ deviceId })
  });
}
