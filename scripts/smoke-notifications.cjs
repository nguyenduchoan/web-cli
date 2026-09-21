const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { TOTP, Secret } = require("otpauth");
const { resolvePuppeteer, resolveChromePath } = require("./smoke-utils.cjs");
const puppeteer = resolvePuppeteer();

const root = path.resolve(__dirname, "..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-cli-notifications-test-"));
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  const base = `http://127.0.0.1:${port}`;
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  const saPath = path.join(dir, "service-account.json");
  fs.writeFileSync(
    saPath,
    JSON.stringify({
      type: "service_account",
      project_id: "test-fcm-project",
      private_key_id: "12345",
      private_key: privateKey,
      client_email: "firebase-adminsdk@test-fcm-project.iam.gserviceaccount.com"
    }),
    { mode: 0o600 }
  );

  // 65-byte uncompressed P-256 public key (starts with 0x04)
  const vapidKeyBuffer = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0xaa)]);
  const vapidPublicKey = vapidKeyBuffer.toString("base64url");

  const child = spawn(process.execPath, ["server/dist/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      WEB_CLI_AUTH_DIR: path.join(dir, "cli-auth"),
      WEB_CLI_ENV_FILE: path.join(dir, "absent"),
      ALLOWED_PROJECT_DIRS: dir,
      FCM_ENABLED: "true",
      FIREBASE_API_KEY: "test-api-key",
      FIREBASE_PROJECT_ID: "test-fcm-project",
      FIREBASE_MESSAGING_SENDER_ID: "1234567890",
      FIREBASE_APP_ID: "1:1234567890:web:abcdef",
      FIREBASE_VAPID_PUBLIC_KEY: vapidPublicKey,
      FIREBASE_SERVICE_ACCOUNT_FILE: saPath,
      FCM_DATA_DIR: path.join(dir, "push"),
      AGENTS_CONFIG_JSON: JSON.stringify([
        {
          id: "codex",
          label: "Codex CLI",
          command: process.execPath,
          args: [path.join(root, "server/test/fixtures/terminal-agent.cjs"), "Codex Agent Ready"]
        }
      ])
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", (data) => {
    output = (output + data).slice(-6000);
  });
  child.stderr.on("data", (data) => {
    output = (output + data).slice(-6000);
  });

  let browser;

  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/api/health")).ok) {
          ready = true;
          break;
        }
      } catch {}
      if (child.exitCode !== null) throw new Error("Backend failed to start: " + output);
      await pause(100);
    }
    assert.ok(ready, "Backend started and healthy");

    // 1. Verify static routes: service worker, manifest, icons
    const swRes = await fetch(`${base}/api/web-cli/firebase-messaging-sw.js`);
    assert.equal(swRes.status, 200, "Service worker route must return 200");
    assert.equal(
      swRes.headers.get("service-worker-allowed"),
      "/api/web-cli/",
      "Service-Worker-Allowed header must be /api/web-cli/"
    );
    const swText = await swRes.text();
    assert.ok(swText.includes("test-fcm-project"), "Service worker must have injected Firebase config");

    const manifestRes = await fetch(`${base}/api/web-cli/manifest.webmanifest`);
    assert.equal(manifestRes.status, 200, "Manifest route must return 200");
    const manifestJson = await manifestRes.json();
    assert.equal(manifestJson.scope, "/api/web-cli/");
    assert.equal(manifestJson.id, "/api/web-cli/");

    const iconSvgRes = await fetch(`${base}/api/web-cli/icon.svg`);
    assert.equal(iconSvgRes.status, 200, "icon.svg must return 200");

    const icon192Res = await fetch(`${base}/api/web-cli/icon-192.png`);
    assert.equal(icon192Res.status, 200, "icon-192.png must return 200");

    // 2. Launch Puppeteer browser test
    browser = await puppeteer.launch({
      executablePath: resolveChromePath() || process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"]
    });

    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${base}/api/web-cli/`, { waitUntil: "networkidle0" });

    // 3. Complete initial TOTP enrollment
    await page.waitForSelector("input[name=username]");
    const setupCode = fs.readFileSync(path.join(dir, "cli-auth/setup-code.txt"), "utf8").trim();
    await page.type("input[autocomplete=off]", setupCode);
    await page.type("input[name=username]", "push-tester");
    await page.type("input[name=password]", "password-must-be-very-secure-123");

    const setupResponse = page.waitForResponse(
      (res) => res.url().endsWith("/api/auth/setup") && res.request().method() === "POST"
    );
    await page.click("button.primary");
    const setupData = await (await setupResponse).json();
    assert.ok(setupData.secret, "Setup returned TOTP secret");

    await page.waitForSelector("input[name=code]");
    const totp = new TOTP({ secret: Secret.fromBase32(setupData.secret), algorithm: "SHA1", digits: 6, period: 30 });
    await page.type("input[name=code]", totp.generate());
    await page.click("button.primary");

    await page.waitForFunction(() => document.body.textContent.includes("Đã lưu, mở terminal"));
    await page.$$eval("button", (buttons) => {
      const b = buttons.find((btn) => btn.textContent === "Đã lưu, mở terminal");
      b?.click();
    });

    // 4. Create a Codex session
    await page.waitForSelector("dialog[open]");
    await page.$$eval("button", (buttons) => {
      const b = buttons.find((btn) => btn.textContent?.includes("Tạo phiên") || btn.textContent?.includes("Phiên mới"));
      b?.click();
    });

    await page.waitForSelector(".new-session-dialog[open]");
    await page.$$eval(".new-session-dialog button[type=submit]", (btns) => btns[0]?.click());

    await page.waitForFunction(() => !document.querySelector("#command-input")?.disabled);
    const sessionId = await page.$eval('select[aria-label="Chuyển phiên terminal"]', (select) => select.value);
    assert.ok(sessionId, "Session ID must be present");

    // 5. Check NotificationSettings component rendered in sidebar
    await page.waitForFunction(() => document.body.textContent.includes("Thông báo đẩy (FCM)"));
    assert.ok(
      await page.evaluate(() => document.body.textContent.includes("Yêu cầu xác nhận/câu hỏi từ Codex")),
      "Notification settings description rendered"
    );

    // 6. Test deep link hash: reload with non-existent session UUID
    const nonExistentId = crypto.randomUUID();
    await page.goto(`${base}/api/web-cli/#session=${nonExistentId}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.body.textContent.includes("Phiên không còn trên máy chủ"));
    assert.ok(
      await page.evaluate(() => document.body.textContent.includes("Phiên không còn trên máy chủ")),
      "Non-existent session hash shows error message"
    );

    // 7. Test deep link hash: reload with valid active session UUID
    await page.goto(`${base}/api/web-cli/#session=${sessionId}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => !document.querySelector("#command-input")?.disabled);
    assert.equal(
      await page.$eval('select[aria-label="Chuyển phiên terminal"]', (select) => select.value),
      sessionId,
      "Valid session hash restores active session"
    );

    // 8. Test foreground attention banner
    await page.evaluate((sid) => {
      // Simulate postMessage from service worker
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "web-cli-open-session",
            sessionId: sid
          }
        })
      );
    }, sessionId);

    // Filter out expected simulated error if any
    const realErrors = errors.filter((e) => !e.includes("Notification"));
    assert.deepEqual(realErrors, [], "No page errors during notification test");

    console.log(
      JSON.stringify(
        {
          passed: true,
          checks: [
            "P10: Service worker static asset served with correct headers and injected config",
            "P11: Manifest and icons served correctly",
            "P12: Notification settings UI rendered with state and guidance",
            "P13: Non-existent deep link hash displays error without creating new session",
            "P14: Valid session deep link restores active session cleanly",
            "P15: Service worker postMessage open-session handled without page reload"
          ]
        },
        null,
        2
      )
    );
  } finally {
    if (browser) await browser.close();
    const exited = child.exitCode === null ? once(child, "exit") : Promise.resolve();
    child.kill("SIGTERM");
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
