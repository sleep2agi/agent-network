import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { chromium } from '/browser/node_modules/playwright/index.mjs';

const root = '/site/docs/.vitepress/dist';
const asset = (platform, kind, architecture, name, extra = {}) => ({ platform, kind, architecture,
  name, role: 'install', bytes: 123456, version: '0.2.245',
  url: `https://github.com/sleep2agi/agent-network-app/releases/download/desktop-v0.2.245/${name}`,
  mirrorUrl: `https://modelscope.cn/desktop/0.2.245/${name}`, ...extra });
const catalog = { version: '0.2.245', tag: 'desktop-v0.2.245', source: 'desktop-v0.2.245',
  releaseUrl: 'https://github.com/sleep2agi/agent-network-app/releases/tag/desktop-v0.2.245',
  publishedAt: '2026-10-11T19:59:10Z', platforms: [
    { id: 'macos', assets: [asset('macos', 'dmg', 'arm64', 'ANet_0.2.245_aarch64.dmg')] },
    { id: 'windows', assets: [asset('windows', 'nsis', 'x64', 'ANet_0.2.245_x64-setup.exe')] },
    { id: 'android', assets: [asset('android', 'apk', 'universal', 'agent-network-0.2.245.apk', { url: null,
      mirrorUrl: 'https://modelscope.cn/android/agent-network-0.2.245.apk',
      checksumUrl: 'https://modelscope.cn/android/agent-network-0.2.245.apk.sha256' })] },
    { id: 'linux', assets: [] }, { id: 'ios', assets: [] },
  ] };
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.html': 'text/html' };
const server = createServer(async (req, res) => {
  if (req.url === '/api/desktop-downloads') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(catalog)); return; }
  const path = req.url.split('?')[0];
  for (const suffix of ['', '.html', '/index.html']) {
    const filename = root + path + suffix;
    try {
      if (!(await stat(filename)).isFile()) continue;
      const ext = filename.slice(filename.lastIndexOf('.'));
      res.setHeader('content-type', mime[ext] || 'application/octet-stream');
      res.end(await readFile(filename)); return;
    } catch {}
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
let passed = 0;
try {
  for (const [platform, ua, width] of [
    ['macos', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 1280],
    ['windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 1280],
    ['android', 'Mozilla/5.0 (Linux; Android 14)', 390],
  ]) for (const language of ['zh', 'en']) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, userAgent: ua });
    await page.goto(origin + (language === 'zh' ? '/download' : '/en/download'));
    await page.locator('.download-recommendation a').waitFor();
    assert.ok((await page.locator('.download-recommendation a').getAttribute('href')).includes(platform === 'android' ? '/android/' : '0.2.245/'));
    assert.ok((await page.locator('.download-recommendation').innerText()).includes(platform === 'macos' ? 'Apple Silicon' : platform === 'windows' ? 'x64' : '0.2.245'));
    assert.equal(await page.locator('#linux a').count(), 0);
    assert.equal(await page.locator('#android a[href*="github.com"]').count(), 0);
    assert.equal(await page.locator('.download-cli a').count(), 1);
    assert.ok(await page.locator('time').textContent() === '2026-10-11');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (process.env.EVIDENCE_DIR && language === 'zh' && platform !== 'windows') {
      await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/${platform}.png`, fullPage: true });
    }
    console.log(`PASS ${platform}/${language}/${width}px: recommendation, architecture, no fake package, CLI, date, no overflow`);
    passed++; await page.close();
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
assert.equal(passed, 6);
console.log('6/6 browser cases passed; fixture API, no live installation or account activity');
