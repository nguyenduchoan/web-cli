import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerHub } from "../src/hub.js";
import { registerAuth, makeTotp } from "../src/webAuth.js";
import type { AppConfig } from "../src/config.js";

const origin = "https://hub.example.test";
const headers = { host: "hub.example.test", "x-forwarded-proto": "https", origin };
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "server-hub-test-"));
  const app = Fastify({ trustProxy: true });
  const config = { hub: { origin, username: "owner", authDataDir: path.join(dir, "hub") }, authDataDir: path.join(dir, "cli"), clientOrigins: [], agents: [], projects: [] } as unknown as AppConfig;
  const hub = await registerHub(app, config);
  const auth = registerAuth(app, config, hub);
  app.get("/api/projects", async () => ({ projects: [] }));
  app.get("/api/health", async () => ({ ok: true }));
  const password = fs.readFileSync(path.join(dir, "hub/initial-login.txt"), "utf8").match(/^Password: (.+)$/m)![1];
  const post = (url: string, payload: unknown, extra: Record<string, string> = {}) => app.inject({ method: "POST", url, headers: { ...headers, ...extra }, payload });
  return { app, config, hub: hub!, auth, password, post, dir, close: async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
function cookieOf(response: { headers: Record<string, unknown> }, name: string): string {
  const values = [response.headers["set-cookie"]].flat() as string[];
  return values.find((value) => value.startsWith(name + "="))!.split(";")[0];
}

test("hub gates static files, internal API and first enrollment; Origin, cookies and password rotation", async (t) => {
  const f = await fixture(); t.after(f.close);
  assert.equal((await f.app.inject({ url: "/vietqr/", headers })).statusCode, 303);
  assert.equal((await f.app.inject({ url: "/api/projects", headers })).statusCode, 401);
  assert.equal((await f.app.inject({ url: "/hub-api/web-cli-setup", headers })).statusCode, 401);
  assert.equal((await f.app.inject({ url: "/login", headers })).statusCode, 200);
  assert.equal((await f.app.inject({ url: "/hub-api/status", headers: { host: "hub.example.test" } })).statusCode, 403);
  assert.equal((await f.post("/hub-api/login", { username: "owner", password: f.password }, { origin: "https://evil.example" })).statusCode, 403);
  assert.equal((await f.post("/hub-api/login", { username: "owner", password: "wrong" })).statusCode, 401);
  const login = await f.post("/hub-api/login", { username: "owner", password: f.password });
  assert.equal(login.statusCode, 200);
  const cookie = cookieOf(login, "__Host-server_hub");
  const setCookie = String(login.headers["set-cookie"]);
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(setCookie.includes(flag));
  assert.equal((await f.app.inject({ url: "/vietqr/", headers: { ...headers, cookie } })).statusCode, 200);
  assert.equal((await f.app.inject({ url: "/api/projects", headers: { ...headers, cookie } })).statusCode, 401, "hub alone does not grant terminal access");
  assert.equal((await f.app.inject({ url: "/hub-api/web-cli-setup", headers: { ...headers, cookie } })).statusCode, 200);
  for (const url of ["/secrets/account.json", "/.env", "/server/src/index.ts", "/vietqr/../account.json"]) assert.equal((await f.app.inject({ url, headers: { ...headers, cookie } })).statusCode, 404);
  const rotation = await f.post("/hub-api/password", { currentPassword: f.password, newPassword: "new-owner-password-2026" }, { cookie });
  assert.equal(rotation.statusCode, 200);
  assert.equal(f.hub.valid(f.hub.sessionKey({ headers: { cookie } })), false);
  assert.ok(!fs.existsSync(path.join(f.dir, "hub/initial-login.txt")));
  const stored = fs.readFileSync(path.join(f.dir, "hub/account.json"), "utf8");
  assert.ok(!stored.includes("new-owner-password-2026"));
  assert.equal(fs.statSync(path.join(f.dir, "hub/account.json")).mode & 0o777, 0o600);
  assert.equal((await f.post("/hub-api/login", { username: "owner", password: f.password })).statusCode, 401);
  assert.equal((await f.post("/hub-api/login", { username: "owner", password: "new-owner-password-2026" })).statusCode, 200);
});

test("Web CLI stays behind TOTP; its session requires the matching hub cookie and is revoked with hub", async (t) => {
  const f = await fixture(); t.after(f.close);
  const login = await f.post("/hub-api/login", { username: "owner", password: f.password });
  const hubCookie = cookieOf(login, "__Host-server_hub");
  const setupCode = fs.readFileSync(path.join(f.dir, "cli/setup-code.txt"), "utf8").trim();
  const setup = await f.post("/api/auth/setup", { setupCode, username: "cli-owner", password: "test-password-for-cli" }, { cookie: hubCookie });
  assert.equal(setup.statusCode, 200);
  assert.equal((await f.post("/api/auth/setup/confirm", { enrollmentId: setup.json().enrollmentId, code: "bad" }, { cookie: hubCookie })).statusCode, 401);
  const confirm = await f.post("/api/auth/setup/confirm", { enrollmentId: setup.json().enrollmentId, code: makeTotp(setup.json().secret).generate() }, { cookie: hubCookie });
  assert.equal(confirm.statusCode, 200);
  const cliCookie = cookieOf(confirm, "web_cli_session");
  const cookie = `${hubCookie}; ${cliCookie}`;
  const key = f.auth.sessionKey({ headers: { cookie } });
  assert.ok(f.auth.valid(key));
  assert.equal(f.auth.sessionKey({ headers: { cookie: cliCookie } }), undefined, "WebSocket handshake also requires the hub cookie");
  assert.equal((await f.app.inject({ url: "/api/projects", headers: { ...headers, cookie } })).statusCode, 200);
  assert.equal((await f.post("/hub-api/logout", {}, { cookie })).statusCode, 200);
  assert.equal(f.auth.valid(key), false, "already connected WebSockets lose authorization on hub logout");
  assert.equal((await f.app.inject({ url: "/api/projects", headers: { ...headers, cookie } })).statusCode, 401);
});

test("hub auth rejects unbounded attempts and duplicate cookies", async (t) => {
  const f = await fixture(); t.after(f.close);
  for (let i = 0; i < 10; i++) assert.equal((await f.post("/hub-api/login", {})).statusCode, 400);
  assert.equal((await f.post("/hub-api/login", {})).statusCode, 429);
  assert.equal(f.hub.sessionKey({ headers: { cookie: `__Host-server_hub=${"a".repeat(43)}; __Host-server_hub=${"b".repeat(43)}` } }), undefined);
});
