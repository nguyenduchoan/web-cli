const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { TOTP, Secret } = require("otpauth");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const { resolvePuppeteer, resolveChromePath } = require("./smoke-utils.cjs");
const puppeteer = resolvePuppeteer();

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function createLocalProxy(targetPort) {
  const activeSockets = new Set();

  const server = http.createServer((req, res) => {
    const proxyReq = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: req.headers
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(proxyReq);
  });

  server.on("upgrade", (req, clientSocket, head) => {
    activeSockets.add(clientSocket);
    const proxySocket = net.connect(targetPort, "127.0.0.1", () => {
      activeSockets.add(proxySocket);
      proxySocket.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        proxySocket.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      }
      proxySocket.write("\r\n");
      if (head && head.length) proxySocket.write(head);
      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);
    });

    const cleanup = () => {
      activeSockets.delete(clientSocket);
      activeSockets.delete(proxySocket);
      clientSocket.destroy();
      proxySocket.destroy();
    };

    proxySocket.on("error", cleanup);
    clientSocket.on("error", cleanup);
    proxySocket.on("close", cleanup);
    clientSocket.on("close", cleanup);
  });

  return {
    server,
    closeTransport: () => {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
    }
  };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-cli-mobile-test-"));
  const backendPort = await freePort();
  let output = "";

  const child = spawn(process.execPath, ["server/dist/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(backendPort),
      WEB_CLI_AUTH_DIR: path.join(dir, "auth"),
      WEB_CLI_ENV_FILE: path.join(dir, "no-env"),
      CLIENT_ORIGIN: "",
      ALLOWED_PROJECT_DIRS: dir,
      AGENTS_CONFIG_JSON: JSON.stringify([
        { id: "shell", label: "Shell", command: "/bin/sh", args: ["-i"] },
        { id: "audit", label: "Kiểm thử shell", command: "/bin/sh", args: ["-i"] }
      ])
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (data) => {
    output = (output + data).slice(-6000);
  });
  child.stderr.on("data", (data) => {
    output = (output + data).slice(-6000);
  });

  let browser, proxyWrapper, proxyPort;

  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${backendPort}/api/health`)).ok) {
          ready = true;
          break;
        }
      } catch {}
      if (child.exitCode !== null) throw new Error("Test backend stopped: " + output);
      await pause(100);
    }
    assert.ok(ready, "Isolated backend started");

    proxyPort = await freePort();
    proxyWrapper = createLocalProxy(backendPort);
    proxyWrapper.server.listen(proxyPort, "127.0.0.1");
    await once(proxyWrapper.server, "listening");

    const base = `http://127.0.0.1:${proxyPort}`;
    assert.equal((await fetch(base + "/api/web-cli/api/sessions")).status, 401);

    browser = await puppeteer.launch({
      executablePath: resolveChromePath() || process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"]
    });

    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1
    });

    await page.goto(base + "/api/web-cli/", { waitUntil: "networkidle0" });
    await page.waitForSelector("input[name=username]");

    const setupCode = fs.readFileSync(path.join(dir, "auth/setup-code.txt"), "utf8").trim();
    await page.type("input[autocomplete=off]", setupCode);
    await page.type("input[name=username]", "mobile-owner");
    await page.type("input[name=password]", "mobile-audit-password-2026");

    const setupResponsePromise = page.waitForResponse(
      (response) => response.url().includes("/api/auth/setup") && response.request().method() === "POST"
    );
    await page.click("button.primary");
    const setupRes = await setupResponsePromise;
    const enrollment = await setupRes.json();
    if (!enrollment.secret) {
      console.error("Setup response error:", setupRes.status(), enrollment);
    }
    assert.ok(enrollment.secret, "Setup returns enrollment secret");

    await page.waitForSelector("input[name=code]");
    const code = new TOTP({
      secret: Secret.fromBase32(enrollment.secret),
      algorithm: "SHA1",
      digits: 6,
      period: 30
    }).generate();

    await page.type("input[name=code]", code);
    await page.click("button.primary");

    await page.waitForFunction(() => document.body.textContent.includes("Đã lưu, mở terminal"));
    await page.$$eval("button", (buttons) =>
      buttons.find((b) => b.textContent.includes("Đã lưu, mở terminal"))?.click()
    );

    // In Phase 4 UI: mobile sheet opens
    await page.waitForSelector("dialog[open]");
    await page.$$eval("button", (buttons) => {
      const btn = buttons.find(
        (b) => b.textContent.includes("Tạo phiên đầu tiên") || b.textContent.includes("+ Phiên mới")
      );
      btn?.click();
    });

    await page.waitForSelector(".new-session-dialog[open]");
    await page.$$eval(".new-session-dialog button[type=submit]", (buttons) => {
      buttons[0]?.click();
    });

    await page.waitForFunction(() => !document.querySelector("#command-input")?.disabled, {
      timeout: 15000
    });
    const sessionId = await page.$eval(
      'select[aria-label="Chuyển phiên terminal"]',
      (select) => select.value
    );
    const debugState = await page.evaluate(() => {
      const select = document.querySelector('select[aria-label="Chuyển phiên terminal"]');
      const status = document.querySelector('.controller-header p[role=status]')?.textContent;
      return { selectVal: select?.value, status };
    });
    console.log("Debug state after create:", debugState);
    assert.ok(sessionId, "Session created successfully");

    // Geometry checks across 5 viewport sizes
    const geometry = [];
    for (const [width, height] of [
      [360, 800],
      [390, 844],
      [430, 932],
      [844, 390],
      [390, 400]
    ]) {
      await page.setViewport({ width, height, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      await pause(150);
      const result = await page.evaluate(() => {
        const input = document.querySelector("#command-input").getBoundingClientRect();
        const terminal = document.querySelector(".terminal-pane").getBoundingClientRect();
        const header = document.querySelector(".controller-header").getBoundingClientRect();
        return {
          width: innerWidth,
          height: innerHeight,
          pageWidth: document.documentElement.scrollWidth,
          inputBottom: Math.round(input.bottom),
          terminalHeight: Math.round(terminal.height),
          headerVisible: header.height > 0
        };
      });
      assert.ok(result.inputBottom <= height + 2, JSON.stringify(result));
      assert.ok(result.terminalHeight > 50, JSON.stringify(result));
      assert.ok(result.pageWidth <= width, JSON.stringify(result));
      assert.ok(result.headerVisible);
      geometry.push(result);
    }

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await page.waitForFunction(() => !document.querySelector("#command-input")?.disabled, {
      timeout: 15000
    });

    const wsSession = await page.createCDPSession();
    await wsSession.send("Network.enable");
    const sent = [];
    wsSession.on("Network.webSocketFrameSent", (event) => {
      try {
        sent.push(JSON.parse(event.response.payloadData));
      } catch {}
    });

    await page.focus("#command-input");
    await page.type("#command-input", "printf 'MOBILE_AUDIT_OK\\n'");
    await page.click(".composer button[type=submit]");
    await page.waitForFunction(
      () => document.querySelector(".xterm-screen")?.textContent.includes("MOBILE_AUDIT_OK"),
      { timeout: 10000 }
    );

    await page.type("#command-input", "pri");
    await page.$$eval(".shortcut-row button", (buttons) =>
      buttons.find((b) => b.textContent === "Tab")?.click()
    );
    await pause(100);
    assert.ok(
      sent.some((message) => message.type === "input" && message.data === "pri\t"),
      "Tab flushes draft first"
    );

    await page.$$eval(".shortcut-row button", (buttons) =>
      buttons.find((b) => b.textContent === "Ctrl+C")?.click()
    );
    await page.waitForFunction(() => !document.querySelector("#command-input")?.disabled, {
      timeout: 10000
    });

    await page.type("#command-input", "seq 1 400; printf 'SCROLL_READY\\n'");
    await page.click(".composer button[type=submit]");
    await page.waitForFunction(
      () => document.querySelector(".xterm-screen")?.textContent.includes("SCROLL_READY"),
      { timeout: 10000 }
    );
    await page.$eval("#command-input", (el) => el.blur());
    await pause(150);

    const scrollTop = () => page.$eval(".xterm-viewport", (el) => el.scrollTop);
    const touchPoint = await page.$eval(".terminal-pane", (el) => {
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + 100) };
    });

    const touchEvent = (type, y = touchPoint.y) =>
      wsSession.send("Input.dispatchTouchEvent", {
        type,
        touchPoints:
          type === "touchEnd" || type === "touchCancel" ? [] : [{ x: touchPoint.x, y, id: 1 }]
      });

    const swipe = async () => {
      await touchEvent("touchStart");
      for (let step = 1; step <= 8; step++) {
        await touchEvent("touchMove", touchPoint.y + step * 20);
        await pause(16);
      }
      await touchEvent("touchEnd");
    };

    const beforeSwipe = await scrollTop();
    const sentBeforeSwipe = sent.length;
    await swipe();
    const releasedAt = await scrollTop();
    await pause(180);
    const coastedTo = await scrollTop();
    assert.ok(releasedAt < beforeSwipe - 50, "Touch swipe scrolls history");
    assert.ok(coastedTo <= releasedAt, "Touch scrolling coasts or stays scrolled after release");
    assert.ok(
      !sent.slice(sentBeforeSwipe).some((m) => ["resize", "input"].includes(m.type)),
      "Swipe does not resize PTY or send input"
    );

    // Bottom button
    await page.click('[aria-label="Cuộn xuống cuối terminal"]');
    await pause(150);
    const bottomAt = await scrollTop();
    assert.ok(bottomAt >= beforeSwipe - 10, "Bottom button returns near bottom");

    // Reload test
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(() => !document.querySelector("#command-input")?.disabled, {
      timeout: 10000
    });
    assert.equal(
      await page.$eval('select[aria-label="Chuyển phiên terminal"]', (s) => s.value),
      sessionId,
      "Reload restores session"
    );

    // Transport break and reconnect
    proxyWrapper.closeTransport();
    await page.waitForFunction(() => document.querySelector("#command-input")?.disabled, {
      timeout: 5000
    });
    await page.waitForFunction(() => !document.querySelector("#command-input")?.disabled, {
      timeout: 20000
    });
    assert.equal(
      await page.$eval('select[aria-label="Chuyển phiên terminal"]', (s) => s.value),
      sessionId,
      "Session reconnected"
    );

    // Phase 4 - Mobile Modal Lifecycle tests (M1, M2, M3, M4)
    const checkDialogCount = async () => {
      const count = await page.evaluate(() => document.querySelectorAll("dialog[open]").length);
      assert.ok(count <= 1, `Expected <= 1 open dialog at all times, got ${count}`);
      return count;
    };

    // M1: Open mobile sheet -> click "+ Phiên mới" -> verify no stacked dialogs
    await page.click('[aria-label="Mở danh sách phiên"]');
    await page.waitForSelector("dialog.mobile-session-sheet[open]", { timeout: 5000 });
    await checkDialogCount();

    await page.click('dialog.mobile-session-sheet [aria-label="Tạo phiên mới"]');
    await page.waitForSelector("dialog.new-session-dialog[open]", { timeout: 5000 });
    const countM1 = await checkDialogCount();
    assert.equal(countM1, 1, "Exactly one dialog open after opening New Session from mobile sheet");

    // M3: Cancel New Session -> no stacked dialog, focus valid
    await page.evaluate(() => {
      const dialog = document.querySelector("dialog.new-session-dialog");
      const cancelBtn = Array.from(dialog?.querySelectorAll("button") || []).find((b) => b.textContent.trim() === "Hủy");
      if (cancelBtn) cancelBtn.click();
    });
    await page.waitForFunction(() => document.querySelectorAll("dialog[open]").length === 0, { timeout: 5000 });
    const countAfterCancel = await checkDialogCount();
    assert.equal(countAfterCancel, 0, "All dialogs closed after cancel");
    const activeTagName = await page.evaluate(() => document.activeElement?.tagName);
    assert.ok(activeTagName, "Focus remains valid after cancel");

    // M2: Open mobile sheet -> click "+ Ở đây" -> verify no stacked dialogs
    await page.click('[aria-label="Mở danh sách phiên"]');
    await page.waitForSelector("dialog.mobile-session-sheet[open]", { timeout: 5000 });
    await checkDialogCount();

    const clickedAtFolder = await page.evaluate(() => {
      const sheet = document.querySelector("dialog.mobile-session-sheet");
      const atFolderBtn = Array.from(sheet?.querySelectorAll("button") || []).find((b) => b.textContent.includes("+ Ở đây"));
      if (atFolderBtn) {
        atFolderBtn.click();
        return true;
      }
      return false;
    });
    if (clickedAtFolder) {
      await page.waitForSelector("dialog.new-session-dialog[open]", { timeout: 5000 });
      const countM2 = await checkDialogCount();
      assert.equal(countM2, 1, "Exactly one dialog open after + Ở đây");
      // Close new session dialog
      await page.evaluate(() => {
        const dialog = document.querySelector("dialog.new-session-dialog");
        const cancelBtn = Array.from(dialog?.querySelectorAll("button") || []).find((b) => b.textContent.trim() === "Hủy");
        if (cancelBtn) cancelBtn.click();
      });
      await page.waitForFunction(() => document.querySelectorAll("dialog[open]").length === 0, { timeout: 5000 });
    }

    // M4: Repeated modal open/close loop (20 cycles) without InvalidStateError or pageerror
    for (let cycle = 0; cycle < 20; cycle++) {
      await page.click('[aria-label="Mở danh sách phiên"]');
      await page.waitForSelector("dialog.mobile-session-sheet[open]", { timeout: 3000 });
      await checkDialogCount();

      // Click + Phiên mới
      await page.click('dialog.mobile-session-sheet [aria-label="Tạo phiên mới"]');
      await page.waitForSelector("dialog.new-session-dialog[open]", { timeout: 3000 });
      await checkDialogCount();

      // Close New Session dialog
      await page.evaluate(() => {
        const dialog = document.querySelector("dialog.new-session-dialog");
        const closeBtn = dialog?.querySelector('[aria-label="Đóng dialog tạo phiên mới"]') ||
          Array.from(dialog?.querySelectorAll("button") || []).find((b) => b.textContent.trim() === "Hủy");
        if (closeBtn) closeBtn.click();
      });
      await page.waitForFunction(() => document.querySelectorAll("dialog[open]").length === 0, { timeout: 3000 });
      await checkDialogCount();
    }

    assert.equal(errors.length, 0, `Expected 0 page errors during modal cycles, got: ${errors.join("; ")}`);

    await page.close();

    // Desktop view test
    const desktop = await browser.newPage();
    desktop.on("pageerror", (error) => errors.push(error.message));
    await desktop.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await desktop.goto(base + "/api/web-cli/", { waitUntil: "networkidle0" });
    await desktop.waitForFunction(() => !document.querySelector("#command-input")?.disabled, {
      timeout: 10000
    });

    // Check desktop sidebar is rendered
    const hasDesktopSidebar = await desktop.evaluate(() => {
      const aside = document.querySelector("aside");
      return aside && aside.clientWidth > 200;
    });
    assert.ok(hasDesktopSidebar, "Desktop displays 280px sidebar");

    await desktop.close();

    console.log(
      JSON.stringify(
        {
          passed: true,
          checks: [
            "Owner enrollment & 2FA",
            "5 mobile viewport sizes without overflow",
            "Touch scrolling momentum and bottom jump",
            "Session restore on reload",
            "Transport interruption and automatic reconnection",
            "Desktop sidebar layout >= 1024px"
          ],
          geometry
        },
        null,
        2
      )
    );
  } finally {
    if (browser) await browser.close();
    proxyWrapper?.server?.close();
    child.kill("SIGTERM");
    await pause(300);
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
