import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";
import type { AppConfig } from "./config.js";

type Options = NonNullable<AppConfig["hub"]>;
type Account = { username: string; salt: string; passwordHash: string; mustChangePassword: boolean };
type Session = { expiresAt: number; lastSeen: number };
const TTL = 12 * 60 * 60_000;
const IDLE = 30 * 60_000;
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const equal = (left: string, right: string) => crypto.timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
const schema = z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(256) });
const derive = (password: string, salt: string) => new Promise<string>((resolve, reject) => {
  crypto.scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result.toString("hex")));
});

export class HubAuth {
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private working = false;
  private onLogoutHook?: (scope: string) => Promise<void> | void;
  private onPasswordChangeHook?: () => Promise<void> | void;

  setOnLogout(hook: (scope: string) => Promise<void> | void): void {
    this.onLogoutHook = hook;
  }

  setOnPasswordChange(hook: () => Promise<void> | void): void {
    this.onPasswordChangeHook = hook;
  }

  private constructor(private readonly options: Options, private account: Account) {}

  static async create(options: Options): Promise<HubAuth> {
    fs.mkdirSync(options.authDataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(options.authDataDir, 0o700);
    const accountPath = path.join(options.authDataDir, "account.json");
    let account: Account;
    if (fs.existsSync(accountPath)) {
      account = z.object({ username: z.string().regex(/^[a-zA-Z0-9_.-]{3,40}$/), salt: z.string().regex(/^[a-f0-9]{32}$/), passwordHash: z.string().regex(/^[a-f0-9]{128}$/), mustChangePassword: z.boolean() }).parse(JSON.parse(fs.readFileSync(accountPath, "utf8")));
      fs.chmodSync(accountPath, 0o600);
    } else {
      const password = crypto.randomBytes(24).toString("base64url");
      const salt = crypto.randomBytes(16).toString("hex");
      account = { username: options.username, salt, passwordHash: await derive(password, salt), mustChangePassword: true };
      // Save the handoff before the account. A crash can never create an inaccessible account.
      fs.writeFileSync(path.join(options.authDataDir, "initial-login.txt"), `URL: ${options.origin}\nUsername: ${account.username}\nPassword: ${password}\nĐổi mật khẩu sau lần đăng nhập đầu tiên.\n`, { mode: 0o600 });
      fs.writeFileSync(accountPath, JSON.stringify(account), { flag: "wx", mode: 0o600 });
    }
    return new HubAuth(options, account);
  }

  private get cookieName(): string { return this.options.origin.startsWith("https:") ? "__Host-server_hub" : "server_hub"; }
  sessionKey(request: Pick<IncomingMessage, "headers">): string | undefined {
    const prefix = this.cookieName + "=";
    const cookies = (request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(prefix));
    const token = cookies.length === 1 ? cookies[0].slice(prefix.length) : "";
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token) : undefined;
  }
  getAuthScope(request: Pick<IncomingMessage, "headers">): string | null {
    const key = this.sessionKey(request);
    if (!key || !this.valid(key)) return null;
    return digest(`hub:${key}`);
  }
  valid(key: string | undefined, touch = false): boolean {
    const session = key ? this.sessions.get(key) : undefined;
    const now = Date.now();
    if (!session || session.expiresAt <= now || session.lastSeen + IDLE <= now) {
      if (key) this.sessions.delete(key);
      return false;
    }
    if (touch) session.lastSeen = now;
    return true;
  }
  private setCookie(reply: FastifyReply, token: string): void {
    reply.header("Set-Cookie", `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? TTL / 1000 : 0}${this.options.origin.startsWith("https:") ? "; Secure" : ""}`);
  }
  private openSession(request: FastifyRequest, reply: FastifyReply): void {
    const previous = this.sessionKey(request.raw);
    if (previous) this.sessions.delete(previous);
    for (const key of this.sessions.keys()) this.valid(key);
    while (this.sessions.size >= 16) this.sessions.delete(this.sessions.keys().next().value!);
    const token = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(digest(token), { expiresAt: Date.now() + TTL, lastSeen: Date.now() });
    this.setCookie(reply, token);
  }
  private rateAllowed(ip: string): number {
    const now = Date.now();
    for (const [key, attempt] of this.attempts) if (attempt.until <= now) this.attempts.delete(key);
    if (this.attempts.size >= 1000 && !this.attempts.has(`ip:${ip}`)) return 300;
    for (const [key, limit] of [[`ip:${ip}`, 10], ["global", 60]] as const) {
      const entry = this.attempts.get(key) ?? { count: 0, until: now + 300_000 };
      this.attempts.set(key, entry);
      if (++entry.count > limit) return Math.ceil((entry.until - now) / 1000);
    }
    return 0;
  }

  register(app: FastifyInstance): void {
    app.addHook("onRequest", async (request, reply) => {
      const pathname = request.url.split("?", 1)[0];
      reply.header("Cache-Control", "no-store");
      if (pathname === "/api/health") return;
      if (`${request.protocol}://${request.headers.host}` !== this.options.origin) {
        return reply.code(403).send({ message: "Vui lòng mở đúng địa chỉ HTTPS của Server Hub." });
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin !== this.options.origin) {
        return reply.code(403).send({ message: "Nguồn yêu cầu không hợp lệ." });
      }
      const isPublic =
        ["/login", "/hub-api/status", "/hub-api/login"].includes(pathname) ||
        ["/hub-assets/app.css", "/hub-assets/app.js", "/favicon.svg"].includes(pathname) ||
        [
          "/cli/firebase-messaging-sw.js",
          "/cli/manifest.webmanifest",
          "/cli/icon.svg",
          "/cli/icon-192.png",
          "/cli/icon-512.png"
        ].includes(pathname);
      if (isPublic) return;
      if (!this.valid(this.sessionKey(request.raw), true)) {
        if (request.method === "GET" && !pathname.startsWith("/api/") && !pathname.startsWith("/hub-api/")) return reply.redirect("/login", 303);
        return reply.code(401).send({ message: "Vui lòng đăng nhập Server Hub.", loginUrl: "/login" });
      }
    });
    app.get("/hub-api/status", async (request) => {
      const authenticated = this.valid(this.sessionKey(request.raw));
      return { authenticated, username: authenticated ? this.account.username : undefined, mustChangePassword: authenticated ? this.account.mustChangePassword : undefined };
    });
    app.post("/hub-api/login", async (request, reply) => {
      const wait = this.rateAllowed(request.ip);
      if (wait) return reply.header("Retry-After", wait).code(429).send({ message: "Thử quá nhiều lần. Vui lòng đợi vài phút." });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: "Vui lòng nhập tài khoản và mật khẩu." });
      if (this.working) return reply.code(429).send({ message: "Đang xử lý đăng nhập. Vui lòng thử lại." });
      this.working = true;
      try {
        const hash = await derive(parsed.data.password, this.account.salt);
        if (!equal(hash, this.account.passwordHash) || !equal(parsed.data.username, this.account.username)) {
          return reply.code(401).send({ message: "Tài khoản hoặc mật khẩu không đúng." });
        }
        this.openSession(request, reply);
        app.log.info({ event: "hub_login" }, "Hub login succeeded");
        return { authenticated: true };
      } finally { this.working = false; }
    });
    app.post("/hub-api/logout", async (request, reply) => {
      const key = this.sessionKey(request.raw);
      if (key) {
        const scope = digest(`hub:${key}`);
        if (this.onLogoutHook) {
          try {
            await this.onLogoutHook(scope);
          } catch {
            return reply.code(503).send({ message: "Không thể thu hồi thiết bị thông báo." });
          }
        }
        this.sessions.delete(key);
      }
      this.setCookie(reply, "");
      app.log.info({ event: "hub_logout" }, "Hub session revoked");
      return { ok: true };
    });
    app.post("/hub-api/password", async (request, reply) => {
      const wait = this.rateAllowed(request.ip);
      if (wait) return reply.header("Retry-After", wait).code(429).send({ message: "Thử quá nhiều lần. Vui lòng đợi vài phút." });
      const parsed = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(12).max(256) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: "Mật khẩu mới cần ít nhất 12 ký tự." });
      if (this.working) return reply.code(429).send({ message: "Đang xử lý. Vui lòng thử lại." });
      this.working = true;
      try {
        if (!equal(await derive(parsed.data.currentPassword, this.account.salt), this.account.passwordHash)) return reply.code(401).send({ message: "Mật khẩu hiện tại không đúng." });
        if (this.onPasswordChangeHook) {
          try {
            await this.onPasswordChangeHook();
          } catch {
            return reply.code(503).send({ message: "Không thể thu hồi thiết bị thông báo." });
          }
        }
        const salt = crypto.randomBytes(16).toString("hex");
        const account = { ...this.account, salt, passwordHash: await derive(parsed.data.newPassword, salt), mustChangePassword: false };
        const destination = path.join(this.options.authDataDir, "account.json");
        fs.writeFileSync(destination + ".tmp", JSON.stringify(account), { mode: 0o600 });
        fs.renameSync(destination + ".tmp", destination);
        this.account = account;
        this.sessions.clear();
        this.openSession(request, reply);
        fs.rmSync(path.join(this.options.authDataDir, "initial-login.txt"), { force: true });
        app.log.info({ event: "hub_password_changed" }, "Password changed and previous sessions revoked");
        return { ok: true };
      } finally { this.working = false; }
    });
    app.addHook("onClose", async () => { this.sessions.clear(); });
  }
}
