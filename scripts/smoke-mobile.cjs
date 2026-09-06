const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { TOTP, Secret } = require('otpauth');
const WebSocket = require('ws');
const ROOT = path.resolve(__dirname, '../..');
const puppeteer = require(path.join(ROOT, 'clone-truyen/node_modules/puppeteer'));
const express = require(path.join(ROOT, 'api-server/node_modules/express'));
const { createWebCliProxy } = require(path.join(ROOT, 'api-server/src/web-cli-proxy'));

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-cli-mobile-test-'));
  const port = await freePort();
  let output = '';
  const child = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: path.join(ROOT, 'web-cli'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), WEB_CLI_AUTH_DIR: path.join(dir, 'auth'), WEB_CLI_ENV_FILE: path.join(dir, 'no-env'), CLIENT_ORIGIN: '', ALLOWED_PROJECT_DIRS: dir, AGENTS_CONFIG_JSON: JSON.stringify([{ id: 'audit', label: 'Kiểm thử shell', command: '/bin/sh', args: ['-i'] }]) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (data) => { output = (output + data).slice(-6000); });
  child.stderr.on('data', (data) => { output = (output + data).slice(-6000); });
  let browser, gateway, proxy;
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; } } catch {}
      if (child.exitCode !== null) throw new Error('Test backend stopped: ' + output);
      await pause(100);
    }
    assert.ok(ready, 'isolated backend starts');
    proxy = createWebCliProxy({ port });
    const app = express(); app.set('trust proxy', 'loopback'); app.use(proxy.handle);
    gateway = app.listen(0, '127.0.0.1'); await once(gateway, 'listening'); gateway.on('upgrade', proxy.upgrade);
    const base = `http://127.0.0.1:${gateway.address().port}`;
    assert.equal((await fetch(base + '/api/web-cli/api/sessions')).status, 401);
    assert.equal((await fetch(base + '/api/web-cli/api/sessions', { headers: { authorization: 'Bearer legacy' } })).status, 401);
    browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await page.goto(base + '/api/web-cli/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name=username]');
    const setupCode = fs.readFileSync(path.join(dir, 'auth/setup-code.txt'), 'utf8').trim();
    await page.type('input[autocomplete=off]', setupCode);
    await page.type('input[name=username]', 'mobile-owner');
    await page.type('input[name=password]', 'mobile-audit-password-2026');
    const setupResponse = page.waitForResponse((response) => response.url().endsWith('/api/auth/setup') && response.request().method() === 'POST');
    await page.click('button.primary');
    const enrollment = await (await setupResponse).json();
    assert.ok(enrollment.secret, 'setup returns enrollment only after owner code');
    await page.waitForSelector('input[name=code]');
    const code = new TOTP({ secret: Secret.fromBase32(enrollment.secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate();
    await page.type('input[name=code]', code);
    await page.click('button.primary');
    await page.waitForFunction(() => document.body.textContent.includes('Đã lưu, mở terminal'));
    await page.$$eval('button', (buttons) => buttons.find((button) => button.textContent === 'Đã lưu, mở terminal').click());
    await page.waitForSelector('dialog[open]');
    await page.$$eval('[role=tab]', (buttons) => buttons.find((button) => button.textContent === 'Kiểm thử shell').click());
    await page.$$eval('button', (buttons) => buttons.find((button) => button.textContent === 'Tạo phiên mới').click());
    await page.waitForFunction(() => !document.querySelector('#command-input')?.disabled);
    const sessionId = await page.$eval('select[aria-label="Chuyển phiên terminal"]', (select) => select.value);
    assert.ok(sessionId);
    const geometry = [];
    for (const [width, height] of [[360, 800], [390, 844], [430, 932], [844, 390], [390, 400]]) {
      await page.setViewport({ width, height, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }); await pause(150);
      const result = await page.evaluate(() => {
        const input = document.querySelector('#command-input').getBoundingClientRect();
        const terminal = document.querySelector('.terminal-pane').getBoundingClientRect();
        const header = document.querySelector('.controller-header').getBoundingClientRect();
        return { width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth, inputBottom: Math.round(input.bottom), terminalHeight: Math.round(terminal.height), panelButtonVisible: header.height > 0 };
      });
      assert.ok(result.inputBottom <= height, JSON.stringify(result));
      assert.ok(result.terminalHeight > 70, JSON.stringify(result));
      assert.ok(result.pageWidth <= width, JSON.stringify(result));
      assert.ok(result.panelButtonVisible); geometry.push(result);
    }
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const wsSession = await page.createCDPSession(); await wsSession.send('Network.enable');
    const sent = []; wsSession.on('Network.webSocketFrameSent', (event) => { try { sent.push(JSON.parse(event.response.payloadData)); } catch {} });
    await page.type('#command-input', "printf 'MOBILE_AUDIT_OK\\n'"); await page.click('button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent.includes('MOBILE_AUDIT_OK'));
    await page.type('#command-input', 'pri');
    await page.$$eval('.shortcut-row button', (buttons) => buttons.find((button) => button.textContent === 'Tab').click());
    await pause(100); assert.ok(sent.some((message) => message.type === 'input' && message.data === 'pri\t'), 'Tab flushes draft first');
    await page.$$eval('.shortcut-row button', (buttons) => buttons.find((button) => button.textContent === 'Ctrl+C').click());
    await page.type('#command-input', "seq 1 400; printf 'SCROLL_READY\\n'"); await page.click('button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent.includes('SCROLL_READY'));
    await page.$eval('#command-input', (element) => element.blur());
    await pause(150);
    const scrollTop = () => page.$eval('.xterm-viewport', (element) => element.scrollTop);
    const touchPoint = await page.$eval('.terminal-pane', (element) => {
      const rect = element.getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + 100) };
    });
    const touchEvent = (type, y = touchPoint.y) => wsSession.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x: touchPoint.x, y, id: 1 }]
    });
    const swipe = async () => {
      await touchEvent('touchStart');
      for (let step = 1; step <= 8; step++) { await touchEvent('touchMove', touchPoint.y + step * 20); await pause(16); }
      await touchEvent('touchEnd');
    };
    const beforeSwipe = await scrollTop();
    const sentBeforeSwipe = sent.length;
    await swipe();
    const releasedAt = await scrollTop(); await pause(180);
    const coastedTo = await scrollTop();
    assert.ok(releasedAt < beforeSwipe - 80, 'touch swipe scrolls history');
    assert.ok(coastedTo < releasedAt - 20, 'touch scrolling coasts after release');
    assert.ok(!sent.slice(sentBeforeSwipe).some((message) => ['resize', 'input'].includes(message.type)), 'swipe does not resize the PTY or send input');
    assert.ok(await page.evaluate(() => document.activeElement?.tagName !== 'TEXTAREA'), 'swipe does not focus the keyboard');
    await touchEvent('touchStart'); await pause(40);
    const interruptedAt = await scrollTop(); await pause(180);
    assert.equal(await scrollTop(), interruptedAt, 'new touch stops momentum');
    await touchEvent('touchCancel');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await swipe(); await pause(40);
    const reducedAt = await scrollTop(); await pause(180);
    assert.equal(await scrollTop(), reducedAt, 'reduced motion disables momentum');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await swipe();
    await page.click('[aria-label="Cuộn xuống cuối terminal"]'); await pause(80);
    const bottomAt = await scrollTop(); await pause(200);
    assert.equal(await scrollTop(), bottomAt, 'bottom button cancels momentum');
    assert.ok(bottomAt > beforeSwipe - 30, 'bottom button reaches the latest output');
    // Reload must restore the same existing PTY, without spawning another process.
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !document.querySelector('#command-input')?.disabled);
    assert.equal(await page.$eval('select[aria-label="Chuyển phiên terminal"]', (select) => select.value), sessionId);
    // Close the transport without killing the PTY; the browser must obtain a fresh ticket and reconnect.
    proxy.close();
    await page.waitForFunction(() => document.querySelector('#command-input')?.disabled, { timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector('#command-input')?.disabled, { timeout: 20000 });
    assert.equal(await page.$eval('select[aria-label="Chuyển phiên terminal"]', (select) => select.value), sessionId);
    const screenshot = '/tmp/web-cli-mobile-after.png'; await page.screenshot({ path: screenshot });
    const ticket = await page.evaluate(async (id) => (await (await fetch(`/api/web-cli/api/sessions/${id}/ws-ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).ticket, sessionId);
    const cookie = (await page.cookies()).find((item) => item.name === 'web_cli_session');
    const socketUrl = `${base.replace('http:', 'ws:')}/api/web-cli/api/sessions/${sessionId}/ws`;
    const extraSocket = new WebSocket(socketUrl, ['web-cli', `ticket.${ticket}`], { headers: { Origin: base, Cookie: `${cookie.name}=${cookie.value}` } });
    await once(extraSocket, 'open');
    let sizeCheck = 0;
    const readPtySize = () => new Promise((resolve, reject) => {
      const marker = `SIZE_CHECK_${++sizeCheck}:`;
      let received = '';
      const cleanup = () => { clearTimeout(timeout); extraSocket.off('message', onMessage); };
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== 'output') return;
        received += message.data;
        const match = received.match(new RegExp(`${marker}(\\d+) (\\d+)`));
        if (match) { cleanup(); resolve({ rows: Number(match[1]), cols: Number(match[2]) }); }
      };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('PTY size probe timed out')); }, 5000);
      extraSocket.on('message', onMessage);
      extraSocket.send(JSON.stringify({ type: 'input', data: `printf '${marker}'; stty size\r` }));
    });
    const mobileSize = await readPtySize();
    assert.ok(mobileSize.cols < 60, JSON.stringify(mobileSize));
    const desktop = await browser.newPage();
    desktop.on('pageerror', (error) => errors.push(error.message));
    await desktop.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await desktop.goto(base + '/api/web-cli/', { waitUntil: 'networkidle0' });
    await desktop.waitForFunction(() => !document.querySelector('#command-input')?.disabled);
    assert.equal(await desktop.$eval('select[aria-label="Chuyển phiên terminal"]', (select) => select.value), sessionId);
    const desktopSize = await readPtySize();
    assert.ok(desktopSize.cols > 200 && desktopSize.cols > mobileSize.cols * 3, JSON.stringify(desktopSize));
    assert.ok(await desktop.$eval('.terminal-pane', (element) => element.clientWidth > 1800), 'desktop uses the available width');
    const desktopScrollBefore = await desktop.$eval('.xterm-viewport', (element) => element.scrollTop);
    await desktop.mouse.move(500, 400); await desktop.mouse.wheel({ deltaY: -300 }); await pause(150);
    assert.ok(await desktop.$eval('.xterm-viewport', (element) => element.scrollTop) < desktopScrollBefore - 200, 'desktop mouse wheel still scrolls normally');
    await page.bringToFront(); await pause(200);
    assert.deepEqual(await readPtySize(), mobileSize, 'returning to mobile restores mobile dimensions');
    await desktop.bringToFront(); await pause(200);
    assert.deepEqual(await readPtySize(), desktopSize, 'returning to desktop restores desktop dimensions without a viewport change');
    await page.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }); await pause(200);
    assert.deepEqual(await readPtySize(), desktopSize, 'hidden mobile resize does not shrink the active desktop');
    await desktop.setViewport({ width: 3440, height: 3200, deviceScaleFactor: 1 }); await pause(200);
    assert.deepEqual(await readPtySize(), { cols: 300, rows: 120 }, 'large displays stay within the server resize limits');
    assert.equal(await desktop.$('[role=alert]'), null, 'large display does not cause a protocol error');
    await desktop.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 }); await pause(200);
    assert.deepEqual(await readPtySize(), desktopSize, 'shrinking the desktop resizes the PTY');
    await desktop.screenshot({ path: '/tmp/web-cli-desktop-after.png' });
    await desktop.close();
    await page.bringToFront();
    const socketClosed = once(extraSocket, 'close');
    await page.$$eval('button', (buttons) => buttons.find((button) => button.textContent === 'Phiên & dự án').click());
    await page.waitForSelector('dialog[open]');
    await page.$$eval('button', (buttons) => buttons.find((button) => button.textContent.startsWith('Đăng xuất ·')).click());
    await page.waitForSelector('input[name=password]');
    extraSocket.send(JSON.stringify({ type: 'input', data: 'printf SHOULD_NOT_EXECUTE\\n\r' }));
    const [closeCode] = await socketClosed;
    assert.equal(closeCode, 4001, 'server revokes already-open sockets on logout');
    assert.equal((await page.evaluate(async () => (await fetch('/api/web-cli/api/sessions')).status)), 401);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, checks: ['owner-only enrollment', 'password + TOTP', 'real terminal through gateway', '5 mobile viewport sizes', 'draft + Tab', 'touch scroll momentum and interruption', 'swipe without PTY resize or keyboard focus', 'reduced motion', 'bottom button cancels momentum', 'desktop mouse wheel', 'reload restores PTY', 'transport reconnect', 'shared PTY mobile/desktop switching', 'hidden mobile resize', 'desktop full width', 'large display resize limits', 'logout revokes open socket'], touchScroll: { beforeSwipe, releasedAt, coastedTo }, geometry, mobileSize, desktopSize, screenshot, desktopScreenshot: '/tmp/web-cli-desktop-after.png' }, null, 2));
  } finally {
    if (browser) await browser.close();
    proxy?.close();
    if (gateway) await new Promise((resolve) => gateway.close(resolve));
    const exited = child.exitCode === null ? once(child, 'exit') : Promise.resolve(); child.kill('SIGTERM'); await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
