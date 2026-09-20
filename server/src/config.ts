import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";
import { loadPushConfig, type PushConfig } from "./pushConfig.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const appRootDir = path.resolve(moduleDir, "../..");

const configuredEnvFile = process.env.WEB_CLI_ENV_FILE
  ? path.resolve(process.env.WEB_CLI_ENV_FILE)
  : "/etc/server-hub/web-cli.env";
dotenv.config({ path: configuredEnvFile, quiet: true });
dotenv.config({ path: path.join(appRootDir, ".env"), quiet: true });

const quickActionsSchema = z.object({
  yesAll: z.string().default("a\r"),
  skip: z.string().default("s\r"),
  editFirst: z.string().default("e\r")
});

const agentConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  quickActions: quickActionsSchema.default({ yesAll: "a\r", skip: "s\r", editFirst: "e\r" })
});

const agentsConfigSchema = z.array(agentConfigSchema).min(1);

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export type ProjectConfig = {
  id: string;
  label: string;
  path: string;
};

export type AppConfig = {
  host: string;
  port: number;
  clientOrigins: string[];
  authToken: string;
  authDataDir?: string;
  hub?: { origin: string; authDataDir: string; username: string };
  agents: AgentConfig[];
  projects: ProjectConfig[];
  outputBufferLimit: number;
  websocketTicketTtlMs: number;
  logTerminalOutput: boolean;
  childEnvAllowlist: string[];
  maxSessions: number;
  sessionIdleTtlMs: number;
  sessionRetentionMs: number;
  maxRetainedSessions: number;
  shutdownTimeoutMs: number;
  maxWebsocketConnections: number;
  maxWebsocketBufferedBytes: number;
  push: PushConfig;
};

const defaultAgents: AgentConfig[] = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    args: [],
    quickActions: { yesAll: "a\r", skip: "s\r", editFirst: "e\r" }
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    args: [],
    quickActions: { yesAll: "a\r", skip: "s\r", editFirst: "e\r" }
  },
  {
    id: "codex",
    label: "Codex CLI",
    command: "codex",
    args: [],
    quickActions: { yesAll: "a\r", skip: "s\r", editFirst: "e\r" }
  },
  {
    id: "opencode",
    label: "OpenCode CLI",
    command: "opencode",
    args: [],
    quickActions: { yesAll: "a\r", skip: "s\r", editFirst: "e\r" }
  }
];

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function readStringList(name: string, fallback: string[] = []): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return [...new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

export function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "::1";
}

function loadAgents(): AgentConfig[] {
  const raw = process.env.AGENTS_CONFIG_JSON;
  const agents = raw ? agentsConfigSchema.parse(JSON.parse(raw)) : defaultAgents;
  const ids = new Set<string>();

  for (const agent of agents) {
    if (ids.has(agent.id)) {
      throw new Error(`Duplicate agent id: ${agent.id}`);
    }
    ids.add(agent.id);
  }

  return agents;
}

function projectIdFor(realPath: string): string {
  return crypto.createHash("sha256").update(realPath).digest("hex").slice(0, 16);
}

function loadProjects(): ProjectConfig[] {
  const raw = process.env.ALLOWED_PROJECT_DIRS ?? "";
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const projects: ProjectConfig[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const absolute = path.resolve(entry);
    const realPath = fs.realpathSync(absolute);
    const stat = fs.statSync(realPath);

    if (!stat.isDirectory()) {
      throw new Error(`Allowed project path is not a directory: ${entry}`);
    }

    if (seen.has(realPath)) {
      continue;
    }

    seen.add(realPath);
    projects.push({
      id: projectIdFor(realPath),
      label: path.basename(realPath) || realPath,
      path: realPath
    });
  }

  return projects;
}

export function loadConfig(): AppConfig {
  // Legacy tokens are no longer accepted for terminal access.
  const authToken = "";

  const childEnvAllowlist = readStringList("AGENT_ENV_ALLOWLIST", [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
    "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CLAUDE_PROXY_ENV_FILE",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"
  ]);
  for (const name of childEnvAllowlist) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name in AGENT_ENV_ALLOWLIST: ${name}`);
    }
  }

  const host = process.env.HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("HOST must be an explicit loopback address (127.0.0.1 or ::1)");
  }
  let hub: AppConfig["hub"];
  if (process.env.SERVER_HUB_ORIGIN) {
    const origin = new URL(process.env.SERVER_HUB_ORIGIN);
    if (origin.origin !== process.env.SERVER_HUB_ORIGIN || origin.username || origin.password ||
        (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
      throw new Error("SERVER_HUB_ORIGIN must be an HTTPS origin (HTTP loopback allowed for tests)");
    }
    const username = process.env.SERVER_HUB_USERNAME ?? "mrhoan";
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) throw new Error("Invalid SERVER_HUB_USERNAME");
    hub = { origin: origin.origin, username, authDataDir: path.resolve(process.env.SERVER_HUB_AUTH_DIR ?? "/var/lib/server-hub/hub-auth") };
  }

  const authDataDir = path.resolve(process.env.WEB_CLI_AUTH_DIR ?? path.join(appRootDir, "../secrets/web-cli-auth"));
  const push = loadPushConfig(authDataDir);

  return {
    host,
    port: readNumber("PORT", 3001),
    clientOrigins: readStringList("CLIENT_ORIGIN", []),
    authToken,
    hub,
    authDataDir,
    agents: [{ id: "shell", label: "Terminal", command: "/bin/bash", args: ["-l"], quickActions: { yesAll: "", skip: "", editFirst: "" } }, ...loadAgents().filter((agent) => agent.id !== "shell")],
    projects: loadProjects(),
    outputBufferLimit: readNumber("OUTPUT_BUFFER_LIMIT", 200_000),
    websocketTicketTtlMs: readNumber("WS_TICKET_TTL_MS", 60_000),
    logTerminalOutput: readBoolean("LOG_TERMINAL_OUTPUT", false),
    childEnvAllowlist,
    maxSessions: readNumber("MAX_SESSIONS", 3),
    sessionIdleTtlMs: readNumber("SESSION_IDLE_TTL_MS", 4 * 60 * 60 * 1000),
    sessionRetentionMs: readNumber("SESSION_RETENTION_MS", 60 * 60 * 1000),
    maxRetainedSessions: readNumber("MAX_RETAINED_SESSIONS", 50),
    shutdownTimeoutMs: readNumber("SHUTDOWN_TIMEOUT_MS", 15_000),
    maxWebsocketConnections: readNumber("MAX_WS_CONNECTIONS", 8),
    maxWebsocketBufferedBytes: readNumber("MAX_WS_BUFFERED_BYTES", 1_000_000),
    push
  };
}
