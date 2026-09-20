const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { TOTP, Secret } = require('otpauth');
const WebSocket = require('ws');
const puppeteer = require(process.env.PUPPETEER_MODULE || '/home/mrhoan/source/clone-truyen/node_modules/puppeteer');
const root = path.resolve(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-hub-browser-'));
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: root, env: { ...process.env, SERVER_HUB_ORIGIN: base, SERVER_HUB_AUTH_DIR: path.join(dir, 'hub'), SERVER_HUB_USERNAME: 'test-owner', WEB_CLI_AUTH_DIR: path.join(dir, 'cli'), WEB_CLI_ENV_FILE: path.join(dir, 'absent'), HOST: '127.0.0.1', PORT: String(port), CLIENT_ORIGIN: '', ALLOWED_PROJECT_DIRS: dir, AGENTS_CONFIG_JSON: JSON.stringify([{ id: 'audit', label: 'Test shell', command: '/bin/sh', args: ['-i'] }]) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = ''; child.stdout.on('data', (data) => { output = (output + data).slice(-6000); }); child.stderr.on('data', (data) => { output = (output + data).slice(-6000); });
  let browser, extraSocket;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
      if (child.exitCode !== null) throw new Error('Backend failed: ' + output);
      await pause(100);
    }
    assert.ok(ready, 'backend ready');
    assert.equal((await fetch(base + '/api/web-cli/api/sessions')).status, 401);
    assert.equal((await fetch(base + '/vietqr/', { redirect: 'manual' })).status, 303);
    await new Promise((resolve, reject) => {
      const probe = new WebSocket(`${base.replace('http:', 'ws:')}/api/web-cli/api/sessions/unknown/ws`, ['web-cli', 'ticket.invalid'], { headers: { Origin: base }, handshakeTimeout: 5000 });
      probe.on('unexpected-response', (_request, response) => {
        try { assert.equal(response.statusCode, 401); assert.equal(response.headers['content-length'], '0'); resolve(); }
        catch (error) { reject(error); }
        finally { response.resume(); probe.terminate(); }
      });
      probe.on('open', () => { probe.terminate(); reject(new Error('Unauthenticated WebSocket accepted')); });
      probe.on('error', (error) => { if (!error.message.includes('before the connection was established')) reject(error); });
    });
    const password = fs.readFileSync(path.join(dir, 'hub/initial-login.txt'), 'utf8').match(/^Password: (.+)$/m)[1];
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.goto(base, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-view:not([hidden])');
    await page.screenshot({ path: '/tmp/server-hub-login-desktop.png', fullPage: true });
    await page.type('#username', 'test-owner'); await page.type('#password', password);
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#login-form button[type=submit]')]);
    await page.waitForSelector('#hub-view:not([hidden])');
    await page.screenshot({ path: '/tmp/server-hub-desktop.png', fullPage: true });
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `hub fits ${width}px`);
    }
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.waitForSelector('#hub-view:not([hidden])');
    await page.screenshot({ path: '/tmp/server-hub-mobile.png', fullPage: true });
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#vietqr-card')]);
    await page.type('#account', '0011012345678'); await page.type('#amount', '180000');
    await page.click('#qr-form button[type=submit]'); await page.waitForSelector('#qr-output canvas');
    const geometry = await page.$eval('#qr-output canvas', (canvas) => ({ width: canvas.width, height: canvas.height, cssWidth: canvas.getBoundingClientRect().width, cssHeight: canvas.getBoundingClientRect().height, png: canvas.toDataURL('image/png') }));
    assert.equal(geometry.width, 580); assert.equal(geometry.height, 580); assert.ok(Math.abs(geometry.cssHeight - geometry.cssWidth) < 1);
    fs.writeFileSync('/tmp/server-hub-vietqr.png', Buffer.from(geometry.png.split(',')[1], 'base64'));
    assert.ok(await page.evaluate(() => !document.querySelector('#download').disabled));
    const cdp = await page.createCDPSession();
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    await page.click('#download');
    for (let i = 0; i < 30 && !fs.existsSync(path.join(dir, 'vietqr-0011012345678.png')); i++) await pause(100);
    const downloaded = fs.readFileSync(path.join(dir, 'vietqr-0011012345678.png'));
    assert.equal(downloaded.readUInt32BE(16), 580); assert.equal(downloaded.readUInt32BE(20), 580);
    await page.screenshot({ path: '/tmp/server-hub-vietqr-mobile.png', fullPage: true });
    await page.$eval('#amount', (element) => { element.value = '12.34'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#qr-form button[type=submit]');
    assert.ok(await page.$eval('#error', (element) => !element.hidden));
    assert.ok(await page.$eval('#download', (element) => element.disabled));

    await page.goto(base + '/api/web-cli/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name=username]');
    assert.equal(await page.$('input[autocomplete=off]'), null, 'hub supplies enrollment code without manual secret handling');
    await page.type('input[name=username]', 'test-cli-owner'); await page.type('input[name=password]', 'browser-test-cli-password');
    const setupResponse = page.waitForResponse((response) => response.url().endsWith('/api/auth/setup') && response.request().method() === 'POST');
    await page.click('button.primary');
    const setup = await (await setupResponse).json(); assert.ok(setup.secret);
    await page.waitForSelector('input[name=code]');
    await page.type('input[name=code]', new TOTP({ secret: Secret.fromBase32(setup.secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate());
    await page.click('button.primary');
    await page.waitForFunction(() => document.body.textContent.includes('Đã lưu, mở terminal'));
    await page.$$eval('button', (buttons) => buttons.find((button) => button.textContent === 'Đã lưu, mở terminal').click());
    await page.waitForSelector('dialog[open]');
    await page.$$eval('button', (buttons) => {
      const btn = buttons.find((b) =>
        b.textContent?.includes('Tạo phiên') || b.textContent?.includes('Phiên mới')
      );
      btn?.click();
    });
    await page.waitForSelector('.new-session-dialog[open]');
    await page.$$eval('.new-session-dialog button[type=submit]', (buttons) => {
      buttons[0]?.click();
    });
    await page.waitForFunction(() => !document.querySelector('#command-input')?.disabled);
    await page.type('#command-input', "printf 'HUB_TERMINAL_OK\\n'");
    await page.click('.composer button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent.includes('HUB_TERMINAL_OK'));
    const sessionId = await page.$eval('select[aria-label="Chuyển phiên terminal"]', (select) => select.value);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !document.querySelector('#command-input')?.disabled);
    assert.equal(await page.$eval('select[aria-label="Chuyển phiên terminal"]', (select) => select.value), sessionId);
    await page.screenshot({ path: '/tmp/server-hub-cli-mobile.png' });
    const ticket = await page.evaluate(async (id) => (await (await fetch(`/api/web-cli/api/sessions/${id}/ws-ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).ticket, sessionId);
    const cookies = await page.cookies();
    const cookie = cookies.filter((item) => ['server_hub', 'web_cli_session'].includes(item.name)).map((item) => `${item.name}=${item.value}`).join('; ');
    extraSocket = new WebSocket(`${base.replace('http:', 'ws:')}/api/web-cli/api/sessions/${sessionId}/ws`, ['web-cli', `ticket.${ticket}`], { headers: { Origin: base, Cookie: cookie } });
    await once(extraSocket, 'open');
    const closed = once(extraSocket, 'close');
    const hubPage = await browser.newPage(); await hubPage.goto(base, { waitUntil: 'networkidle0' });
    await hubPage.click('#logout');
    await hubPage.waitForSelector('#login-view:not([hidden])');
    extraSocket.send(JSON.stringify({ type: 'input', data: "printf 'MUST_NOT_RUN\\n'\r" }));
    assert.equal((await closed)[0], 4001, 'hub logout revokes live websocket');
    assert.equal((await page.evaluate(async () => (await fetch('/api/web-cli/api/sessions')).status)), 401);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, checks: ['hub login and protected routes', '4 responsive widths', 'VietQR canvas and downloaded PNG', 'invalid amount rejected', 'automatic first 2FA enrollment', 'TOTP and recovery screen', 'real PTY command over WebSocket', 'reload restores PTY', 'hub logout revokes live WebSocket'], screenshots: ['/tmp/server-hub-desktop.png', '/tmp/server-hub-mobile.png', '/tmp/server-hub-vietqr-mobile.png', '/tmp/server-hub-cli-mobile.png'] }, null, 2));
  } finally {
    extraSocket?.terminate();
    if (browser) await browser.close();
    const exited = child.exitCode === null ? once(child, 'exit') : Promise.resolve(); child.kill('SIGTERM'); await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
