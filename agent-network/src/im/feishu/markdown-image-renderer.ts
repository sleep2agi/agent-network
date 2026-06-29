/**
 * RFC-020 §14 — markdown → image rendering for Feishu replies.
 *
 * Vincent 2026-06-29 path: Feishu's `markdown` card element doesn't
 * render ATX headings or GFM tables (preview.7 caught only bold / list
 * / link). Rather than partially support a moving subset of card
 * elements, we render structured markdown to a PNG via headless
 * chromium and send it through Feishu's image API (`im:resource:upload`
 * scope). Pixel-perfect fidelity, zero schema fragility, text-not-
 * copyable accepted as the tradeoff for "actually renders".
 *
 * Hybrid route (decided in adapter.send):
 *   - plain text (no markdown markers)        → msg_type:"text"
 *   - markdown WITHOUT heading / table / long → msg_type:"interactive" (schema 1.0 card with `markdown` element — keeps copy/paste for short bold/list/link replies; preview.7 path)
 *   - markdown WITH heading / table / long    → THIS PATH (msg_type:"image" with rendered PNG)
 *
 * Renderer choice: `puppeteer-core` (no bundled chromium) + system
 * chromium (apt install in Docker). Rationale:
 *  - Pure-JS canvas-layout libraries (node-canvas, @napi-rs/canvas)
 *    cost 4-6h of manual paragraph wrapping + table cell measurement
 *    + Chinese width metrics; chromium does this natively.
 *  - puppeteer-core (5MB) + system chromium (~100MB) is smaller than
 *    full puppeteer (170MB) which bundles its own chromium.
 *  - Headless screenshot ~500ms after warmup. Bot's heavy turn is 20-
 *    70s; rendering cost is in the noise.
 *
 * Chromium reuse: we keep a single browser instance hot across
 * renderings to avoid the ~2-3s cold-start per call. Auto-close on
 * idle is a follow-up — agent-node worker lifetime is bounded.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { Buffer } from "node:buffer";
import MarkdownIt from "markdown-it";

// Lazy-loaded — puppeteer-core import is heavy enough to defer until
// the first image render is actually requested.
let puppeteerMod: typeof import("puppeteer-core") | null = null;
async function getPuppeteer() {
  if (!puppeteerMod) puppeteerMod = await import("puppeteer-core");
  return puppeteerMod;
}

/**
 * `PUPPETEER_EXECUTABLE_PATH` env override comes first; fall back to
 * the Debian apt path (`/usr/bin/chromium`). Operator can point to a
 * custom chromium / chrome binary.
 */
function resolveChromiumPath(): string {
  return process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || "/usr/bin/chromium";
}

let browserPromise: Promise<any> | null = null;
async function getBrowser(): Promise<any> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const puppeteer = await getPuppeteer();
      const exe = resolveChromiumPath();
      return puppeteer.launch({
        executablePath: exe,
        headless: true,
        // Sandbox flags: running as root inside Docker (anet-feishu-local
        // container is root) requires --no-sandbox. Standard chromium-
        // in-container recipe.
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--font-render-hinting=none",
        ],
        defaultViewport: { width: 800, height: 600, deviceScaleFactor: 2 },
      });
    })();
  }
  return browserPromise;
}

/**
 * Close the shared browser. Called from adapter.stop() during graceful
 * worker shutdown. Subsequent render calls re-launch.
 */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch {
    // best-effort
  } finally {
    browserPromise = null;
  }
}

const md = new MarkdownIt({
  html: false, // do NOT trust agent-generated HTML embedded in markdown
  linkify: true,
  breaks: false,
  typographer: false,
});

/**
 * HTML/CSS template for rendered markdown. CSS targets a clean, IM-
 * friendly look: Feishu-ish width, system font stack with CJK fonts
 * for Chinese, table with subtle borders + zebra rows, code blocks
 * in monospace with grey background.
 */
function buildHtml(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC",
                 "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.65;
    color: #1f1f1f;
    padding: 24px 28px;
    box-sizing: border-box;
    width: 800px;
  }
  h1, h2, h3, h4, h5, h6 {
    font-weight: 700;
    line-height: 1.3;
    margin: 1.2em 0 0.6em;
    color: #111;
  }
  h1 { font-size: 1.9em; border-bottom: 1px solid #eaeaea; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #eaeaea; padding-bottom: 0.25em; }
  h3 { font-size: 1.25em; }
  h4 { font-size: 1.1em; }
  h5 { font-size: 1em; }
  h6 { font-size: 0.95em; color: #555; }
  p { margin: 0.7em 0; }
  strong { font-weight: 700; }
  em { font-style: italic; }
  ul, ol { padding-left: 1.6em; margin: 0.7em 0; }
  li { margin: 0.2em 0; }
  code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo,
                 "Noto Sans Mono CJK SC", monospace;
    font-size: 0.92em;
    background: #f6f8fa;
    padding: 0.15em 0.4em;
    border-radius: 4px;
  }
  pre {
    background: #f6f8fa;
    border-radius: 6px;
    padding: 14px 16px;
    overflow: hidden;
    margin: 0.8em 0;
  }
  pre code {
    background: transparent;
    padding: 0;
    font-size: 0.9em;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  table {
    border-collapse: collapse;
    margin: 0.9em 0;
    width: 100%;
    font-size: 0.94em;
  }
  thead { background: #f6f8fa; }
  th, td {
    border: 1px solid #d0d7de;
    padding: 7px 11px;
    text-align: left;
    vertical-align: top;
  }
  th { font-weight: 600; }
  tbody tr:nth-child(even) { background: #fafbfc; }
  blockquote {
    margin: 0.7em 0;
    padding: 0.4em 1em;
    border-left: 4px solid #d0d7de;
    color: #57606a;
    background: #f6f8fa;
  }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  hr {
    border: 0;
    border-top: 1px solid #d0d7de;
    margin: 1.2em 0;
  }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * Render markdown text to a PNG buffer.
 *
 * Width is fixed at 800px (IM-friendly); height auto-fits content via
 * `fullPage:true`. Returns the raw PNG bytes — caller hands them to
 * `lark.im.image.create({image: Readable.from(buffer)})`.
 *
 * Throws on chromium launch failure or page navigation failure.
 * Caller is responsible for fallback (e.g., send the raw text as a
 * code block in the schema 1.0 card path).
 */
export async function renderMarkdownToPng(text: string): Promise<Buffer> {
  const html = buildHtml(md.render(text));
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    // Give CJK font loader a brief moment after layout (chromium may
    // re-flow once Noto-CJK finishes mapping glyphs).
    await sleep(80);
    const screenshot = (await page.screenshot({
      type: "png",
      fullPage: true,
      omitBackground: false,
    })) as Buffer;
    return screenshot;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Decide whether `renderMarkdownToPng` should be invoked for this reply
 * text, vs. falling back to msg_type:"text" / msg_type:"interactive"
 * (schema 1.0 card). Locked by 通信龙 3f70044c — trigger image when:
 *   - text contains a markdown table (Feishu card can't render)
 *   - text contains an ATX heading (Feishu card can't render)
 *   - text length > 2000 chars (image is better than scrollable text wall)
 *
 * Returns false for short prose, single-line plain text, and short
 * markdown lists / bold / link / inline-code which DO render fine in
 * the schema 1.0 `markdown` card element.
 */
export function shouldRenderAsImage(text: string): boolean {
  if (!text) return false;
  // ATX heading at start of line
  if (/(^|\n)#{1,6}\s/.test(text)) return true;
  // Table: row line followed by separator row
  if (/(^|\n)\|[^\n]*\|\n\|[\s:|-]+\|/.test(text)) return true;
  // Long content
  if (text.length > 2000) return true;
  return false;
}
