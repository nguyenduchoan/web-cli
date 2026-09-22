import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const config = {
  enabled: true,
  supportedAgents: ["codex"],
  firebaseConfig: { apiKey: "test", projectId: "test", messagingSenderId: "test", appId: "test" },
  vapidPublicKey: "test"
};

const bundle = build({
  entryPoints: [process.env.PUSH_SOURCE_PATH ?? path.join(root, "web/src/lib/push.ts")],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "pushModule",
  platform: "browser",
  plugins: [{
    name: "push-dependencies",
    setup(builder) {
      builder.onResolve({ filter: /^(firebase\/(app|messaging)|\.\/api)$/ }, args => ({ path: args.path, namespace: "push-mock" }));
      builder.onLoad({ filter: /.*/, namespace: "push-mock" }, ({ path: modulePath }) => ({
        contents: modulePath === "firebase/app" ? `
          export const getApps = () => [];
          export const initializeApp = () => ({});
        ` : modulePath === "firebase/messaging" ? `
          export const getMessaging = () => ({});
          export const isSupported = () => fixture.support();
          export const onMessage = (_, callback) => {
            fixture.foreground = callback;
            fixture.listenerCount++;
            return () => { if (fixture.foreground === callback) { fixture.foreground = null; fixture.listenerCount--; } };
          };
          export const onRegistered = (_, callback) => {
            fixture.registered = callback;
            return () => { if (fixture.registered === callback) fixture.registered = null; };
          };
          export const register = () => fixture.register();
          export const unregister = () => fixture.unregister();
        ` : `
          export const fetchNotificationConfig = async () => ({});
          export const registerPushDevice = (_, input) => fixture.backend(input);
          export const unregisterPushDevice = () => fixture.remove();
          export const sendTestNotification = async () => ({ queued: true, eventId: "test" });
        `,
        loader: "js"
      }));
    }
  }]
}).then(result => result.outputFiles[0].text);

async function setup() {
  const storage = new Map<string, string>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const backendStarted = deferred<void>();
  const supportStarted = deferred<void>();
  const sdkStarted = deferred<void>();
  const fixture = {
    permission: "granted",
    permissionCalls: 0,
    backendCalls: 0,
    sdkCalls: 0,
    listenerCount: 0,
    registered: null as null | ((fid: string) => void),
    foreground: null as null | ((payload: unknown) => void),
    support: async () => { supportStarted.resolve(); return true; },
    register: async () => {
      fixture.sdkCalls++;
      sdkStarted.resolve();
      fixture.registered?.("c123456789012345678901");
    },
    unregister: async () => {},
    backend: async (_input: unknown) => { fixture.backendCalls++; backendStarted.resolve(); },
    remove: async () => {}
  };
  const notification = {
    get permission() { return fixture.permission; },
    requestPermission: async () => { fixture.permissionCalls++; fixture.permission = "granted"; return "granted"; }
  };
  const serviceWorker = { register: async () => ({}), ready: Promise.resolve({}) };
  const context = vm.createContext({
    fixture,
    window: { isSecureContext: true, PushManager: {}, Notification: notification },
    navigator: { serviceWorker },
    Notification: notification,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key)
    },
    crypto: { randomUUID: () => "5892262b-3cc5-4d7d-88a8-5eaefba3bf85" },
    AbortController,
    DOMException,
    setTimeout: (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id)
  });
  vm.runInContext(await bundle, context);
  const push = context.pushModule as typeof import("../../web/src/lib/push.ts");
  return { push, fixture, storage, timers, notification, serviceWorker, backendStarted, supportStarted, sdkStarted };
}

test("F3.3: logout while backend registration is pending cannot restore consent or registered", async () => {
  const f = await setup();
  const backend = deferred<void>();
  f.fixture.backend = async () => { f.fixture.backendCalls++; f.backendStarted.resolve(); await backend.promise; };
  const result = f.push.registerPushNotification(config, () => {});
  await f.backendStarted.promise;
  f.push.clearPushConsent();
  f.push.cleanupPushListeners();
  backend.resolve();
  assert.equal((await result).state, "unregistered");
  assert.equal(f.storage.has("web_cli_push_consent"), false);
  assert.equal(f.fixture.listenerCount, 0);
  assert.equal(f.fixture.registered, null);
  assert.equal(f.timers.size, 0);
});

test("F3.3: logout while support check is pending cancels before permission or SDK side effects", async () => {
  const f = await setup();
  const support = deferred<boolean>();
  f.fixture.support = async () => { f.supportStarted.resolve(); return support.promise; };
  const result = f.push.registerPushNotification(config, () => {});
  await f.supportStarted.promise;
  f.push.cleanupPushListeners();
  support.resolve(true);
  assert.equal((await result).state, "unregistered");
  assert.equal(f.fixture.permissionCalls, 0);
  assert.equal(f.fixture.sdkCalls, 0);
  assert.equal(f.fixture.backendCalls, 0);
  assert.equal(f.fixture.listenerCount, 0);
});

test("F3.1: silent refresh waits for backend success before attaching foreground listener", async () => {
  const f = await setup();
  f.storage.set("web_cli_push_consent", "true");
  const backend = deferred<void>();
  let attentionCount = 0;
  f.fixture.backend = async () => { f.fixture.backendCalls++; f.backendStarted.resolve(); await backend.promise; };
  const result = f.push.refreshPushRegistration(config, () => { attentionCount++; });
  await f.backendStarted.promise;
  assert.equal(f.fixture.listenerCount, 0, "pending backend registration is not foreground-ready");
  assert.equal(f.fixture.permissionCalls, 0);
  backend.resolve();
  assert.equal((await result).state, "registered");
  assert.equal(f.fixture.backendCalls, 1);
  assert.equal(f.fixture.listenerCount, 1);
  assert.equal(f.fixture.registered, null, "FID listener is released after registration");
  assert.equal(f.timers.size, 0);
  const oldCallback = f.fixture.foreground!;
  oldCallback({ data: { type: "attention", sessionId: "s1", eventId: "e1" } });
  assert.equal(attentionCount, 1);
  f.push.cleanupPushListeners();
  oldCallback({ data: { type: "attention", sessionId: "s1", eventId: "e2" } });
  assert.equal(attentionCount, 1, "queued callback cannot notify after logout");
});

test("F3.4: failed backend refresh does not attach listeners or treat consent as registration", async () => {
  const f = await setup();
  f.storage.set("web_cli_push_consent", "true");
  f.fixture.backend = async () => { throw new Error("backend unavailable"); };
  assert.equal((await f.push.refreshPushRegistration(config, () => {})).state, "register_error");
  assert.equal(f.fixture.listenerCount, 0);
  assert.equal(f.fixture.registered, null);
  assert.equal(f.timers.size, 0);
  assert.equal(f.fixture.permissionCalls, 0);
});

test("F3.5: explicit enable requests permission and stores consent only after successful backend registration", async () => {
  const f = await setup();
  f.fixture.permission = "default";
  const backend = deferred<void>();
  f.fixture.backend = async () => { f.backendStarted.resolve(); await backend.promise; };
  const result = f.push.registerPushNotification(config, () => {});
  await f.backendStarted.promise;
  assert.equal(f.fixture.permissionCalls, 1);
  assert.equal(f.storage.has("web_cli_push_consent"), false);
  backend.resolve();
  assert.equal((await result).state, "registered");
  assert.equal(f.storage.get("web_cli_push_consent"), "true");
});

test("F3: silent refresh never enters Firebase when permission changes during worker readiness", async () => {
  const f = await setup();
  f.storage.set("web_cli_push_consent", "true");
  const ready = deferred<{}>();
  const workerStarted = deferred<void>();
  f.serviceWorker.register = async () => { workerStarted.resolve(); return {}; };
  f.serviceWorker.ready = ready.promise;
  const result = f.push.refreshPushRegistration(config, () => {});
  await workerStarted.promise;
  f.fixture.permission = "default";
  ready.resolve({});
  assert.equal((await result).state, "unregistered");
  assert.equal(f.fixture.sdkCalls, 0);
  assert.equal(f.fixture.permissionCalls, 0);
  assert.equal(f.fixture.backendCalls, 0);
});

test("F3: cancellation settles even if the permission prompt never resolves", async () => {
  const f = await setup();
  const permission = deferred<string>();
  const requested = deferred<void>();
  f.notification.requestPermission = async () => { requested.resolve(); return permission.promise; };
  const result = f.push.registerPushNotification(config);
  await requested.promise;
  f.push.cleanupPushListeners();
  assert.equal((await result).state, "unregistered");
  permission.resolve("granted");
  assert.equal(f.fixture.sdkCalls, 0);
  assert.equal(f.timers.size, 0);
});

test("F3: SDK failure releases FID listener and deadline without unhandled timeout rejection", async () => {
  const f = await setup();
  f.fixture.register = async () => { throw new Error("SDK failed"); };
  assert.equal((await f.push.registerPushNotification(config)).state, "register_error");
  assert.equal(f.fixture.registered, null);
  assert.equal(f.timers.size, 0);
  assert.equal(f.fixture.backendCalls, 0);
});

test("F3: bounded SDK/FID wait releases resources and safely observes late SDK rejection", async () => {
  const f = await setup();
  const sdk = deferred<void>();
  f.fixture.register = async () => { f.sdkStarted.resolve(); await sdk.promise; };
  const result = f.push.registerPushNotification(config);
  await f.sdkStarted.promise;
  for (const callback of [...f.timers.values()]) callback();
  assert.equal((await result).state, "register_error");
  assert.equal(f.fixture.registered, null);
  assert.equal(f.timers.size, 0);
  sdk.reject(new Error("late SDK rejection"));
  await Promise.resolve();
});

test("F3: stale cleanup cannot remove the newer registration listener", async () => {
  const f = await setup();
  const originalRegister = f.fixture.register;
  const oldSdk = deferred<void>();
  f.fixture.register = async () => { f.sdkStarted.resolve(); await oldSdk.promise; };
  const oldResult = f.push.registerPushNotification(config, () => {});
  await f.sdkStarted.promise;
  f.push.cleanupPushListeners();
  f.fixture.register = originalRegister;
  const newResult = f.push.registerPushNotification(config, () => {});
  assert.equal((await oldResult).state, "unregistered");
  assert.equal((await newResult).state, "registered");
  oldSdk.resolve();
  await Promise.resolve();
  assert.equal(f.fixture.listenerCount, 1);
  assert.equal(f.storage.get("web_cli_push_consent"), "true");
});

test("F3: stale disable completion cannot erase consent from a new authentication generation", async () => {
  const f = await setup();
  f.storage.set("web_cli_push_consent", "true");
  const removed = deferred<void>();
  const removeStarted = deferred<void>();
  f.fixture.remove = async () => { removeStarted.resolve(); await removed.promise; };
  const oldResult = f.push.unregisterPushNotification(config);
  await removeStarted.promise;
  f.push.cleanupPushListeners();
  assert.equal((await f.push.refreshPushRegistration(config, () => {})).state, "registered");
  removed.resolve();
  await oldResult;
  assert.equal(f.storage.get("web_cli_push_consent"), "true");
  assert.equal(f.fixture.listenerCount, 1);
});

test("F3: silent refresh respects configuration, support, consent, and permission without prompting", async () => {
  for (const scenario of ["disabled", "unsupported", "no-consent", "default", "denied"] as const) {
    const f = await setup();
    f.storage.set("web_cli_push_consent", "true");
    if (scenario === "unsupported") f.fixture.support = async () => false;
    if (scenario === "no-consent") f.storage.clear();
    if (scenario === "default" || scenario === "denied") f.fixture.permission = scenario;
    const result = await f.push.refreshPushRegistration(scenario === "disabled" ? { enabled: false, supportedAgents: [] } : config);
    const expected = { disabled: "unconfigured", unsupported: "unsupported", "no-consent": "unregistered", default: "unregistered", denied: "permission_denied" };
    assert.equal(result.state, expected[scenario], scenario);
    assert.equal(f.fixture.sdkCalls, 0, scenario);
    assert.equal(f.fixture.permissionCalls, 0, scenario);
    assert.equal(f.timers.size, 0, scenario);
  }
});
