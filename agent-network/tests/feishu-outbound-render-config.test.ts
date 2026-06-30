/**
 * RFC-020 §16 — feishu outbound render mode config loading tests.
 *
 * Verifies `loadFeishuChannelConfig` resolves `outboundRender` from:
 *   1. access.json `outboundRender` field (operator-facing)
 *   2. .env `FEISHU_OUTBOUND_RENDER` (test override)
 *   3. default "plain" (Vincent 2026-06-30 ask)
 *
 * Run: `bun tests/feishu-outbound-render-config.test.ts`
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { loadFeishuChannelConfig } from "../src/im/feishu/config";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

function mkChannelDir(opts: {
  accessJson?: object;
  envFile?: Record<string, string>;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-render-config-"));
  // .env (required for FEISHU_APP_ID / FEISHU_APP_SECRET)
  const envLines = [
    "FEISHU_APP_ID=cli_test_app_id",
    "FEISHU_APP_SECRET=test_secret_NOT_REAL_FOR_FIXTURE_USE_ONLY",
  ];
  if (opts.envFile) {
    for (const [k, v] of Object.entries(opts.envFile)) {
      envLines.push(`${k}=${v}`);
    }
  }
  fs.writeFileSync(path.join(dir, ".env"), envLines.join("\n"));
  if (opts.accessJson) {
    fs.writeFileSync(path.join(dir, "access.json"), JSON.stringify(opts.accessJson, null, 2));
  }
  return dir;
}

// ── 1. Default behavior — no config at all → "plain" ───────────────────────

{
  const dir = mkChannelDir({});
  const cfg = loadFeishuChannelConfig(dir);
  expect("default (no access.json, no env): outboundRender === 'plain'", cfg.outboundRender === "plain", `got: ${cfg.outboundRender}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 2. access.json with allowFrom only (no outboundRender) → "plain" ──────

{
  const dir = mkChannelDir({
    accessJson: { allowFrom: ["ou_xxx"], allowChats: [] },
  });
  const cfg = loadFeishuChannelConfig(dir);
  expect("legacy access.json (no field): outboundRender === 'plain'", cfg.outboundRender === "plain", `got: ${cfg.outboundRender}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 3. access.json with explicit outboundRender ───────────────────────────

for (const mode of ["plain", "card", "auto"] as const) {
  const dir = mkChannelDir({
    accessJson: { allowFrom: [], allowChats: [], outboundRender: mode },
  });
  const cfg = loadFeishuChannelConfig(dir);
  expect(
    `access.json outboundRender='${mode}' → loaded as '${mode}'`,
    cfg.outboundRender === mode,
    `got: ${cfg.outboundRender}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 4. Invalid value → fallback to "plain" ────────────────────────────────

{
  const dir = mkChannelDir({
    accessJson: { allowFrom: [], allowChats: [], outboundRender: "bogus" },
  });
  const cfg = loadFeishuChannelConfig(dir);
  expect("invalid mode 'bogus' → falls back to 'plain'", cfg.outboundRender === "plain", `got: ${cfg.outboundRender}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = mkChannelDir({
    accessJson: { allowFrom: [], allowChats: [], outboundRender: null as any },
  });
  const cfg = loadFeishuChannelConfig(dir);
  expect("null mode → falls back to 'plain'", cfg.outboundRender === "plain", `got: ${cfg.outboundRender}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 5. .env FEISHU_OUTBOUND_RENDER as override path ───────────────────────

{
  const dir = mkChannelDir({
    envFile: { FEISHU_OUTBOUND_RENDER: "auto" },
  });
  const cfg = loadFeishuChannelConfig(dir);
  expect(
    "env FEISHU_OUTBOUND_RENDER=auto → loaded as 'auto' (no access.json field)",
    cfg.outboundRender === "auto",
    `got: ${cfg.outboundRender}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 6. access.json takes precedence over env ──────────────────────────────

{
  const dir = mkChannelDir({
    accessJson: { allowFrom: [], allowChats: [], outboundRender: "card" },
    envFile: { FEISHU_OUTBOUND_RENDER: "auto" },
  });
  const cfg = loadFeishuChannelConfig(dir);
  expect(
    "access.json='card' + env='auto' → access wins ('card')",
    cfg.outboundRender === "card",
    `got: ${cfg.outboundRender}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 7. Vincent's UAT default — feishu-local with existing legacy access.json ──
// Smoke test: a real-shaped pre-mode access.json (just allowFrom + allowChats,
// no outboundRender field) must produce the "plain" default so the deploy
// alone is enough to fix Vincent's bug — no config edit required.

{
  const dir = mkChannelDir({
    accessJson: {
      allowFrom: ["ou_74d554f4024ca8f2b643180229571f57"],
      allowChats: [],
    },
  });
  const cfg = loadFeishuChannelConfig(dir);
  expect(
    "Vincent's legacy access.json → 'plain' default (no edit needed for fix)",
    cfg.outboundRender === "plain",
    `got: ${cfg.outboundRender}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 8. allowFrom round-trip not broken by mode field ──────────────────────

{
  const dir = mkChannelDir({
    accessJson: {
      allowFrom: ["ou_x", "ou_y"],
      allowChats: ["oc_a"],
      outboundRender: "card",
    },
  });
  const cfg = loadFeishuChannelConfig(dir);
  expect(
    "access fields preserved alongside mode",
    cfg.access.allowFrom.includes("ou_x") &&
      cfg.access.allowFrom.includes("ou_y") &&
      cfg.access.allowChats.includes("oc_a"),
    `got: ${JSON.stringify(cfg.access)}`,
  );
  expect("mode loaded alongside access", cfg.outboundRender === "card");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Summary ────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} feishu-outbound-render-config tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
