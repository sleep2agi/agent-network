// GA-blocker #2 follow-up — drive the create-node wizard 7 steps
// against the docker'd hub + daemon and screenshot each step.
// Session cookie seeded with the v3 utok from /api/auth/v3 (mirrors
// how a real admin lands after login).

import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3260';

function loadAdminEnv() {
  const raw = readFileSync('/tmp/ga2-shared/admin.env', 'utf-8');
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function loginViaV3() {
  // Log in via the dashboard's v3 auth route — this returns a Set-Cookie
  // with the v3:utok session that the browser can pick up.
  const resp = await fetch(`${BASE}/api/auth/v3`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', username: 'ga2admin', password: 'GA2!TestP@ss' }),
  });
  const setCookie = resp.headers.get('set-cookie');
  const m = /anet_dashboard_session=([^;]+)/.exec(setCookie || '');
  if (!m) throw new Error(`no session cookie in response: ${setCookie}`);
  return decodeURIComponent(m[1]);
}

async function main() {
  const admin = loadAdminEnv();
  console.log('[env] hub =', admin.HUB_BASE, 'utok(source)=', admin.UTOK.slice(0, 12) + '…');
  const cookieValue = await loginViaV3();
  console.log('[login] session cookie =', cookieValue.slice(0, 20) + '…');

  const chromiumPath = execFileSync('bash', ['-c', 'ls ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | tail -1'], { encoding: 'utf8' }).trim();
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  await ctx.addCookies([{
    name: 'anet_dashboard_session',
    value: cookieValue,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: false,
  }]);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  page.on('response', r => {
    const u = r.url();
    if (u.includes('/api/anet/') || u.includes('/api/auth/me')) console.log('[api]', r.status(), u);
  });

  const shotDir = '/tmp/ga2-shots';
  execFileSync('bash', ['-c', `mkdir -p ${shotDir} && rm -f ${shotDir}/*.png`]);

  async function shot(label) {
    const path = `${shotDir}/${label}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log('[shot]', path);
  }

  // ── /nodes ──────────────────────────────────────────────────────
  await page.goto(`${BASE}/nodes`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await shot('00-nodes');

  // Click "新建节点" (either header or empty-state variant).
  const createBtn = page.locator('button:has-text("新建节点"), a:has-text("新建节点")').first();
  await createBtn.click({ timeout: 8000 });
  await page.waitForTimeout(500);

  // ── Step 0: 服务器 (picker) ─────────────────────────────────────
  await page.waitForSelector('text=在哪台机器上创建', { timeout: 8000 });
  await page.waitForTimeout(600); // let the fetch settle
  await shot('01-step0-picker');

  // Click the ga-daemon card. Picker's grid renders daemons as cards
  // with a title matching the alias; click by that.
  const daemonCard = page.locator(':is(button,div,article,section):has-text("ga-daemon")').last();
  await daemonCard.click({ timeout: 6000 }).catch(e => console.log('[click daemon]', e.message));
  await page.waitForTimeout(400);
  await shot('02-step0-daemon-selected');

  // Advance.
  const nextBtn = page.locator('button:has-text("下一步")');
  await nextBtn.click();
  await page.waitForTimeout(300);

  // ── Step 1: 名字 ────────────────────────────────────────────────
  await page.waitForSelector('text=节点名字', { timeout: 4000 });
  const nameInput = page.locator('input[placeholder*="my-agent"]');
  await nameInput.fill('ga2-child-a');
  await page.waitForTimeout(200);
  await shot('03-step1-name');
  await nextBtn.click();
  await page.waitForTimeout(200);

  // ── Step 2: Runtime ─────────────────────────────────────────────
  await page.waitForSelector('text=Runtime', { timeout: 4000 });
  await shot('04-step2-runtime');
  // claude-agent-sdk is preselected (default); just advance.
  await nextBtn.click();
  await page.waitForTimeout(200);

  // ── Step 3: 模型 ────────────────────────────────────────────────
  await page.waitForSelector('text=模型', { timeout: 4000 });
  // Explicit model — hub's create_node schema requires model: z.string()
  // (non-empty), so "默认"/empty falls through to a zod reject downstream.
  // Pick the first Claude preset that this daemon declared supports.
  await page.selectOption('select', 'claude-sonnet-4-6');
  await page.waitForTimeout(200);
  await shot('05-step3-model');
  await nextBtn.click();
  await page.waitForTimeout(200);

  // ── Step 4: 参数 ────────────────────────────────────────────────
  await page.waitForSelector('text=permissionMode', { timeout: 4000 });
  await shot('06-step4-flags');
  await nextBtn.click();
  await page.waitForTimeout(200);

  // ── Step 5: 确认 ────────────────────────────────────────────────
  await page.waitForSelector('text=服务器', { timeout: 4000 });
  await page.waitForTimeout(300);
  await shot('07-step5-confirm');

  // Click 创建.
  const submitBtn = page.locator('button:has-text("创建")').last();
  await submitBtn.click();
  await page.waitForTimeout(600);
  await shot('08-creating');

  // Wait for the "done" phase — the wizard shows a success panel with
  // "节点已注册" once the child comes back online. Poll up to 40s.
  await page.waitForFunction(() => /节点已注册|已注册|正在监测/.test(document.body.textContent || ''), { timeout: 40_000 }).catch(() => {});
  await page.waitForTimeout(500);
  await shot('09-dispatched');

  // Poll until the "节点已注册" copy appears (child fully registered) or
  // we hit ~40s and screenshot whatever state we're in.
  const registered = await page.waitForFunction(() => /节点已注册，已出现在节点列表/.test(document.body.textContent || ''), { timeout: 40_000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(400);
  await shot(registered ? '10-online' : '10-timeout');

  console.log('[verdict] child registered visible in wizard:', registered);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
