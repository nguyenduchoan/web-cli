import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TOTP, Secret } from "otpauth";
import QRCode from "qrcode";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { IncomingMessage } from "node:http";
import type { AppConfig } from "./config.js";

const derivePassword = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
const COOKIE = "web_cli_session";
const DEVICE_COOKIE = "web_cli_device";
const MAX_AGE = 12 * 60 * 60 * 1000;
const IDLE_AGE = 30 * 60 * 1000;
const DEVICE_MAX_AGE = 180 * 24 * 60 * 60 * 1000;
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const equal = (a: string, b: string) => crypto.timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const setupSchema = z.object({ setupCode: z.string().max(128), username: z.string().regex(/^[a-zA-Z0-9_.-]{3,40}$/), password: z.string().min(12).max(256) });
const loginSchema = z.object({ username: z.string().max(40).optional(), password: z.string().max(256).optional(), code: z.string().max(40) });
type Credential = { username: string; salt: string; passwordHash: string; secret: string; lastCounter: number; recovery: string[]; devices?: string[] };
type LoginSession = { expiresAt: number; lastSeen: number };
type Pending = { id: string; credential: Credential; expiresAt: number };

export function makeTotp(secret: string, username = "owner"): TOTP {
  return new TOTP({ issuer: "Web CLI", label: username, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) });
}

export class WebAuth {
  private credential?: Credential;
  private pending?: Pending;
  private readonly sessions = new Map<string, LoginSession>();
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private working = false;
  private setupCode = "";
  private readonly credentialPath: string;
  private readonly setupPath: string;

  constructor(private readonly config: AppConfig) {
    const dir = config.authDataDir ?? "/var/www/html/secrets/web-cli-auth";
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    this.credentialPath = path.join(dir, "account.json");
    this.setupPath = path.join(dir, "setup-code.txt");
    if (fs.existsSync(this.credentialPath)) {
      this.credential = JSON.parse(fs.readFileSync(this.credentialPath, "utf8"));
      fs.chmodSync(this.credentialPath, 0o600);
    } else {
      if (!fs.existsSync(this.setupPath)) fs.writeFileSync(this.setupPath, crypto.randomBytes(32).toString("base64url") + "\n", { flag: "wx", mode: 0o600 });
      fs.chmodSync(this.setupPath, 0o600);
      this.setupCode = fs.readFileSync(this.setupPath, "utf8").trim();
      if (this.setupCode.length < 32) throw new Error("Invalid Web CLI setup code file");
    }
  }

  private save(credential: Credential): void {
    const temporary = this.credentialPath + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(credential), { mode: 0o600 });
    fs.renameSync(temporary, this.credentialPath);
    this.credential = credential;
  }

  sessionKey(request: Pick<IncomingMessage, "headers">): string | undefined {
    const token = this.cookie(request, COOKIE);
    if (!token) return undefined;
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token) : undefined;
  }

  private cookie(request: Pick<IncomingMessage, "headers">, name: string): string | undefined {
    const value = (request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="));
    return value?.slice(name.length + 1);
  }

  trustedDevice(request: Pick<IncomingMessage, "headers">): boolean {
    const token = this.cookie(request, DEVICE_COOKIE);
    return Boolean(token && /^[A-Za-z0-9_-]{43}$/.test(token) && this.credential?.devices?.includes(digest(token)));
  }

  valid(key: string | undefined, touch = false): boolean {
    const session = key ? this.sessions.get(key) : undefined;
    if (!session || session.expiresAt <= Date.now() || session.lastSeen + IDLE_AGE <= Date.now()) {
      if (key) this.sessions.delete(key);
      return false;
    }
    if (touch) session.lastSeen = Date.now();
    return true;
  }

  allowedOrigin(request: FastifyRequest): boolean {
    const { origin, host } = request.headers;
    if (!origin || !host) return false;
    const protocol = request.protocol;
    return origin === `${protocol}://${host}` || this.config.clientOrigins.includes(origin);
  }

  private secureTransport(request: FastifyRequest): boolean {
    if (request.protocol === "https") return true;
    return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(request.headers.host ?? "");
  }

  private setCookies(reply: FastifyReply, request: FastifyRequest, sessionToken: string, deviceToken?: string, clear = false): void {
    const secure = request.protocol === "https";
    const cookies = [`${COOKIE}=${sessionToken}; Path=/api/web-cli/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : MAX_AGE / 1000}${secure ? "; Secure" : ""}`];
    if (deviceToken) cookies.push(`${DEVICE_COOKIE}=${deviceToken}; Path=/api/web-cli/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : DEVICE_MAX_AGE / 1000}${secure ? "; Secure" : ""}`);
    reply.header("Set-Cookie", cookies);
  }

  private openSession(reply: FastifyReply, request: FastifyRequest): void {
    for (const key of this.sessions.keys()) this.valid(key);
    while (this.sessions.size >= 8) this.sessions.delete(this.sessions.keys().next().value!);
    const token = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(digest(token), { expiresAt: Date.now() + MAX_AGE, lastSeen: Date.now() });
    const deviceToken = crypto.randomBytes(32).toString("base64url");
    if (this.credential) {
      this.credential.devices = [...new Set([...(this.credential.devices ?? []), digest(deviceToken)])].slice(-8);
      this.save(this.credential);
    }
    this.setCookies(reply, request, token, deviceToken);
  }

  private consumeCode(credential: Credential, code: string): Credential | undefined {
    if (/^\d{6}$/.test(code)) {
      const timestamp = Date.now();
      const delta = makeTotp(credential.secret).validate({ token: code, window: 1, timestamp });
      const counter = Math.floor(timestamp / 30_000) + (delta ?? 0);
      if (delta === null || counter <= credential.lastCounter) return undefined;
      return { ...credential, lastCounter: counter };
    }
    const hash = digest(code.replace(/[-\s]/g, "").toLowerCase());
    if (!credential.recovery.includes(hash)) return undefined;
    return { ...credential, recovery: credential.recovery.filter((item) => item !== hash) };
  }

  register(app: FastifyInstance): void {
    app.addHook("preHandler", async (request, reply) => {
      const pathname = request.url.split("?", 1)[0];
      if (!pathname.startsWith("/api/")) return;
      reply.header("Cache-Control", "no-store");
      if (pathname === "/api/health") return;
      if (!this.secureTransport(request)) return reply.code(403).send({ message: "Vui lòng mở Web CLI qua HTTPS." });
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !this.allowedOrigin(request)) return reply.code(403).send({ message: "Nguồn yêu cầu không hợp lệ." });
      if (["/api/auth/status", "/api/auth/login", "/api/auth/setup", "/api/auth/setup/confirm"].includes(pathname)) {
        if (request.method === "POST") {
          const now = Date.now();
          for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
          if (this.attempts.size > 1000) return reply.code(429).send({ message: "Đang có nhiều yêu cầu. Vui lòng thử lại sau." });
          for (const [key, limit] of [[request.ip, 10], ["global", 60]] as const) {
            const attempt = this.attempts.get(key) ?? { count: 0, until: now + 5 * 60_000 };
            this.attempts.set(key, attempt);
            if (++attempt.count > limit) return reply.header("Retry-After", Math.ceil((attempt.until - now) / 1000)).code(429).send({ message: "Thử quá nhiều lần. Vui lòng đợi vài phút." });
          }
        }
        return;
      }
      if (!this.valid(this.sessionKey(request.raw), true)) return reply.code(401).send({ message: "Vui lòng đăng nhập lại bằng mật khẩu và mã 2FA." });
    });

    app.get("/api/auth/status", async (request) => ({ setupRequired: !this.credential, authenticated: this.valid(this.sessionKey(request.raw)), trustedDevice: this.trustedDevice(request.raw), username: this.valid(this.sessionKey(request.raw)) ? this.credential?.username : undefined }));

    app.post("/api/auth/setup", async (request, reply) => {
      const parsed = setupSchema.safeParse(request.body);
      if (this.credential || !parsed.success || !equal(parsed.data.setupCode, this.setupCode)) return reply.code(401).send({ message: "Mã thiết lập không hợp lệ hoặc tài khoản đã được tạo. Mật khẩu cần ít nhất 12 ký tự." });
      if (this.working) return reply.code(429).send({ message: "Đang xử lý, vui lòng thử lại." });
      this.working = true;
      try {
        const { username, password } = parsed.data;
        const salt = crypto.randomBytes(16).toString("hex");
        const passwordHash = (await derivePassword(password, salt) as Buffer).toString("hex");
        const secret = new Secret({ size: 20 }).base32;
        const credential = { username, salt, passwordHash, secret, lastCounter: -1, recovery: [], devices: [] };
        const id = crypto.randomBytes(32).toString("base64url");
        const uri = makeTotp(secret, username).toString();
        const qr = await QRCode.toDataURL(uri, { width: 240, margin: 2 });
        this.pending = { id, credential, expiresAt: Date.now() + 10 * 60_000 };
        return { enrollmentId: id, secret, uri, qr };
      } finally { this.working = false; }
    });

    app.post("/api/auth/setup/confirm", async (request, reply) => {
      const parsed = z.object({ enrollmentId: z.string().max(128), code: z.string().regex(/^\d{6}$/) }).safeParse(request.body);
      if (this.credential || !parsed.success || !this.pending || this.pending.expiresAt < Date.now() || !equal(this.pending.id, parsed.data.enrollmentId)) return reply.code(401).send({ message: "Thiết lập đã hết hạn. Vui lòng bắt đầu lại." });
      const credential = this.consumeCode(this.pending.credential, parsed.data.code);
      if (!credential) return reply.code(401).send({ message: "Mã 2FA không đúng. Hãy kiểm tra giờ trên điện thoại." });
      const recoveryCodes = Array.from({ length: 10 }, () => crypto.randomBytes(10).toString("hex"));
      credential.recovery = recoveryCodes.map(digest);
      this.save(credential);
      this.pending = undefined;
      this.setupCode = "";
      if (fs.existsSync(this.setupPath)) fs.unlinkSync(this.setupPath);
      this.openSession(reply, request);
      return { authenticated: true, recoveryCodes };
    });

    app.post("/api/auth/login", async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success || !this.credential) return reply.code(401).send({ message: "Thông tin đăng nhập không hợp lệ." });
      if (this.working) return reply.code(429).send({ message: "Đang xử lý, vui lòng thử lại." });
      this.working = true;
      try {
        const current = this.credential;
        if (!this.trustedDevice(request.raw)) {
          if (!parsed.data.password || !parsed.data.username) return reply.code(401).send({ message: "Thiết bị mới cần nhập tài khoản và mật khẩu đầy đủ." });
          const hash = (await derivePassword(parsed.data.password, current.salt) as Buffer).toString("hex");
          if (!equal(hash, current.passwordHash) || !equal(parsed.data.username, current.username)) return reply.code(401).send({ message: "Tài khoản, mật khẩu hoặc mã xác thực không đúng." });
        }
        const next = this.consumeCode(current, parsed.data.code.trim());
        if (!next) return reply.code(401).send({ message: "Tài khoản, mật khẩu hoặc mã xác thực không đúng. Nếu vừa dùng mã này, hãy đợi mã mới." });
        this.save(next);
        this.openSession(reply, request);
        return { authenticated: true };
      } finally { this.working = false; }
    });

    app.post("/api/auth/logout", async (request, reply) => {
      const key = this.sessionKey(request.raw);
      if (key) this.sessions.delete(key);
      this.setCookies(reply, request, "", undefined, true);
      return { ok: true };
    });
    app.addHook("onClose", async () => { this.sessions.clear(); this.pending = undefined; });
  }
}

export function registerAuth(app: FastifyInstance, config: AppConfig): WebAuth {
  const auth = new WebAuth(config);
  auth.register(app);
  return auth;
}
