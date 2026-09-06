import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { makeTotp, registerAuth } from "../src/webAuth.js";
import { isLoopbackHost, type AppConfig } from "../src/config.js";
const headers = { host: "cli.example.test", origin: "https://cli.example.test", "x-forwarded-proto": "https" };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-cli-auth-test-"));
  const app = Fastify({ trustProxy: ["127.0.0.1", "::1"] });
  const config = { clientOrigins: [], authDataDir: dir } as unknown as AppConfig;
  const auth = registerAuth(app, config);
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/health/private", async () => ({ private: true }));
  app.get("/api/sessions", async () => ({ sessions: [] }));
  const post = (url: string, payload: unknown, extra: Record<string, string> = {}) => app.inject({ method: "POST", url, payload, headers: { ...headers, ...extra } });
  const setupCode = fs.readFileSync(path.join(dir, "setup-code.txt"), "utf8").trim();
  return { app, auth, dir, config, post, setupCode };
}

test("setup requires owner code and TOTP; session cookies, logout, replay and recovery are enforced", async (t) => {
  const f = fixture(); t.after(async () => { await f.app.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  assert.equal((await f.app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
  assert.equal((await f.app.inject({ method: "GET", url: "/api/health/private", headers })).statusCode, 401);
  assert.equal((await f.app.inject({ method: "GET", url: "/api/sessions", headers: { ...headers, authorization: "Bearer old-token" } })).statusCode, 401);
  assert.equal((await f.post("/api/auth/setup", { setupCode: "wrong", username: "owner", password: "long-password-for-tests" })).statusCode, 401);
  const setup = await f.post("/api/auth/setup", { setupCode: f.setupCode, username: "owner", password: "long-password-for-tests" });
  assert.equal(setup.statusCode, 200);
  assert.match(setup.json().qr, /^data:image\/png;base64,/);
  assert.equal((await f.app.inject({ method: "GET", url: "/api/sessions", headers })).statusCode, 401);
  const code = makeTotp(setup.json().secret).generate();
  const confirmed = await f.post("/api/auth/setup/confirm", { enrollmentId: setup.json().enrollmentId, code });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json().recoveryCodes.length, 10);
  const rawSetCookie = confirmed.headers["set-cookie"];
  const cookieLines = Array.isArray(rawSetCookie) ? rawSetCookie : String(rawSetCookie).split(/,(?=web_cli_)/);
  const setCookie = cookieLines.join(",");
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Secure/);
  assert.match(setCookie, /web_cli_device=/);
  const sessionLine = cookieLines.find((item) => item.includes("web_cli_session="))!;
  const deviceLine = cookieLines.find((item) => item.includes("web_cli_device="))!;
  const cookie = sessionLine.split(";")[0];
  const deviceCookie = deviceLine.trim().split(";")[0];
  const key = f.auth.sessionKey({ headers: { cookie } }); assert.equal(f.auth.valid(key), true);
  assert.equal((await f.app.inject({ method: "GET", url: "/api/sessions", headers: { ...headers, cookie } })).statusCode, 200);
  assert.equal((await f.post("/api/auth/logout", {}, { cookie, origin: "https://evil.example" })).statusCode, 403);
  assert.equal((await f.post("/api/auth/logout", {}, { cookie })).statusCode, 200);
  assert.equal(f.auth.valid(key), false);
  const trustedRecovery = confirmed.json().recoveryCodes[0];
  assert.equal((await f.post("/api/auth/login", { code: trustedRecovery }, { cookie: deviceCookie })).statusCode, 200);
  assert.equal((await f.post("/api/auth/login", { username: "owner", password: "long-password-for-tests", code })).statusCode, 401);
  const recovery = confirmed.json().recoveryCodes[1];
  assert.equal((await f.post("/api/auth/login", { username: "owner", password: "incorrect-password", code: recovery })).statusCode, 401);
  assert.equal((await f.post("/api/auth/login", { username: "owner", password: "long-password-for-tests", code: recovery })).statusCode, 200);
  assert.equal((await f.post("/api/auth/login", { username: "owner", password: "long-password-for-tests", code: recovery })).statusCode, 401);
  const stored = fs.readFileSync(path.join(f.dir, "account.json"), "utf8");
  assert.ok(!stored.includes("long-password-for-tests")); assert.ok(!stored.includes(recovery));
  assert.equal(fs.statSync(path.join(f.dir, "account.json")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.dir, "setup-code.txt")), false);
});

test("public HTTP is rejected and authentication attempts are bounded", async (t) => {
  const f = fixture(); t.after(async () => { await f.app.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  assert.equal((await f.app.inject({ method: "GET", url: "/api/auth/status", headers: { host: "cli.example.test" } })).statusCode, 403);
  for (let i = 0; i < 10; i++) assert.equal((await f.post("/api/auth/login", { username: "owner", password: "x", code: "000000" })).statusCode, 401);
  assert.equal((await f.post("/api/auth/login", { username: "owner", password: "x", code: "000000" })).statusCode, 429);
});

test("server binds only explicit loopback addresses", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true); assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false); assert.equal(isLoopbackHost("localhost"), false);
});
