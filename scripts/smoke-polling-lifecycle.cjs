const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { build } = require("esbuild");
const { resolvePuppeteer, resolveChromePath } = require("./smoke-utils.cjs");

const root = path.resolve(__dirname, "..");
const sourceRoot = process.env.POLLING_TEST_SOURCE_ROOT || root;

const apiFake = `
  export const listSessions = () => globalThis.__pollingApi.listSessions();
  export const createSession = async () => { throw new Error("unused test API"); };
  export const restartSession = async () => { throw new Error("unused test API"); };
  export const killSession = async () => { throw new Error("unused test API"); };
`;

function installPollingApi() {
  const activeSession = {
    id: "11111111-1111-4111-8111-111111111111",
    agentId: "shell",
    agentLabel: "Shell",
    projectId: "project",
    projectLabel: "Project",
    state: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1
  };
  const state = window.__pollingApi = {
    requests: 0,
    inFlight: 0,
    maxInFlight: 0,
    releaseExternal: null,
    externalGate: null,
    async listSessions() {
      const requestNumber = ++state.requests;
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (requestNumber === 2) {
          await new Promise((resolve) => {
            state.externalGate = resolve;
            state.releaseExternal = resolve;
          });
          return { sessions: [], serverEpoch: "epoch", registryRevision: 1, capacity: { active: 0, reserved: 0, max: 10 } };
        }
        if (requestNumber >= 3) {
          return { sessions: [activeSession], serverEpoch: "epoch", registryRevision: requestNumber, capacity: { active: 1, reserved: 0, max: 10 } };
        }
        return { sessions: [], serverEpoch: "epoch", registryRevision: 1, capacity: { active: 0, reserved: 0, max: 10 } };
      } finally {
        state.inFlight--;
      }
    }
  };
}

async function main() {
  const entry = path.join(sourceRoot, "web/src/features/sessions/useSessions.ts");
  const result = await build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { useSessions } from ${JSON.stringify(entry)};
        function Probe() {
          const [authenticated, setAuthenticated] = useState(false);
          const sessions = useSessions({ token: "", isAuthenticated: authenticated });
          window.__pollingProbe = {
            authenticated,
            activeSessionId: sessions.state.activeSessionId || null,
            login: () => setAuthenticated(true),
            logout: () => setAuthenticated(false),
            fetchExternally: () => sessions.fetchSessions()
          };
          return <div data-active={sessions.state.activeSessionId || ""}>{authenticated ? "authenticated" : "logged-out"}</div>;
        }
        createRoot(document.getElementById("root")).render(<React.StrictMode><Probe /></React.StrictMode>);
      `,
      resolveDir: root,
      loader: "tsx"
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    nodePaths: [path.join(root, "node_modules")],
    plugins: [{
      name: "fake-session-api",
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/\.\.\/lib\/api$/ }, () => ({ path: "api", namespace: "polling-fake" }));
        builder.onLoad({ filter: /.*/, namespace: "polling-fake" }, () => ({ contents: apiFake, loader: "js" }));
      }
    }]
  });

  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<!doctype html><html><body><div id="root"></div></body></html>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200, "fixture HTTP health");
  console.log(JSON.stringify({ fixture: base, pid: process.pid }));

  const puppeteer = resolvePuppeteer();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: resolveChromePath() || process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"]
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.evaluate(installPollingApi);
    // Observe the real five-second timers without replacing browser scheduling.
    await page.evaluate(() => {
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.__periodicTimers = { scheduled: 0, fired: 0 };
      window.setTimeout = (callback, delay, ...args) => {
        if (delay !== 5000 || typeof callback !== "function") return nativeSetTimeout(callback, delay, ...args);
        window.__periodicTimers.scheduled++;
        return nativeSetTimeout(() => {
          window.__periodicTimers.fired++;
          callback(...args);
        }, delay);
      };
    });
    await page.addScriptTag({ type: "module", content: result.outputFiles[0].text });
    await page.waitForFunction(() => Boolean(window.__pollingProbe));

    // A normal false -> true transition must immediately fetch, restore an active
    // session once one exists, and then schedule the five-second poll.
    await page.evaluate(() => window.__pollingProbe.login());
    await page.waitForFunction(() => window.__pollingApi.requests === 1);
    assert.equal((await page.evaluate(() => window.__pollingProbe.activeSessionId)), null);

    // Request #2 is initiated outside the scheduler. It stays pending through
    // logout/re-login while the scheduler is idle because no active session exists.
    await page.evaluate(() => { void window.__pollingProbe.fetchExternally(); });
    await page.waitForFunction(() => window.__pollingApi.requests === 2 && window.__pollingApi.inFlight === 1);
    await page.evaluate(() => window.__pollingProbe.logout());
    await page.waitForFunction(() => window.__pollingProbe.authenticated === false);
    await page.evaluate(() => window.__pollingProbe.login());
    await page.waitForFunction(() => window.__pollingProbe.authenticated === true);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    assert.equal(await page.evaluate(() => window.__pollingApi.requests), 2, "re-login waits behind the external stale request");

    await page.evaluate(() => window.__pollingApi.releaseExternal());
    await page.waitForFunction(() => window.__pollingApi.requests === 3 && window.__pollingProbe.activeSessionId !== null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__pollingApi.maxInFlight), 1, "session GETs never overlap");

    await page.waitForFunction(() => window.__pollingApi.requests >= 4, { timeout: 7500 });
    assert.equal(await page.evaluate(() => window.__pollingProbe.activeSessionId), "11111111-1111-4111-8111-111111111111");
    assert.equal(await page.evaluate(() => window.__pollingApi.maxInFlight), 1, "the periodic poll remains single-flight");

    // Keep the in-memory API fixture available offline: a scheduler bug must be
    // observed as an extra API invocation, not concealed by a failed HTTP request.
    await page.setOfflineMode(true);
    assert.equal(await page.evaluate(() => navigator.onLine), false, "Chromium reports offline");
    const offline = await page.evaluate(() => ({ requests: window.__pollingApi.requests, ...window.__periodicTimers }));
    await page.waitForFunction((fired) => window.__periodicTimers.fired > fired, { timeout: 7500, polling: 50 }, offline.fired);
    assert.equal(await page.evaluate(() => window.__pollingApi.requests), offline.requests, "pending poll cannot call the API offline");
    assert.equal(await page.evaluate(() => window.__periodicTimers.scheduled), offline.scheduled, "offline callback does not rearm polling");

    await page.setOfflineMode(false);
    await page.waitForFunction((count) => window.__pollingApi.requests > count, { timeout: 3000 }, offline.requests);
    assert.equal(await page.evaluate(() => navigator.onLine), true);
    assert.equal(await page.evaluate(() => window.__pollingApi.requests), offline.requests + 1, "native online event refreshes exactly once");
    assert.equal(await page.evaluate(() => window.__periodicTimers.scheduled), offline.scheduled + 1, "online refresh schedules one periodic timer");
    await page.waitForFunction((count) => window.__pollingApi.requests > count + 1, { timeout: 7500 }, offline.requests);
    assert.equal(await page.evaluate(() => window.__pollingApi.requests), offline.requests + 2, "five-second polling resumes");
    assert.equal(await page.evaluate(() => window.__pollingApi.maxInFlight), 1);
    assert.deepEqual(errors, [], "no page errors or unhandled rejections");
    console.log(JSON.stringify({ passed: true, offlinePolling: true, requests: await page.evaluate(() => window.__pollingApi.requests) }));
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error("POLLING LIFECYCLE SMOKE FAILED:", error);
  process.exitCode = 1;
});
