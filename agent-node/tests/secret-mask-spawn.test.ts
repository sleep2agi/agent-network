/**
 * RFC-020 §13 Layer A — env-mask spawn integration test.
 *
 * 通信牛 #326 round 1 blocker #4: "Docker proof that the spawned claude-
 * agent-sdk subprocess env cannot see the raw Feishu/hub/vendor secrets".
 *
 * This test simulates exactly what claude-agent-sdk does: spawn a child
 * Node process with `options.env = maskedEnv(process.env)` and inspect
 * the child's view of process.env. If the mask layer worked, the child
 * MUST NOT see any of the secret VALUES we seeded into the parent.
 *
 * No actual claude binary involved — that's not needed for this layer's
 * proof. What we're testing is "the env object we hand to spawn() does
 * NOT leak the raw secret bytes to the child process.env". Same shape
 * the SDK uses (it calls spawn() internally with options.env).
 *
 * Runs identically inside a Docker container (isolation by process
 * boundary, not by docker layer) — the spawn isolation IS the docker
 * isolation for this concern.
 *
 * Run: `bun tests/secret-mask-spawn.test.ts`
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { maskedEnv } from "../src/secret-mask";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// ── Setup: seed a parent env with the full secret zoo ───────────────────────

const SEED_SECRETS = {
  FEISHU_APP_SECRET: "SEED_FEISHU_SECRET_DO_NOT_LEAK",
  FEISHU_APP_ID: "cli_SEED_FEISHU_APP_ID",
  FEISHU_VERIFICATION_TOKEN: "SEED_VERIF_TOKEN",
  GH_TOKEN: "ghp_SEED_GH_TOKEN_XXXXXXXXXXXXXXXXXXXX",
  GITHUB_TOKEN: "github_pat_SEED_FINE_GRAINED_PAT_LONG_VAL_HERE",
  HUB_PASSWORD: "SEED_HUB_PASSWORD",
  COMMHUB_TOKEN: "atok_SEED_HUB_TOKEN_VALUE_XX",
  ANET_HUB_TOKEN: "SEED_ANET_HUB_VALUE",
  AUTH_TOKEN: "SEED_AUTH_TOKEN_VALUE",
  SLACK_TOKEN: "xoxb-SEED-SLACK-TOKEN-XXXXXXXXXXXX",
  TELEGRAM_TOKEN: "SEED_TG_TOKEN",
  // value-pattern catches (operator-named, secret-shaped)
  CUSTOM_NTOK: "ntok_SEED_NTOK_VALUE_XXXX",
  CUSTOM_UTOK: "utok_SEED_UTOK_VALUE_XXXX",
  CUSTOM_ATOK: "atok_SEED_ATOK_VALUE_XXXX",
  CUSTOM_MIXED_PAT: "github_pat_abcDEF1234567890_abcDEF1234567890",
  CUSTOM_GHP: "ghp_SEEDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", // 36 chars after prefix
  CUSTOM_XOXB: "xoxb-SEED-XXXXXXXXXXXXXXXXXX",
};

const SEED_KEEPS = {
  // Vendor credentials — claude binary needs them, MUST pass through.
  ANTHROPIC_AUTH_TOKEN: "sk-ant-KEEP-anthropic-auth-VALUE",
  ANTHROPIC_API_KEY: "sk-ant-KEEP-anthropic-api-VALUE",
  ANTHROPIC_BASE_URL: "https://api.minimax.chat/anthropic",
  OPENAI_API_KEY: "sk-openai-KEEP-VALUE",
  DEEPSEEK_API_KEY: "sk-ds-KEEP-VALUE",
  MINIMAX_API_KEY: "mm-KEEP-VALUE",
  // System essentials
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/root",
  USER: "root",
};

const fullEnv = { ...SEED_SECRETS, ...SEED_KEEPS, NODE_ENV: "production" };

// ── Build a child probe script that dumps process.env as JSON ───────────────

const tmp = mkdtempSync(join(tmpdir(), "anet-spawn-mask-"));
const probePath = join(tmp, "probe-env-dump.cjs");
writeFileSync(
  probePath,
  // CommonJS probe — works in any Node 18+ child without needing ESM loaders.
  `process.stdout.write(JSON.stringify(process.env));`,
);

// ── 1. Spawn child with maskedEnv (what cli.ts hands the SDK) ───────────────

const maskedView = maskedEnv(fullEnv);
const masked = spawnSync(process.execPath, [probePath], {
  env: maskedView,
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
});
expect("spawn(masked) exit 0", masked.status === 0, `status=${masked.status} stderr=${masked.stderr}`);

let childEnv: Record<string, string> = {};
try {
  childEnv = JSON.parse(masked.stdout || "{}");
} catch (e: any) {
  expect("child stdout is JSON", false, `parse error: ${e?.message ?? e}`);
}

// The child MUST NOT see any of the raw secret VALUES in its env table.
const childEnvJSON = JSON.stringify(childEnv);
for (const [k, raw] of Object.entries(SEED_SECRETS)) {
  expect(
    `child cannot see raw ${k} value`,
    !childEnvJSON.includes(raw),
    `raw "${raw}" found in child env at ${childEnvJSON.indexOf(raw)}`,
  );
}

// And the masked keys must show `<masked>` (or absent, but we set them so
// they should be `<masked>`).
for (const k of Object.keys(SEED_SECRETS)) {
  expect(
    `child sees ${k} = <masked>`,
    childEnv[k] === "<masked>",
    `got "${childEnv[k]}"`,
  );
}

// Keeps must pass through unchanged.
for (const [k, raw] of Object.entries(SEED_KEEPS)) {
  expect(
    `child sees ${k} preserved`,
    childEnv[k] === raw,
    `got "${childEnv[k]}", expected "${raw}"`,
  );
}

// ── 2. Counter-test: spawn child WITHOUT mask, prove SECRETS WOULD leak ─────

// (Regression guard — if someone disables the mask in cli.ts the spawn
//  would expose secrets. This test asserts the raw env IS visible to a
//  child without our mask, so the masked path's "no leak" claim has a
//  real contrast.)
const unmasked = spawnSync(process.execPath, [probePath], {
  env: fullEnv,
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
});
expect("spawn(unmasked control) exit 0", unmasked.status === 0);
const unmaskedJSON = unmasked.stdout || "";
const sample = SEED_SECRETS.FEISHU_APP_SECRET;
expect(
  `(control) UNMASKED child sees raw FEISHU_APP_SECRET value (proves mask is what removed it)`,
  unmaskedJSON.includes(sample),
  "control test failed — spawn isolation not the actual exfil prevention",
);

// ── Cleanup + summary ──────────────────────────────────────────────────────

rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} secret-mask-spawn (integration) tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
