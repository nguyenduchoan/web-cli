import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = path.resolve(moduleDir, "../../web/dist");
const assetsDir = path.join(webDistDir, "assets");
const indexHtmlPath = path.join(webDistDir, "index.html");
const workerPath = path.join(webDistDir, "firebase-messaging-sw.js");
const manifestPath = path.join(webDistDir, "manifest.webmanifest");
const iconSvgPath = path.join(webDistDir, "icon.svg");
const icon192Path = path.join(webDistDir, "icon-192.png");
const icon512Path = path.join(webDistDir, "icon-512.png");

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
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

export function registerStaticWeb(fastify: FastifyInstance, config: AppConfig): void {
  const prefix = config.hub ? "/cli" : "";
  fastify.get(`${prefix}/`, async (_request, reply) => sendStaticFile(reply, indexHtmlPath));

  fastify.get(`${prefix}/firebase-messaging-sw.js`, async (_request, reply) => {
    try {
      const code = await fs.readFile(workerPath, "utf8");
      let injectedConfig = "self.__FIREBASE_CONFIG__ = null;\n";
      if (config.push.enabled) {
        const publicConfig = {
          apiKey: config.push.firebaseWebConfig.apiKey,
          projectId: config.push.firebaseWebConfig.projectId,
          messagingSenderId: config.push.firebaseWebConfig.messagingSenderId,
          appId: config.push.firebaseWebConfig.appId
        };
        injectedConfig = `self.__FIREBASE_CONFIG__ = ${JSON.stringify(publicConfig)};\n`;
      }
      return reply
        .header("Content-Type", "application/javascript; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Service-Worker-Allowed", "/api/web-cli/")
        .send(injectedConfig + code);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return reply.code(404).send({ error: "not_found" });
      }
      throw err;
    }
  });

  fastify.get(`${prefix}/manifest.webmanifest`, async (_request, reply) => {
    return sendStaticFile(reply, manifestPath);
  });

  fastify.get(`${prefix}/icon.svg`, async (_request, reply) => {
    return sendStaticFile(reply, iconSvgPath);
  });

  fastify.get(`${prefix}/icon-192.png`, async (_request, reply) => {
    return sendStaticFile(reply, icon192Path);
  });

  fastify.get(`${prefix}/icon-512.png`, async (_request, reply) => {
    return sendStaticFile(reply, icon512Path);
  });

  fastify.get(`${prefix}/assets/*`, async (request, reply) => {
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

    if (!config.hub && request.method === "GET" && wantsHtml(request)) {
      return sendStaticFile(reply, indexHtmlPath);
    }

    return reply.code(404).send({ error: "not_found" });
  });
}
