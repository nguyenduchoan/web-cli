import fs from "node:fs/promises";
import nodePath from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { registerAuth } from "./webAuth.js";
import { loadConfig } from "./config.js";
import { formatValidationError, sendError } from "./httpErrors.js";
import { SessionManager } from "./sessionManager.js";
import { registerStaticWeb } from "./staticAssets.js";
import { WebSocketBridge } from "./websocket.js";

function sanitizeSubpath(subpath: string): string | null {
  if (subpath.includes("\0")) return null;
  const normalized = nodePath.normalize(subpath).replace(/^\/+/, "");
  if (nodePath.isAbsolute(normalized)) return null;
  if (normalized === "..") return null;
  if (normalized.startsWith("../") || normalized.includes("/../")) return null;
  if (normalized === ".") return "";
  return normalized;
}

function isSubpathOf(candidate: string, root: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return !relative.startsWith("..") && !nodePath.isAbsolute(relative);
}

const browseQuerySchema = z.object({
  subpath: z.string().max(500).default("")
});

const createSessionSchema = z.object({
  agentId: z.string().min(1),
  projectId: z.string().min(1),
  subpath: z.string().max(500).optional(),
  cols: z.number().int().min(20).max(300).optional(),
  rows: z.number().int().min(5).max(120).optional()
});

const restartSessionSchema = z.object({
  cols: z.number().int().min(20).max(300).optional(),
  rows: z.number().int().min(5).max(120).optional()
});

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown configuration error";
  console.error(`Invalid Web CLI configuration: ${message}`);
  process.exit(1);
}
// Prevent controller configuration from being inherited by PTY children.
for (const sensitiveName of ["AUTH_TOKEN", "AGENTS_CONFIG_JSON", "ALLOWED_PROJECT_DIRS", "CLIENT_ORIGIN", "WEB_CLI_ENV_FILE"]) {
  delete process.env[sensitiveName];
}
const fastify = Fastify({
  trustProxy: ["127.0.0.1", "::1"],
  bodyLimit: 16 * 1024,
  rewriteUrl: (request) => (request.url ?? "/").replace(/^\/(?:api\/)?web-cli(?=\/|\?|$)/, "") || "/",
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: ["req.headers.authorization", "headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
    serializers: { req: (request) => ({ method: request.method, url: String(request.url).split("?")[0], remoteAddress: request.ip }) }
  }
});

await fastify.register(cors, {
  origin: config.clientOrigins,
  credentials: true
});

fastify.addHook("onSend", async (_request, reply, payload) => {
  reply.headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  });
  return payload;
});

const auth = registerAuth(fastify, config);

const sessions = new SessionManager(config, fastify.log);
const wsBridge = new WebSocketBridge(fastify.server, config, sessions, auth);
wsBridge.start();

fastify.get("/api/health", async () => ({
  ok: true,
  service: "agent-cli-web-controller",
  time: new Date().toISOString()
}));

fastify.get("/api/agents", async () => ({
  agents: config.agents.map((agent) => ({
    id: agent.id,
    label: agent.label,
    quickActions: agent.quickActions
  }))
}));

fastify.get("/api/sessions", async () => ({ sessions: sessions.listSessions() }));

fastify.get("/api/projects", async () => ({
  projects: config.projects.map((project) => ({
    id: project.id,
    label: project.label
  }))
}));

fastify.get("/api/browse/:projectId", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const parsed = browseQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return sendError(reply, 400, formatValidationError(parsed.error), "validation_error");
  }

  const project = config.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    return sendError(reply, 404, "Unknown project", "unknown_project");
  }

  const sanitized = sanitizeSubpath(parsed.data.subpath);
  if (sanitized === null) {
    return sendError(reply, 400, "Invalid subpath", "invalid_subpath");
  }

  const targetPath = sanitized ? nodePath.resolve(project.path, sanitized) : project.path;
  let realTarget: string;
  try {
    realTarget = await fs.realpath(targetPath);
  } catch {
    return sendError(reply, 404, "Path not found", "path_not_found");
  }

  if (!isSubpathOf(realTarget, project.path)) {
    return sendError(reply, 403, "Path outside project root", "path_traversal");
  }

  const stat = await fs.stat(realTarget);
  if (!stat.isDirectory()) {
    return sendError(reply, 400, "Not a directory", "not_directory");
  }

  const entries = await fs.readdir(realTarget, { withFileTypes: true });
  const directories = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      name: e.name,
      subpath: sanitized ? `${sanitized}/${e.name}` : e.name
    }));

  return {
    projectId: project.id,
    rootLabel: project.label,
    currentSubpath: sanitized,
    directories
  };
});

fastify.post("/api/sessions", async (request, reply) => {
  const parsed = createSessionSchema.safeParse(request.body);
  if (!parsed.success) {
    return sendError(reply, 400, formatValidationError(parsed.error), "validation_error");
  }

  const agent = config.agents.find((candidate) => candidate.id === parsed.data.agentId);
  if (!agent) {
    return sendError(reply, 404, "Unknown agent", "unknown_agent");
  }

  const project = config.projects.find((candidate) => candidate.id === parsed.data.projectId);
  if (!project) {
    return sendError(reply, 404, "Unknown project", "unknown_project");
  }

  let effectiveProject = project;
  if (parsed.data.subpath) {
    const sanitized = sanitizeSubpath(parsed.data.subpath);
    if (sanitized === null) {
      return sendError(reply, 400, "Invalid subpath", "invalid_subpath");
    }
    if (sanitized) {
      const resolved = nodePath.resolve(project.path, sanitized);
      let realResolved: string;
      try {
        realResolved = await fs.realpath(resolved);
      } catch {
        return sendError(reply, 404, "Project subpath not found", "path_not_found");
      }
      if (!isSubpathOf(realResolved, project.path)) {
        return sendError(reply, 403, "Path outside project root", "path_traversal");
      }
      effectiveProject = { ...project, path: realResolved, label: `${project.label}/${sanitized}` };
    }
  }

  const session = sessions.createSession({
    agent,
    project: effectiveProject,
    cols: parsed.data.cols,
    rows: parsed.data.rows
  });

  return reply.code(201).send({ session });
});

fastify.get("/api/sessions/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const session = sessions.getSession(id);
  if (!session) {
    return sendError(reply, 404, "Unknown session", "unknown_session");
  }

  return { session };
});

fastify.post("/api/sessions/:id/kill", async (request, reply) => {
  const { id } = request.params as { id: string };
  const session = sessions.killSession(id);
  if (!session) {
    return sendError(reply, 404, "Unknown session", "unknown_session");
  }

  return { session };
});

fastify.post("/api/sessions/:id/restart", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = restartSessionSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return sendError(reply, 400, formatValidationError(parsed.error), "validation_error");
  }

  const session = await sessions.restartSession(id, parsed.data.cols, parsed.data.rows);
  if (!session) {
    return sendError(reply, 404, "Unknown session", "unknown_session");
  }

  return { session };
});

fastify.post("/api/sessions/:id/ws-ticket", async (request, reply) => {
  const { id } = request.params as { id: string };
  const session = sessions.getSession(id);
  if (!session) {
    return sendError(reply, 404, "Unknown session", "unknown_session");
  }

  return wsBridge.issueTicket(id, auth.sessionKey(request.raw)!);
});

registerStaticWeb(fastify);

fastify.setErrorHandler((error, _request, reply) => {
  fastify.log.error(error);
  const typedError = error as Error & { statusCode?: number; code?: string };
  const statusCode = typedError.statusCode && typedError.statusCode >= 400 && typedError.statusCode < 500
    ? typedError.statusCode
    : 500;
  return sendError(
    reply,
    statusCode,
    statusCode === 500 ? "Internal server error" : typedError.message,
    statusCode === 500 ? "internal_error" : typedError.code ?? "request_rejected"
  );
});

try {
  await fastify.listen({ host: config.host, port: config.port });
  fastify.log.info(
    {
      host: config.host,
      port: config.port,
      agents: config.agents.length,
      projects: config.projects.length
    },
    "Agent CLI Web Controller server started"
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    fastify.log.info({ signal }, "Agent CLI Web Controller shutting down");
    const forceTimer = setTimeout(() => {
      fastify.log.error("Graceful shutdown timed out");
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceTimer.unref();
    try {
      await wsBridge.close();
      await sessions.close();
      await fastify.close();
      clearTimeout(forceTimer);
      process.exit(0);
    } catch (error) {
      fastify.log.error(error);
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
