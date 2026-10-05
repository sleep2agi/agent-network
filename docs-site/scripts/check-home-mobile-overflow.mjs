#!/usr/bin/env node
// #568 —— 首页在手机上不许横向溢出。
//
// 起因:负责人在微信内置浏览器里打开 anet.sh,「桌面端开箱即用，CLI 保留全部能力」
// 那一节的两张卡片宽出屏幕、正文从一行中间被截断。根因是 ≤720px 断点把卡片网格写成
// `grid-template-columns: 1fr` —— `1fr` 的下限是 `auto`(= 内容的 min-content),
// 卡片里 `white-space: nowrap` 的 `curl … | sh` 命令行于是把整列撑到 ~400px。
// 桌面断点用的是 `minmax(0, 1fr)`,所以桌面上从来看不到。
//
// 这道门对构建产物(docs/.vitepress/dist)起一个本地静态服务,用 Chromium 的手机
// 模拟(isMobile/hasTouch/DPR 3 + 微信 UA)逐个宽度打开中英文首页,判三件事:
//   1. document.documentElement.scrollWidth 或 innerWidth > 设备宽度(页面能被横向拖动,
//      或手机浏览器为了装下过宽的内容把布局视口撑大 —— 后者 innerWidth 会跟着变,
//      所以尺子必须是设备宽度,不是 innerWidth)
//   2. 主内容(.VPContent)里任何盒子的右/左边缘出了视口,且没有被一个本身在视口内的
//      裁剪祖先(overflow ≠ visible)兜住
//   3. 主内容里任何一段可见文字被裁掉 —— 按文字行的 range rect 判,不按元素盒判:
//      超出视口,或超出某个 overflow ≠ visible 的祖先的右边缘(滚动框里藏一半的命令
//      也算:在手机上它看起来和截断一模一样)
//
// 字号放大:微信 / 安卓 WebView 常把正文放大到 112–125%。Chromium 没有暴露 textZoom,
// 用两种近似:`rem125` 把根字号设成 125%(所有 rem 文字放大),`zoom120` 给 body 加
// `zoom: 1.2`(文字和布局一起放大,等效于更窄的视口,是偏悲观的近似;它也会放大
// VitePress 的 body min-width:320px,所以只在 ≥384px 的宽度上判,见下面的 skip)。
//
// 用法:
//   npm run build && npm run test:home-mobile
//   node scripts/check-home-mobile-overflow.mjs [--dist DIR] [--widths 320,390]
//        [--variants base,rem125,zoom120] [--shots DIR] [--json FILE] [--report-only]
//
// 退出码:0 = 全部组合无溢出;1 = 至少一处溢出;2 = 环境问题(没有 dist / 没打开任何页面)。

import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const DIST = path.resolve(opt('dist', path.join(here, '..', 'docs', '.vitepress', 'dist')));
const WIDTHS = opt('widths', '320,360,375,390,414,430').split(',').map(Number);
const VARIANTS = opt('variants', 'base,rem125,zoom120').split(',');
const PAGES = opt('pages', '/,/en/').split(',');
const SHOTS = opt('shots', '');
const JSON_OUT = opt('json', '');
const REPORT_ONLY = flag('report-only');
const TOL = 1; // px —— 亚像素取整

// 微信 8.x 安卓内置浏览器(XWeb)的 UA 形状。
const WECHAT_UA =
  'Mozilla/5.0 (Linux; Android 14; V2309A Build/UP1A.231005.007; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.103 Mobile Safari/537.36 XWEB/1300333 ' +
  'MMWEBSDK/20240802 MMWEBID/1234 MicroMessenger/8.0.51.2720(0x28003336) WeChat/arm64 Weixin ' +
  'NetType/WIFI Language/zh_CN ABI/arm64';

const VARIANT_CSS = {
  base: '',
  rem125: 'html{font-size:125% !important}',
  zoom120: 'body{zoom:1.2}',
};

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`FAIL(env): ${DIST}/index.html 不存在 —— 先 npm run build`);
  process.exit(2);
}
for (const v of VARIANTS) {
  if (!(v in VARIANT_CSS)) {
    console.error(`FAIL(env): unknown variant ${v}`);
    process.exit(2);
  }
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  console.error('FAIL(env): playwright 未安装 —— npm ci 后再 npx playwright install chromium');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain',
};
async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const base = path.join(DIST, path.normalize(clean).replace(/^([/\\])+/, ''));
  if (!base.startsWith(DIST)) return null;
  for (const c of [base, `${base}.html`, path.join(base, 'index.html')]) {
    try { if ((await stat(c)).isFile()) return c; } catch {}
  }
  return null;
}
const server = createServer(async (req, res) => {
  const f = await resolveFile(req.url || '/');
  if (!f) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(await readFile(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// 在页面里跑的测量。返回 { scrollWidth, innerWidth, boxes[], texts[], sections[] }。
function measure(deviceWidth) {
  // 用设备宽度,不用 innerWidth:isMobile 下内容一宽,Chromium/微信会把布局视口
  // 撑大去装它(innerWidth 跟着变),拿 innerWidth 当尺子就永远量不出溢出。
  const vw = deviceWidth;
  const TOL = 1;
  const root = document.querySelector('.VPContent') || document.body;
  const desc = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = [...el.classList].filter((c) => !c.startsWith('data-v')).slice(0, 3);
    if (cls.length) s += `.${cls.join('.')}`;
    return s;
  };
  const pathOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) parts.unshift(desc(e));
    return parts.join(' > ');
  };
  const sectionOf = (el) => {
    const s = el.closest('section, .VPHero, .VPFeatures, .VPHomeHero, .VPHomeFeatures');
    if (!s) return '(none)';
    const h = s.querySelector('h1, h2');
    return `${desc(s)}${h ? ` 「${h.textContent.trim().slice(0, 40)}」` : ''}`;
  };
  const clips = (el) => {
    const cs = getComputedStyle(el);
    return cs.overflowX !== 'visible';
  };
  // 从 el 往上找第一个裁剪祖先(不含 el 自己)。
  const clipAncestors = (el) => {
    const out = [];
    for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      if (clips(e)) out.push(e);
    }
    return out;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  const boxes = [];
  for (const el of root.querySelectorAll('*')) {
    if (!visible(el)) continue;
    if (el.closest('[aria-hidden="true"], svg')) continue; // 装饰层(背景光斑/网格/拓扑图)
    const r = el.getBoundingClientRect();
    if (r.right <= vw + TOL && r.left >= -TOL) continue;
    // 被一个本身在视口内的裁剪祖先兜住 = 不会把页面撑宽,也不会被看到。
    const contained = clipAncestors(el).some((a) => {
      const ar = a.getBoundingClientRect();
      return ar.right <= vw + TOL && ar.left >= -TOL;
    });
    if (contained) continue;
    boxes.push({ el: pathOf(el), section: sectionOf(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
  }

  const texts = [];
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    if (!el || !visible(el) || el.closest('[aria-hidden="true"], svg, .visually-hidden, .sr-only')) continue;
    let limitR = vw;
    let limitL = 0;
    let by = 'viewport';
    for (const a of clipAncestors(el)) {
      const ar = a.getBoundingClientRect();
      const cs = getComputedStyle(a);
      const right = ar.right - parseFloat(cs.borderRightWidth);
      const left = ar.left + parseFloat(cs.borderLeftWidth);
      if (right < limitR) { limitR = right; by = desc(a); }
      if (left > limitL) { limitL = left; }
    }
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const lr of range.getClientRects()) {
      if (lr.width < 1) continue;
      if (lr.right > limitR + TOL || lr.left < limitL - TOL) {
        texts.push({
          el: pathOf(el), section: sectionOf(el), clippedBy: by,
          text: n.textContent.trim().slice(0, 48),
          right: Math.round(lr.right), limit: Math.round(limitR),
        });
        break;
      }
    }
  }

  // 每一节的右边缘 —— 给报告用,不参与判定(判定由上面两类覆盖)。
  const sections = [...root.querySelectorAll('section, .VPHero, .VPFeatures, .product-path-card, .download-card, .feature-shot')]
    .filter(visible)
    .map((s) => ({ el: desc(s), right: Math.round(s.getBoundingClientRect().right) }));

  return {
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    boxes, texts, sections,
  };
}

const results = [];
let opened = 0;
const browser = await chromium.launch();
try {
  for (const page of PAGES) {
    for (const variant of VARIANTS) {
      for (const width of WIDTHS) {
        // zoom 会把 VitePress 自带的 `body { min-width: 320px }` 也放大成 384px ——
        // 真实的微信/安卓 textZoom 只放大文字,不放大 px 宽度。所以 zoom 变体只在
        // 「设备宽 / 1.2 ≥ 320」的宽度上判,窄于此的组合是模拟手段自己的假阳性。
        if (variant.startsWith('zoom') && width / 1.2 < 320) {
          console.log(`skip ${page.padEnd(4)} ${variant.padEnd(7)} ${String(width).padStart(3)}px  (zoom × body min-width 320px = 模拟假阳性)`);
          continue;
        }
        const ctx = await browser.newContext({
          viewport: { width, height: 844 },
          deviceScaleFactor: 3, isMobile: true, hasTouch: true,
          userAgent: WECHAT_UA, locale: page.startsWith('/en') ? 'en-US' : 'zh-CN',
          colorScheme: 'light', reducedMotion: 'reduce',
        });
        const p = await ctx.newPage();
        const resp = await p.goto(ORIGIN + page, { waitUntil: 'networkidle' });
        if (!resp || !resp.ok()) throw new Error(`load ${page} -> ${resp && resp.status()}`);
        if (VARIANT_CSS[variant]) await p.addStyleTag({ content: VARIANT_CSS[variant] });
        await p.waitForTimeout(150);
        const m = await p.evaluate(measure, width);
        opened++;
        const fail = m.scrollWidth > width + TOL || m.innerWidth > width + TOL || m.boxes.length > 0 || m.texts.length > 0;
        results.push({ page, variant, width, fail, ...m });
        if (SHOTS) {
          await mkdir(SHOTS, { recursive: true });
          const tag = `${page === '/' ? 'zh' : 'en'}-${variant}-${width}`;
          await p.screenshot({ path: path.join(SHOTS, `${tag}-full.png`), fullPage: true });
          const sec = p.locator('section.product-path');
          if (await sec.count()) await sec.screenshot({ path: path.join(SHOTS, `${tag}-product-path.png`) });
        }
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}

if (opened === 0) { console.error('FAIL(env): 没有打开任何页面'); process.exit(2); }
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify(results, null, 2));

let bad = 0;
for (const r of results) {
  const head = `${r.page.padEnd(4)} ${r.variant.padEnd(7)} ${String(r.width).padStart(3)}px  scrollWidth=${r.scrollWidth} innerWidth=${r.innerWidth} device=${r.width}`;
  if (!r.fail) { console.log(`ok   ${head}`); continue; }
  bad++;
  console.log(`FAIL ${head}  boxes=${r.boxes.length} clippedText=${r.texts.length}`);
  const seen = new Set();
  for (const b of r.boxes) {
    const k = `box ${b.el}`; if (seen.has(k)) continue; seen.add(k);
    console.log(`       box  ${b.el}  [${b.left}..${b.right}]  in ${b.section}`);
  }
  for (const t of r.texts) {
    console.log(`       text "${t.text}" right=${t.right} > ${t.limit} (${t.clippedBy})  in ${t.section}`);
  }
}
console.log(`\n${results.length - bad}/${results.length} combinations clean (pages=${PAGES.join(' ')} variants=${VARIANTS.join(',')} widths=${WIDTHS.join(',')})`);
if (bad && !REPORT_ONLY) {
  console.log('FIX: 手机断点里的网格用 minmax(0, 1fr) 而不是 1fr;nowrap 文本要在窄屏换行或给网格项 min-width:0。见 #568。');
  process.exit(1);
}
process.exit(0);
