const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const WebSocket = require('ws');
const origin = 'https://tmp-web.hoanit.io.vn';
const local = process.argv.includes('--local');
const base = local ? 'http://127.0.0.1:3001' : origin;
const proxyHeaders = local ? { Host: 'tmp-web.hoanit.io.vn', 'X-Forwarded-Proto': 'https' } : {};
const headers = { ...proxyHeaders, Origin: origin };
const send = (url, init = {}) => {
  const merged = { ...headers, ...init.headers };
  if (!local) return fetch(base + url, { ...init, headers: merged, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  // Native HTTP preserves the synthetic Host used to exercise the proxy boundary.
  return new Promise((resolve, reject) => {
    const req = http.request(base + url, { method: init.method || 'GET', headers: merged, timeout: 15000 }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out'))); req.on('error', reject); req.end(init.body);
  });
};

async function main() {
  const statuses = {};
  for (const [url, expected] of [['/login', 200], ['/', 303], ['/vietqr/', 303], ['/api/web-cli/', 303], ['/api/web-cli/api/sessions', 401], ['/hub-api/web-cli-setup', 401]]) {
    const response = await send(url); assert.equal(response.status, expected, url); statuses[url] = response.status;
  }
  const defaultSecretsPath = path.join(os.homedir(), '.local/state/server-hub/hub-auth/initial-login.txt');
  const secretsPath = process.env.HUB_SECRETS_PATH || defaultSecretsPath;
  const secrets = fs.readFileSync(secretsPath, 'utf8');
  const username = secrets.match(/^Username: (.+)$/m)[1];
  const password = secrets.match(/^Password: (.+)$/m)[1];
  const login = await send('/hub-api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(login.status, 200, 'hub login');
  const sessionCookie = login.headers.get('set-cookie');
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(sessionCookie.includes(flag));
  const cookie = sessionCookie.split(';')[0];
  try {
    for (const [url, expected] of [['/', 200], ['/vietqr/', 200], ['/api/web-cli/', 200], ['/api/web-cli/api/sessions', 401], ['/secrets/account.json', 404], ['/.env', 404]]) {
      const response = await send(url, { headers: { Cookie: cookie } }); assert.equal(response.status, expected, url); statuses['logged-in ' + url] = response.status;
      if (url === '/') assert.ok((await response.text()).includes('<title>Server Hub'));
    }
    const status = await (await send('/api/web-cli/api/auth/status', { headers: { Cookie: cookie } })).json();
    assert.equal(status.authenticated, false); assert.equal(status.hubEnabled, true);
    const setupRequired = status.setupRequired;
    const service = await (await send('/hub-api/services', { headers: { Cookie: cookie } })).json();
    assert.equal(service.services.length, 2); assert.equal(service.agentCount, 4);
    const wsStatus = await new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/web-cli/api/sessions/unauthorized/ws', ['web-cli', 'ticket.invalid'], { headers: { ...headers, Cookie: cookie }, handshakeTimeout: 10000 });
      ws.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); ws.terminate(); });
      ws.on('open', () => { ws.terminate(); reject(new Error('WebSocket unexpectedly opened')); });
      ws.on('error', (error) => { if (!error.message.includes('before the connection was established')) reject(error); });
    });
    assert.equal(wsStatus, 401, 'unauthenticated WebSocket handshake');
    console.log(JSON.stringify({ passed: true, target: local ? 'loopback' : origin, statuses, services: service.services.map((item) => item.id), agents: service.agentCount, webCliSetupRequired: setupRequired, unauthorizedWebSocket: wsStatus }, null, 2));
  } finally {
    assert.equal((await send('/hub-api/logout', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 200, 'hub logout');
    assert.equal((await send('/hub-api/services', { headers: { Cookie: cookie } })).status, 401, 'services after logout');
  }
  if (process.argv.includes('--browser')) {
    assert.ok(!local, 'browser verification uses public HTTPS');
    const { resolvePuppeteer, resolveChromePath } = require('./smoke-utils.cjs');
    const puppeteer = resolvePuppeteer();
    const browser = await puppeteer.launch({ executablePath: resolveChromePath() || process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewport({ width: 1440, height: 1000 });
      await page.goto(origin + '/login', { waitUntil: 'networkidle0' });
      await page.waitForSelector('#login-view:not([hidden])');
      await page.type('#username', username); await page.type('#password', password);
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#login-form button[type=submit]')]);
      await page.waitForSelector('#hub-view:not([hidden])');
      await page.screenshot({ path: '/tmp/server-hub-public-desktop.png', fullPage: true });
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      await page.waitForSelector('#hub-view:not([hidden])');
      await page.screenshot({ path: '/tmp/server-hub-public-mobile.png', fullPage: true });
      await page.goto(origin + '/vietqr/', { waitUntil: 'networkidle0' });
      await page.type('#account', '0011012345678'); await page.click('#qr-form button[type=submit]');
      await page.waitForSelector('#qr-output canvas');
      await page.goto(origin + '/api/web-cli/', { waitUntil: 'networkidle0' });
      await page.waitForSelector('input[name=username]');
      assert.ok(await page.evaluate(() => document.body.textContent.includes('xác thực hai bước')));
      await page.goto(origin, { waitUntil: 'networkidle0' });
      await page.click('#logout'); await page.waitForSelector('#login-view:not([hidden])');
      assert.deepEqual(errors, []);
      console.log('PUBLIC_BROWSER_PASS: HTTPS login, desktop/mobile hub, VietQR canvas, Web CLI 2FA setup screen, logout.');
    } finally { await browser.close(); }
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
