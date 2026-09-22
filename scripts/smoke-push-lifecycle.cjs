const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { build } = require("esbuild");
const { resolvePuppeteer, resolveChromePath } = require("./smoke-utils.cjs");

// Run the real App, owner hook, settings views and API client. Only the Firebase
// SDK, external browser/backend services and unrelated terminal renderer are
// fakes; the normal multi-session/mobile smokes cover xterm separately.
const root = path.resolve(__dirname, "..");
const sourceRoot = process.env.PUSH_TEST_SOURCE_ROOT || root;
const sdk = `
  const state = () => globalThis.__pushTest;
  export const initializeApp = () => ({});
  export const getApps = () => [];
  export const getMessaging = () => ({});
  export const isSupported = async () => true;
  export const onRegistered = (_, callback) => {
    state().registeredCallback = callback;
    return () => { if (state().registeredCallback === callback) state().registeredCallback = null; };
  };
  export const register = async () => {
    state().registrations++;
    state().registeredCallback?.('c' + 'a'.repeat(21));
  };
  export const unregister = async () => { state().unregistrations++; };
  export const onMessage = (_, callback) => {
    state().foregroundAttachments++;
    state().foregroundCallback = callback;
    return () => { if (state().foregroundCallback === callback) state().foregroundCallback = null; };
  };
`;

function installServices(options) {
  const state = window.__pushTest = {
    authenticated: options.authenticated !== false, permission: options.permission || "granted",
    configRequests: 0, registrations: 0, unregistrations: 0,
    backendRequests: 0, foregroundAttachments: 0, permissionRequests: 0,
    foregroundCallback: null, registeredCallback: null,
    failBackend: Boolean(options.failBackend), failLogout: Boolean(options.failLogout),
    holdBackend: options.holdBackend !== false,
    holdLogout: Boolean(options.holdLogout)
  };
  state.backendGate = new Promise(resolve => { state.releaseBackend = resolve; });
  state.logoutGate = new Promise(resolve => { state.releaseLogout = resolve; });
  if (options.consent !== false) localStorage.setItem("web_cli_push_consent", "true");
  else localStorage.removeItem("web_cli_push_consent");
  Object.defineProperty(Notification, "permission", { configurable: true, get: () => state.permission });
  Notification.requestPermission = async () => {
    state.permissionRequests++;
    state.permission = "granted";
    return "granted";
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: async () => ({}), ready: Promise.resolve({}), addEventListener() {}, removeEventListener() {} }
  });
  window.fetch = async (input, init = {}) => {
    const pathname = new URL(String(input), location.origin).pathname.replace(/^\/api\/web-cli/, "");
    let body;
    let status = 200;
    switch (pathname) {
      case "/api/auth/status": body = { authenticated: state.authenticated, setupRequired: false, username: "tester" }; break;
      case "/api/auth/login": state.authenticated = true; body = {}; break;
      case "/api/auth/logout":
        if (state.holdLogout) await state.logoutGate;
        if (state.failLogout) { body = { message: "Logout failed" }; status = 503; }
        else { state.authenticated = false; body = {}; }
        break;
      case "/api/agents": body = { agents: [] }; break;
      case "/api/projects": body = { projects: [] }; break;
      case "/api/sessions": body = { sessions: [], capacity: { active: 0, reserved: 0, max: 10 } }; break;
      case "/api/notifications/config":
        state.configRequests++;
        body = { enabled: true, supportedAgents: ["codex"], vapidPublicKey: "fake", firebaseConfig: { apiKey: "fake", projectId: "fake", messagingSenderId: "fake", appId: "fake" } };
        break;
      case "/api/notifications/devices":
        state.backendRequests++;
        // Deliberately ignore AbortSignal: a request already sent can finish late.
        if (state.holdBackend) await state.backendGate;
        status = state.failBackend ? 503 : 200;
        body = state.failBackend ? { message: "Registration unavailable" } : { ok: true };
        break;
      case "/api/notifications/test": body = { queued: true, eventId: "test-event" }; break;
      default:
        if (pathname.startsWith("/api/notifications/devices/") && init.method === "DELETE") body = { ok: true };
        else throw new Error("Unexpected fixture request: " + pathname);
    }
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  window.pushSnapshot = () => ({
    statuses: [...document.querySelectorAll("h3")]
      .filter(h => h.textContent.includes("Thông báo đẩy"))
      .map(h => h.parentElement.parentElement.querySelector("span")?.textContent.trim()),
    registrations: state.registrations, backendRequests: state.backendRequests,
    foregroundAttachments: state.foregroundAttachments,
    foregroundActive: Boolean(state.foregroundCallback), permissionRequests: state.permissionRequests,
    consent: localStorage.getItem("web_cli_push_consent")
  });
}

async function main() {
  const result = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import App from ${JSON.stringify(path.join(sourceRoot, "web/src/App.tsx"))}; createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);`,
      resolveDir: root, loader: "tsx"
    },
    bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
    nodePaths: [path.join(root, "node_modules")],
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env": "{}" },
    plugins: [{ name: "fake-firebase", setup(builder) {
      builder.onResolve({ filter: /^\.\/components\/TerminalPane$/ }, () => ({ path: "terminal", namespace: "fake-terminal" }));
      builder.onLoad({ filter: /.*/, namespace: "fake-terminal" }, () => ({
        contents: "import {forwardRef} from 'react'; export const TerminalPane = forwardRef(() => null);",
        loader: "js", resolveDir: root
      }));
      builder.onResolve({ filter: /^firebase\/(app|messaging)$/ }, args => ({ path: args.path, namespace: "fake-sdk" }));
      builder.onLoad({ filter: /.*/, namespace: "fake-sdk" }, () => ({ contents: sdk, loader: "js" }));
    } }]
  });
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html><body><div id="root"></div></body></html>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200, "fixture HTTP health");
  const puppeteer = resolvePuppeteer();
  let browser;
  const failures = [];
  const checks = [];
  try {
    browser = await puppeteer.launch({ executablePath: resolveChromePath(), headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    async function scenario(name, options, verify) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto(base);
        await page.evaluate(installServices, options);
        await page.addScriptTag({ type: "module", content: result.outputFiles[0].text });
        if (options.authenticated === false) {
          await page.waitForSelector('input[name="username"]');
          assert.equal((await page.evaluate(() => window.pushSnapshot())).backendRequests, 0);
          await page.type('input[name="username"]', "tester");
          await page.type('input[name="password"]', "test-password");
          await page.type('input[name="code"]', "123456");
          await page.click("button.primary");
        }
        await page.waitForFunction(consent => {
          const statuses = window.pushSnapshot().statuses;
          return statuses.length === 2 && statuses.every(s => consent === false
            ? s === "Chưa bật trên thiết bị"
            : s !== "Chưa bật trên thiết bị");
        }, { timeout: 5000 }, options.consent);
        await verify(page);
        assert.deepEqual(errors, [], "no page errors/unhandled rejections");
        checks.push(name);
      } catch (error) {
        failures.push(name + ": " + error.message);
      } finally { await context.close(); }
    }
    const snapshot = page => page.evaluate(() => window.pushSnapshot());
    const clickLabel = (page, label) => page.evaluate(label => document.querySelector(`[aria-label="${label}"]`).click(), label);
    const clickText = (page, text) => page.evaluate(text => {
      const button = [...document.querySelectorAll("button")].find(b => b.textContent.trim().startsWith(text));
      if (!button || button.disabled) throw new Error("Button unavailable: " + text);
      button.click();
    }, text);

    await scenario("F3.1/F3.2 reload silently refreshes once; two settings share pending/success state", {}, async page => {
      await page.waitForFunction(() => window.pushSnapshot().backendRequests > 0 || window.pushSnapshot().statuses.includes("Đã bật"));
      const pending = await snapshot(page);
      assert.deepEqual(pending.statuses, ["Đang đăng ký...", "Đang đăng ký..."], "consent alone must not display registered");
      assert.equal(pending.registrations, 1);
      assert.equal(pending.backendRequests, 1);
      assert.equal(pending.foregroundActive, false);
      assert.equal(pending.permissionRequests, 0);
      await clickLabel(page, "Thu gọn danh sách phiên");
      await page.waitForFunction(() => window.pushSnapshot().statuses.length === 1);
      await page.evaluate(() => window.__pushTest.releaseBackend());
      await page.waitForFunction(() => window.pushSnapshot().statuses[0] === "Đã bật");
      await clickLabel(page, "Mở danh sách phiên");
      await page.waitForFunction(() => window.pushSnapshot().statuses.length === 2);
      const done = await snapshot(page);
      assert.deepEqual(done.statuses, ["Đã bật", "Đã bật"]);
      assert.equal(done.backendRequests, 1);
      assert.equal(done.foregroundAttachments, 1);
      assert.equal(done.permissionRequests, 0);
      await page.evaluate(() => window.__pushTest.foregroundCallback({ data: { type: "attention", sessionId: "session", eventId: "event" } }));
      await page.waitForFunction(() => document.body.textContent.includes("Mở phiên"));
    });

    await scenario("F3.3 logout invalidates pending refresh before logout HTTP completes", { holdLogout: true }, async page => {
      await page.waitForFunction(() => window.pushSnapshot().backendRequests > 0 || window.pushSnapshot().statuses.includes("Đã bật"));
      assert.equal((await snapshot(page)).backendRequests, 1);
      await clickLabel(page, "Cài đặt hệ thống");
      await clickText(page, "Đăng xuất");
      await page.evaluate(() => window.__pushTest.releaseBackend());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal((await snapshot(page)).foregroundActive, false);
      assert.ok(!(await snapshot(page)).statuses.includes("Đã bật"));
      await page.evaluate(() => window.__pushTest.releaseLogout());
      await page.waitForFunction(() => !window.pushSnapshot().statuses.length);
      assert.equal((await snapshot(page)).consent, null);
      assert.equal((await snapshot(page)).foregroundActive, false);
    });

    await scenario("F3.4 backend failure does not turn stored consent into registered", { failBackend: true, holdBackend: false }, async page => {
      await page.waitForFunction(() => window.pushSnapshot().statuses.some(s => s === "Lỗi đăng ký" || s === "Đã bật"));
      const state = await snapshot(page);
      assert.deepEqual(state.statuses, ["Lỗi đăng ký", "Lỗi đăng ký"]);
      assert.equal(state.foregroundActive, false);
      assert.equal(state.backendRequests, 1);
      assert.equal(state.permissionRequests, 0);
    });

    await scenario("F3.5 explicit enable shares one permission/backend action across both settings", { consent: false, permission: "default" }, async page => {
      // Both surfaces can dispatch before React commits disabled=true.
      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll("button")].filter(b => b.textContent.trim() === "Bật thông báo");
        if (buttons.length !== 2 || buttons.some(b => b.disabled)) throw new Error("Enable surfaces not ready");
        for (const button of buttons) button.click();
      });
      await page.waitForFunction(() => window.pushSnapshot().backendRequests > 0);
      const pending = await snapshot(page);
      assert.deepEqual(pending.statuses, ["Đang đăng ký...", "Đang đăng ký..."]);
      assert.equal(pending.consent, null);
      assert.equal(pending.permissionRequests, 1);
      assert.equal(pending.backendRequests, 1);
      assert.equal(pending.foregroundActive, false);
      await page.evaluate(() => window.__pushTest.releaseBackend());
      await page.waitForFunction(() => window.pushSnapshot().statuses.every(s => s === "Đã bật"));
      assert.equal((await snapshot(page)).consent, "true");
      assert.equal((await snapshot(page)).foregroundAttachments, 1);
    });

    await scenario("F3.6 failed logout resumes one authenticated push owner", { failLogout: true, holdBackend: false }, async page => {
      await page.waitForFunction(() => window.pushSnapshot().statuses.every(s => s === "Đã bật"));
      assert.equal((await snapshot(page)).backendRequests, 1);
      await clickLabel(page, "Cài đặt hệ thống");
      await clickText(page, "Đăng xuất");
      await page.waitForFunction(() => window.pushSnapshot().backendRequests === 2 && window.pushSnapshot().statuses.every(s => s === "Đã bật"));
      assert.equal((await snapshot(page)).foregroundActive, true);
      assert.equal((await snapshot(page)).permissionRequests, 0);
    });

    await scenario("F3.7 login refreshes existing consent; auth expiry invalidates pending work", { authenticated: false }, async page => {
      await page.waitForFunction(() => window.pushSnapshot().backendRequests > 0);
      assert.equal((await snapshot(page)).permissionRequests, 0);
      await page.evaluate(() => {
        window.__pushTest.authenticated = false;
        window.dispatchEvent(new Event("web-cli-auth-expired"));
        window.__pushTest.releaseBackend();
      });
      await page.waitForSelector('input[name="username"]');
      assert.equal((await snapshot(page)).consent, null);
      assert.equal((await snapshot(page)).foregroundActive, false);
      assert.deepEqual((await snapshot(page)).statuses, []);
    });
    console.log(JSON.stringify({ passed: failures.length === 0, checks, failures }, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
