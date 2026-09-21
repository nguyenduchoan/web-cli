const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('esbuild');
const { resolvePuppeteer, resolveChromePath } = require('./smoke-utils.cjs');
const puppeteer = resolvePuppeteer();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-touch-regression-'));
  let browser;
  try {
    const bundle = path.join(dir, 'fixture.js');
    await build({ stdin: { contents: `
      import { Terminal } from '@xterm/xterm';
      import { installTerminalTouchScroll } from './web/src/lib/terminalTouchScroll';
      const container = document.querySelector('#terminal');
      window.term = new Terminal({ cols: 41, rows: 29, scrollback: 100, fontSize: 14 });
      term.open(container);
      window.scroller = installTerminalTouchScroll(term, container);
      window.replies = [];
      term.onData(data => replies.push(data));
    `, resolveDir: path.resolve(__dirname, '..'), loader: 'ts' }, bundle: true, outfile: bundle, platform: 'browser' });
    browser = await puppeteer.launch({ executablePath: resolveChromePath() || process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="terminal" style="width:370px;height:620px"></div>');
    await page.addStyleTag({ path: require.resolve('@xterm/xterm/css/xterm.css') });
    await page.addScriptTag({ path: bundle });
    const cdp = await page.createCDPSession();
    const point = { x: 180, y: 180 };
    const touch = (type, offset = 0) => cdp.send('Input.dispatchTouchEvent', { type,
      touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [{ x: point.x, y: point.y + offset, id: 1 }] });
    const position = () => page.evaluate(() => term.buffer.active.viewportY);
    const write = (data) => page.evaluate(data => new Promise(resolve => term.write(data, resolve)), data);
    const prepare = async () => {
      await page.evaluate(() => { scroller.stop(); term.reset(); });
      await write(Array.from({ length: 180 }, (_, i) => `line-${i}\r\n`).join(''));
      await page.evaluate(() => term.scrollToLine(60)); await pause(80);
    };

    await prepare();
    await touch('touchStart'); await touch('touchMove', 25); await pause(80);
    const beforeTrim = await position();
    await write('new-output\r\n'.repeat(12)); await pause(80);
    const afterTrim = await position();
    assert.ok(afterTrim < beforeTrim, 'full history trims while the finger is held');
    await touch('touchMove', 50); await pause(80);
    const afterMove = await position();
    assert.ok(afterMove < afterTrim, `drag must continue upward after trim, got ${afterTrim} -> ${afterMove}`);
    await touch('touchCancel');

    await prepare();
    await touch('touchStart'); await touch('touchMove', 25); await pause(80);
    await write('\x1b[5n');
    assert.ok(await page.evaluate(() => replies.includes('\x1b[0n')), 'terminal generated an automatic status reply');
    const beforeReplyMove = await position();
    await touch('touchMove', 60); await pause(80);
    assert.ok(await position() < beforeReplyMove, 'automatic status reply must not cancel an active drag');
    await touch('touchCancel');

    await prepare();
    await touch('touchStart'); await touch('touchMove', 25); await pause(80);
    await page.evaluate(() => term.resize(41, 28)); await pause(80);
    const afterResize = await position();
    await touch('touchMove', 65); await pause(80);
    assert.ok(await position() < afterResize, 'height adjustment must not swallow the rest of a drag');
    await touch('touchCancel');

    await prepare();
    await touch('touchStart');
    for (let i = 1; i <= 8; i++) { await touch('touchMove', i * 15); await pause(16); }
    await touch('touchEnd');
    await write('streaming\r\n'.repeat(8) + '\x1b[5n');
    const afterStreaming = await position(); await pause(120);
    assert.ok(await position() < afterStreaming, 'momentum must continue through streaming output and automatic replies');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, checks: ['drag across history trimming', 'drag through automatic terminal replies', 'drag through height changes', 'momentum during streaming output'], beforeTrim, afterTrim, afterMove }, null, 2));
  } finally {
    if (browser) await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
