/**
 * RFC-020 §13 (Feishu hardening) — Layer A: env mask for claude-agent-sdk
 * subprocess.
 *
 * Tests the maskedEnv() helper: secrets stripped, claude-binary essentials
 * preserved, value-pattern catch-all neutralizes unknown-named secrets.
 *
 * Run: `bun tests/secret-mask.test.ts`
 */

import { maskedEnv, MASK_PLACEHOLDER, SECRET_KEYS } from "../src/secret-mask";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// ── 1. Exact-key secret stripping ──────────────────────────────────────────

const env1 = {
  FEISHU_APP_SECRET: "real-secret-xyz",
  FEISHU_VERIFICATION_TOKEN: "verif-aaa",
  FEISHU_ENCRYPT_KEY: "enc-bbb",
  GH_TOKEN: "ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  GITHUB_TOKEN: "github_pat_HEAD_abc123_TAIL",
  HUB_PASSWORD: "live123",
  SLACK_TOKEN: "xoxb-fake",
  TELEGRAM_TOKEN: "tg-fake",
  TELEGRAM_BOT_TOKEN: "tg-bot-fake",
};
const masked1 = maskedEnv(env1);
for (const k of Object.keys(env1)) {
  expect(`mask exact-key ${k}`, masked1[k] === MASK_PLACEHOLDER, `got "${masked1[k]}" (raw "${env1[k]}")`);
}

// ── 2. Claude binary essentials preserved ──────────────────────────────────

const env2 = {
  ANTHROPIC_AUTH_TOKEN: "sk-ant-fake-vendor-key",
  ANTHROPIC_API_KEY: "sk-ant-fake-vendor-key-2",
  ANTHROPIC_BASE_URL: "https://api.minimax.chat/anthropic",
  OPENAI_API_KEY: "sk-openai-fake",
  DEEPSEEK_API_KEY: "sk-ds-fake",
  MINIMAX_API_KEY: "mm-fake",
  INTERN_S1_API_KEY: "intern-fake",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/root",
  USER: "root",
  NODE_ENV: "production",
  LANG: "C.UTF-8",
  FEISHU_APP_ID: "cli_aab9eabbceba9cca",
};
const masked2 = maskedEnv(env2);
for (const k of Object.keys(env2)) {
  expect(`preserve claude-essential ${k}`, masked2[k] === env2[k], `got "${masked2[k]}"`);
}

// Special-case explicit: FEISHU_APP_ID is public identifier, must NOT mask.
expect("FEISHU_APP_ID is NOT in SECRET_KEYS (public id)", !SECRET_KEYS.has("FEISHU_APP_ID"));

// ── 3. Value-pattern catch-all (unknown key name, secret-like value) ───────

const env3 = {
  // anet network token — value pattern only
  RANDOMLY_NAMED_VAR_1: "ntok_EXAMPLEEXAMPLEEXAMPLE",
  // anet user token — value pattern
  ANOTHER_VAR: "utok_EXAMPLEEXAMPLEEXAMPLE",
  // GitHub fine-grained PAT
  CUSTOM_GH_VAR: "github_pat_HEAD_LONG_PART_LONG_PART_TAIL",
  // GitHub classic PAT
  YET_ANOTHER: "ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  // Slack bot token
  SLACK_RANDOM_NAME: "xoxb-EXAMPLEEXAMPLEEXAMPLE",
};
const masked3 = maskedEnv(env3);
for (const k of Object.keys(env3)) {
  expect(`mask value-pattern ${k}`, masked3[k] === MASK_PLACEHOLDER, `got "${masked3[k]}" (raw "${env3[k]}")`);
}

// ── 4. Anti-false-positive: similar-looking but NOT secret ─────────────────

const env4 = {
  // looks like ntok but not (too short / wrong prefix)
  NOT_A_TOKEN_1: "ntok_short", // 5 chars after prefix, too short to match pattern
  // ghp_ prefix but exactly 35 chars (not 36)
  NOT_A_TOKEN_2: "ghp_short",
  // unrelated string starting with similar prefix
  COMMENT: "this configuration is utok_ish but not a real token",
  // empty value
  EMPTY_VAR: "",
  // standard config var
  LOG_LEVEL: "info",
  DEBUG: "1",
  HUB_URL: "http://172.18.0.1:9200",
  ANET_MODEL: "MiniMax-M3",
};
const masked4 = maskedEnv(env4);
expect("don't mask ntok_short (< 8 chars after prefix)", masked4.NOT_A_TOKEN_1 === "ntok_short");
expect("don't mask ghp_short (< 36 chars after prefix)", masked4.NOT_A_TOKEN_2 === "ghp_short");
expect("don't mask string-containing-token-mention", masked4.COMMENT === env4.COMMENT);
expect("don't transform empty string", masked4.EMPTY_VAR === "");
for (const k of ["LOG_LEVEL", "DEBUG", "HUB_URL", "ANET_MODEL"]) {
  expect(`don't mask plain config ${k}`, masked4[k] === env4[k]);
}

// ── 5. Undefined and null values pass through ──────────────────────────────

const env5: any = {
  EXISTING_KEY: "real-value",
  UNDEFINED_KEY: undefined,
};
const masked5 = maskedEnv(env5);
expect("undefined value preserved", masked5.UNDEFINED_KEY === undefined);
expect("existing value preserved", masked5.EXISTING_KEY === "real-value");

// ── 6. Pure / non-mutating ─────────────────────────────────────────────────

const env6 = {
  FEISHU_APP_SECRET: "real",
  PATH: "/bin",
};
const env6Copy = { ...env6 };
maskedEnv(env6);
expect("original env not mutated (key unchanged)", env6.FEISHU_APP_SECRET === env6Copy.FEISHU_APP_SECRET);
expect("original env not mutated (PATH unchanged)", env6.PATH === env6Copy.PATH);

// ── 7. Round-trip stability ────────────────────────────────────────────────

// Same input → same output (idempotent-ish — masking <masked> stays <masked>)
const env7 = { FEISHU_APP_SECRET: "x", PATH: "/bin" };
const m1 = maskedEnv(env7);
const m2 = maskedEnv(m1);
expect("idempotent: maskedEnv twice = once", JSON.stringify(m1) === JSON.stringify(m2));

// ── 8. Real-world fixture (closest to what /work/.anet/.../runtime.env produces) ──

const realisticEnv = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/root",
  USER: "root",
  HOSTNAME: "9af56adcf3fa",
  ANTHROPIC_BASE_URL: "https://api.minimax.chat/anthropic",
  ANTHROPIC_AUTH_TOKEN: "sk-ant-real-vendor-key-xyz",
  ANET_MODEL: "MiniMax-M3",
  FEISHU_APP_ID: "cli_aab9eabbceba9cca",
  FEISHU_APP_SECRET: "VERY_REAL_SECRET_DO_NOT_LEAK",
  HUB_URL: "http://172.18.0.1:9200",
  HUB_USER: "admin",
  HUB_PASSWORD: "admin-password-123",
  // From config.json reading
  ANET_HUB_TOKEN_FROM_SOMEWHERE: "ntok_EXAMPLEEXAMPLEEXAMPLE",
  GH_PAT_VINCENT: "ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
};
const realMasked = maskedEnv(realisticEnv);

// Must mask
for (const k of ["FEISHU_APP_SECRET", "HUB_PASSWORD", "ANET_HUB_TOKEN_FROM_SOMEWHERE", "GH_PAT_VINCENT"]) {
  expect(`realistic: ${k} masked`, realMasked[k] === MASK_PLACEHOLDER, `got "${realMasked[k]}"`);
}
// Must keep
for (const k of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANET_MODEL", "FEISHU_APP_ID", "HUB_URL", "HUB_USER", "PATH", "HOME"]) {
  expect(`realistic: ${k} preserved`, realMasked[k] === realisticEnv[k], `got "${realMasked[k]}"`);
}

// Critical regression: realMasked must NOT contain the secret string anywhere
const serialized = JSON.stringify(realMasked);
expect(
  "realistic: serialized env contains NO occurrence of FEISHU_APP_SECRET value",
  !serialized.includes("VERY_REAL_SECRET_DO_NOT_LEAK"),
);
expect(
  "realistic: serialized env contains NO occurrence of HUB_PASSWORD value",
  !serialized.includes("admin-password-123"),
);
expect(
  "realistic: serialized env contains NO occurrence of ntok_",
  !serialized.includes("ntok_EXAMPLEEXAMPLEEXAMPLE"),
);
expect(
  "realistic: serialized env contains NO occurrence of ghp_",
  !serialized.includes("ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"),
);

// ── Summary (gates exit — MUST be last) ────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} secret-mask tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
