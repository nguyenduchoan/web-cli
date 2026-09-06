import type { AgentConfig, BrowseResult, ProjectConfig, Session } from "./types";

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? `${window.location.origin}/api/web-cli`;

type ApiErrorBody = {
  error?: string;
  message?: string;
};

async function request<T>(path: string, _token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "same-origin",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event("web-cli-auth-expired"));
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as ApiErrorBody;
      message = body.message || body.error || message;
    } catch {
      // Keep generic message.
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export function health(token: string) {
  return request<{ ok: boolean }>("/api/health", token);
}

export type AuthStatus = { authenticated: boolean; setupRequired: boolean; trustedDevice?: boolean; username?: string };
export type Enrollment = { enrollmentId: string; secret: string; uri: string; qr: string };
export const authStatus = () => request<AuthStatus>("/api/auth/status", "");
export const login = (username: string, password: string, code: string) => request("/api/auth/login", "", { method: "POST", body: JSON.stringify({ username: username || undefined, password: password || undefined, code }) });
export const logout = () => request("/api/auth/logout", "", { method: "POST", body: "{}" });
export const beginSetup = (setupCode: string, username: string, password: string) => request<Enrollment>("/api/auth/setup", "", { method: "POST", body: JSON.stringify({ setupCode, username, password }) });
export const confirmSetup = (enrollmentId: string, code: string) => request<{ recoveryCodes: string[] }>("/api/auth/setup/confirm", "", { method: "POST", body: JSON.stringify({ enrollmentId, code }) });
export const listSessions = () => request<{ sessions: Session[] }>("/api/sessions", "");

export function listAgents(token: string) {
  return request<{ agents: AgentConfig[] }>("/api/agents", token);
}

export function listProjects(token: string) {
  return request<{ projects: ProjectConfig[] }>("/api/projects", token);
}

export function browseProject(token: string, projectId: string, subpath?: string) {
  const params = new URLSearchParams();
  if (subpath) params.set("subpath", subpath);
  const query = params.toString();
  return request<BrowseResult>(`/api/browse/${encodeURIComponent(projectId)}${query ? `?${query}` : ""}`, token);
}

export function createSession(token: string, input: { agentId: string; projectId: string; subpath?: string; cols?: number; rows?: number }) {
  return request<{ session: Session }>("/api/sessions", token, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function killSession(token: string, sessionId: string) {
  return request<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, token, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function restartSession(token: string, sessionId: string, input: { cols?: number; rows?: number } = {}) {
  return request<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/restart`, token, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function createWsTicket(token: string, sessionId: string) {
  return request<{ ticket: string; expiresAt: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/ws-ticket`, token, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function buildWsUrl(sessionId: string): string {
  const url = new URL(API_BASE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sessionId)}/ws`;
  url.search = "";
  return url.toString();
}
