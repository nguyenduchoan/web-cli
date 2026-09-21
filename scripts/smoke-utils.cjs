const fs = require("node:fs");

function resolvePuppeteer() {
  if (process.env.PUPPETEER_MODULE) {
    return require(process.env.PUPPETEER_MODULE);
  }
  try {
    return require("puppeteer");
  } catch {}
  try {
    return require("puppeteer-core");
  } catch {}
  throw new Error("Puppeteer not found. Please install puppeteer or puppeteer-core, or set PUPPETEER_MODULE.");
}

function resolveChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

module.exports = {
  resolvePuppeteer,
  resolveChromePath
};
