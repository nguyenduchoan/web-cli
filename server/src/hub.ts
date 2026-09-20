import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { HubAuth } from "./hubAuth.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../hub/public");
const files = new Map<string, string>([
  ["/", "index.html"], ["/login", "index.html"],
  ["/hub-assets/app.css", "app.css"], ["/hub-assets/app.js", "app.js"], ["/favicon.svg", "favicon.svg"],
  ["/vietqr/", "vietqr/index.html"], ["/vietqr/index.html", "vietqr/index.html"],
  ...["styles.css", "app.js", "payload.js", "vendor/qrcode-1.5.4.min.js", "vendor/qrcode-LICENSE.txt"].map((name): [string, string] => [`/vietqr/${name}`, `vietqr/${name}`])
]);
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8" };

export async function registerHub(app: FastifyInstance, config: AppConfig): Promise<HubAuth | undefined> {
  if (!config.hub) return;
  const auth = await HubAuth.create(config.hub);
  auth.register(app);
  // Explicit files only: account/config/source paths can never become static files.
  for (const [url, filename] of files) {
    const body = await fs.readFile(path.join(root, filename));
    app.get(url, async (_request, reply) => reply.type(types[path.extname(filename)]).send(body));
  }
  app.get("/vietqr", async (_request, reply) => reply.redirect("/vietqr/", 308));
  app.get("/hub-api/services", async () => ({
    services: [
      { id: "vietqr", title: "VietQR Studio", url: "/vietqr/", status: "ready" },
      { id: "web-cli", title: "Web CLI", url: "/api/web-cli/", status: "ready" }
    ],
    agentCount: config.agents.length, projectCount: config.projects.length
  }));
  app.get("/hub-api/web-cli-setup", async (_request, reply) => {
    if (!config.authDataDir) return reply.code(404).send({ message: "Chưa cấu hình Web CLI." });
    try {
      // Only the already authenticated hub owner can obtain the first-enrollment code.
      const setupCode = (await fs.readFile(path.join(config.authDataDir, "setup-code.txt"), "utf8")).trim();
      return { setupCode };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ message: "Web CLI đã được thiết lập." });
      throw error;
    }
  });
  return auth;
}
