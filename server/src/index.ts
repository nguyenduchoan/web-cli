import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerAuth } from "./webAuth.js";
import { loadConfig } from "./config.js";
import { sendError } from "./httpErrors.js";
import { SessionManager } from "./sessionManager.js";
import { registerStaticWeb } from "./staticAssets.js";
import { WebSocketBridge } from "./websocket.js";
import { registerHub } from "./hub.js";
import { registerSessionRoutes } from "./sessionRoutes.js";
import { IdempotencyStore } from "./idempotency.js";
import { initializeFirebaseApp, FirebasePushSender } from "./push.js";
import { PushStore } from "./pushStore.js";
import { PushDispatcher } from "./pushDispatcher.js";
import { registerPushRoutes } from "./pushRoutes.js";

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
  rewriteUrl: (request) => {
    const url = request.url ?? "/";
    if (!/^\/(?:api\/)?web-cli(?=\/|\?|$)/.test(url)) return url;
    const cliUrl = url.replace(/^\/(?:api\/)?web-cli(?=\/|\?|$)/, "") || "/";
    return config.hub && !cliUrl.startsWith("/api/") ? `/cli${cliUrl.startsWith("/") ? "" : "/"}${cliUrl}` : cliUrl;
  },
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
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss: https://firebaseinstallations.googleapis.com https://fcmregistrations.googleapis.com; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  });
  return payload;
});

const hub = await registerHub(fastify, config);
const auth = registerAuth(fastify, config, hub);

const sessions = new SessionManager(config, fastify.log);
const wsBridge = new WebSocketBridge(fastify.server, config, sessions, auth, fastify.log);
wsBridge.start();
const idempotencyStore = new IdempotencyStore();

let pushStore: PushStore | undefined;
let pushDispatcher: PushDispatcher | undefined;

if (config.push.enabled) {
  pushStore = new PushStore(config.push.fcmDataDir, config.push.firebaseWebConfig.projectId);
  const firebaseApp = initializeFirebaseApp(config.push);
  if (firebaseApp) {
    const pushSender = new FirebasePushSender(firebaseApp);
    pushDispatcher = new PushDispatcher({
      store: pushStore,
      sender: pushSender,
      sessions
    });

    sessions.onAttention((sessionId, attention) => {
      pushDispatcher?.dispatchAttention({
        type: "attention",
        eventId: attention.eventId,
        sessionId,
        createdAt: attention.createdAt
      });
    });

    auth.setOnLogout(async (scope) => {
      await pushStore?.revokeWebScope(scope);
    });

    hub?.setOnLogout(async (scope) => {
      await pushStore?.revokeHubScope(scope);
    });

    hub?.setOnPasswordChange(async () => {
      await pushStore?.revokeAll();
    });
  }
}

fastify.get("/api/health", async () => ({
  ok: true,
  service: "agent-cli-web-controller",
  time: new Date().toISOString()
}));

registerSessionRoutes(fastify, { config, sessions, wsBridge, auth, idempotencyStore });
registerPushRoutes(fastify, { config, auth, hub, pushStore, pushDispatcher });

registerStaticWeb(fastify, config);

fastify.setErrorHandler((error, _request, reply) => {
  fastify.log.error(error);
  const typedError = error as Error & { statusCode?: number; code?: string };
  const isBusiness5xx = typedError.statusCode === 503 || typedError.statusCode === 504;
  const isClient4xx = Boolean(typedError.statusCode && typedError.statusCode >= 400 && typedError.statusCode < 500);
  const statusCode = isClient4xx || isBusiness5xx ? typedError.statusCode! : 500;
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
      await Promise.allSettled([
        wsBridge.close(),
        sessions.close(),
        pushDispatcher ? pushDispatcher.shutdown(2000) : Promise.resolve()
      ]);
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
