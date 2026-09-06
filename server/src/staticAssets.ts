import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = path.resolve(moduleDir, "../../web/dist");
const assetsDir = path.join(webDistDir, "assets");
const indexHtmlPath = path.join(webDistDir, "index.html");

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp"
};

function isInsideDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function sendStaticFile(reply: FastifyReply, filePath: string): Promise<FastifyReply> {
  try {
    const body = await fs.readFile(filePath);
    const type = contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    return reply.header("Cache-Control", cacheControlFor(filePath)).type(type).send(body);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return reply.code(404).send({ error: "not_found" });
    }
    throw error;
  }
}

function cacheControlFor(filePath: string): string {
  if (isInsideDirectory(filePath, assetsDir)) {
    return "public, max-age=31536000, immutable";
  }

  return "no-store";
}

function wantsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

export function registerStaticWeb(fastify: FastifyInstance): void {
  fastify.get("/", async (_request, reply) => sendStaticFile(reply, indexHtmlPath));

  fastify.get("/assets/*", async (request, reply) => {
    const params = request.params as Record<string, string | undefined>;
    const rawAssetPath = params["*"] ?? "";
    const assetPath = path.resolve(assetsDir, rawAssetPath);

    if (!isInsideDirectory(assetPath, assetsDir)) {
      return reply.code(404).send({ error: "not_found" });
    }

    return sendStaticFile(reply, assetPath);
  });

  fastify.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found" });
    }

    if (request.method === "GET" && wantsHtml(request)) {
      return sendStaticFile(reply, indexHtmlPath);
    }

    return reply.code(404).send({ error: "not_found" });
  });
}
