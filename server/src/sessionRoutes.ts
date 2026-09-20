import crypto from "node:crypto";
import fs from "node:fs/promises";
import nodePath from "node:path";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import {
  AppHttpError,
  formatValidationError,
  sendError
} from "./httpErrors.js";
import { IdempotencyStore } from "./idempotency.js";
import type { SessionManager } from "./sessionManager.js";
import type { WebAuth } from "./webAuth.js";
import type { WebSocketBridge } from "./websocket.js";

const createSessionSchema = z.object({
  agentId: z.string().min(1),
  projectId: z.string().min(1),
  subpath: z.string().max(500).optional(),
  name: z.string().min(1).max(80).optional(),
  cols: z.number().int().min(20).max(300).optional(),
  rows: z.number().int().min(5).max(120).optional()
});

const restartSessionSchema = z.object({
  cols: z.number().int().min(20).max(300).optional(),
  rows: z.number().int().min(5).max(120).optional()
});

const wsTicketSchema = z.object({
  protocolVersion: z.union([z.literal(1), z.literal(2)]).optional()
});

const browseQuerySchema = z.object({
  subpath: z.string().optional()
});

function sanitizeSubpath(subpath: string | undefined): string | null {
  if (!subpath || subpath.trim() === "") return "";
  const normalized = nodePath.normalize(subpath).replace(/^[/\\]+/, "");
  if (normalized === ".." || normalized.startsWith(".." + nodePath.sep) || nodePath.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function isSubpathOf(target: string, root: string): boolean {
  const relative = nodePath.relative(root, target);
  return !relative.startsWith("..") && !nodePath.isAbsolute(relative);
}

export type SessionRoutesOptions = {
  config: AppConfig;
  sessions: SessionManager;
  wsBridge: WebSocketBridge;
  auth: WebAuth;
  idempotencyStore?: IdempotencyStore;
};

export function registerSessionRoutes(fastify: FastifyInstance, options: SessionRoutesOptions): void {
  const { config, sessions, wsBridge, auth } = options;
  const idempotencyStore = options.idempotencyStore ?? new IdempotencyStore();

  fastify.get("/api/agents", async () => ({
    agents: config.agents.map((agent) => ({
      id: agent.id,
      label: agent.label,
      quickActions: agent.quickActions
    }))
  }));

  fastify.get("/api/projects", async () => {
    const projectsWithWorkingDirectoryId = await Promise.all(
      config.projects.map(async (project) => {
        let realRoot: string;
        try {
          realRoot = await fs.realpath(project.path);
        } catch {
          realRoot = project.path;
        }
        const workingDirectoryId = crypto.createHash("sha256").update(realRoot).digest("hex").slice(0, 32);
        return {
          id: project.id,
          label: project.label,
          workingDirectoryId
        };
      })
    );
    return { projects: projectsWithWorkingDirectoryId };
  });

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

    const workingDirectoryId = crypto.createHash("sha256").update(realTarget).digest("hex").slice(0, 32);

    return {
      projectId: project.id,
      rootLabel: project.label,
      currentSubpath: sanitized,
      canonicalSubpath: sanitized,
      workingDirectoryId,
      directories
    };
  });

  fastify.get("/api/sessions", async () => {
    return {
      serverEpoch: sessions.getServerEpoch(),
      registryRevision: sessions.getRegistryRevision(),
      sessions: sessions.listSessions(),
      capacity: sessions.getCapacity()
    };
  });

  fastify.get("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessions.getSession(id);
    if (!session) {
      return sendError(reply, 404, "Unknown session", "unknown_session");
    }

    return {
      serverEpoch: sessions.getServerEpoch(),
      registryRevision: sessions.getRegistryRevision(),
      session
    };
  });

  fastify.post("/api/sessions", async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, formatValidationError(parsed.error), "validation_error");
    }

    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;

    const action = async (): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
      const agent = config.agents.find((candidate) => candidate.id === parsed.data.agentId);
      if (!agent) {
        return { statusCode: 404, body: { error: "unknown_agent", message: "Unknown agent" } };
      }

      const project = config.projects.find((candidate) => candidate.id === parsed.data.projectId);
      if (!project) {
        return { statusCode: 404, body: { error: "unknown_project", message: "Unknown project" } };
      }

      try {
        const session = sessions.createSession({
          agent,
          project,
          subpath: parsed.data.subpath,
          name: parsed.data.name,
          cols: parsed.data.cols,
          rows: parsed.data.rows
        });

        return {
          statusCode: 201,
          body: {
            serverEpoch: sessions.getServerEpoch(),
            registryRevision: sessions.getRegistryRevision(),
            capacity: sessions.getCapacity(),
            session
          }
        };
      } catch (err) {
        if (err instanceof AppHttpError) {
          return { statusCode: err.statusCode, body: { error: err.code, message: err.message } };
        }
        throw err;
      }
    };

    try {
      const result = await idempotencyStore.execute<Record<string, unknown>>(
        "POST",
        "/api/sessions",
        idempotencyKey,
        parsed.data,
        action
      );
      return reply.code(result.statusCode).send(result.body);
    } catch (err) {
      if (err instanceof AppHttpError) {
        return sendError(reply, err.statusCode, err.message, err.code);
      }
      throw err;
    }
  });

  fastify.post("/api/sessions/:id/kill", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const session = sessions.killSession(id);
      if (!session) {
        return sendError(reply, 404, "Unknown session", "unknown_session");
      }

      return reply.code(200).send({
        serverEpoch: sessions.getServerEpoch(),
        registryRevision: sessions.getRegistryRevision(),
        capacity: sessions.getCapacity(),
        session
      });
    } catch (err) {
      if (err instanceof AppHttpError) {
        return sendError(reply, err.statusCode, err.message, err.code);
      }
      throw err;
    }
  });

  fastify.post("/api/sessions/:id/restart", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = restartSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, formatValidationError(parsed.error), "validation_error");
    }

    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    const concreteRoute = `/api/sessions/${id}/restart`;

    const action = async (): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
      try {
        const restartResult = await sessions.restartSession(id, {
          cols: parsed.data.cols,
          rows: parsed.data.rows
        });

        if (!restartResult) {
          return { statusCode: 404, body: { error: "unknown_session", message: "Unknown session" } };
        }

        return {
          statusCode: 200,
          body: {
            serverEpoch: sessions.getServerEpoch(),
            registryRevision: sessions.getRegistryRevision(),
            capacity: sessions.getCapacity(),
            session: restartResult.session,
            replacedSessionId: restartResult.replacedSessionId
          }
        };
      } catch (err) {
        if (err instanceof AppHttpError) {
          return { statusCode: err.statusCode, body: { error: err.code, message: err.message } };
        }
        throw err;
      }
    };

    try {
      const result = await idempotencyStore.execute<Record<string, unknown>>(
        "POST",
        concreteRoute,
        idempotencyKey,
        parsed.data,
        action
      );
      return reply.code(result.statusCode).send(result.body);
    } catch (err) {
      if (err instanceof AppHttpError) {
        return sendError(reply, err.statusCode, err.message, err.code);
      }
      throw err;
    }
  });

  fastify.post("/api/sessions/:id/ws-ticket", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = wsTicketSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, formatValidationError(parsed.error), "validation_error");
    }

    const session = sessions.getSession(id);
    if (!session) {
      return sendError(reply, 404, "Unknown session", "unknown_session");
    }

    const authKey = auth.sessionKey(request.raw);
    if (!authKey) {
      return sendError(reply, 401, "Unauthorized", "unauthorized");
    }

    const protocolVersion = parsed.data.protocolVersion ?? 1;
    return wsBridge.issueTicket(id, authKey, protocolVersion);
  });
}
