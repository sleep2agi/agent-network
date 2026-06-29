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
  FEISHU_APP_ID: "cli_EXAMPLEEXAMPLEXX", // 通信龙 8378d987 — public identifier but claude binary doesn't need it
  FEISHU_VERIFICATION_TOKEN: "verif-aaa",
  FEISHU_ENCRYPT_KEY: "enc-bbb",
  GH_TOKEN: "ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  GITHUB_TOKEN: "github_pat_HEAD_abc123_TAIL",
  HUB_PASSWORD: "live123",
  // 通信牛 #326 round 1 — common operator-named hub token vars must also mask
  COMMHUB_TOKEN: "atok_EXAMPLEEXAMPLEEXAMPLE",
  ANET_HUB_TOKEN: "any-custom-value-could-be-here",
  AUTH_TOKEN: "any-vendor-style-token",
  SLACK_TOKEN: "xoxb-fake",
  TELEGRAM_TOKEN: "tg-fake",
  TELEGRAM_BOT_TOKEN: "tg-bot-fake",
};
const masked1 = maskedEnv(env1);
for (const k of Object.keys(env1)) {
  expect(`mask exact-key ${k}`, masked1[k] === MASK_PLACEHOLDER, `got "${masked1[k]}" (raw "${env1[k]}")`);
}

// ── 2. Claude binary essentials preserved ──────────────────────────────────

// claude-agent-sdk REQUIRES vendor credentials + ANTHROPIC_BASE_URL to boot
// — masking those here would kill the LLM call. ANTHROPIC_AUTH_TOKEN's
// protection from in-LLM exfil moves to Layer B (tool-layer Bash/Read
// denylist on `env` / `/proc/*/environ`) per 通信龙 8378d987 +
// 通信牛 #326 review clarification: Layer A's job is "strip what isn't
// needed". Vendor tokens that the binary itself reads can't be masked
// here without killing the agent (would be哑炮 — silent crash with no
// auth header on the API call).
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
};
const masked2 = maskedEnv(env2);
for (const k of Object.keys(env2)) {
  expect(`preserve claude-essential ${k}`, masked2[k] === env2[k], `got "${masked2[k]}"`);
}

// Hub token names are NOW in SECRET_KEYS (通信牛 round 1)
for (const k of ["COMMHUB_TOKEN", "ANET_HUB_TOKEN", "AUTH_TOKEN"]) {
  expect(`SECRET_KEYS includes hub-name ${k}`, SECRET_KEYS.has(k));
}
// FEISHU_APP_ID is NOW in SECRET_KEYS (通信龙 round 2 — defense-in-depth: claude binary doesn't need it)
expect("FEISHU_APP_ID is in SECRET_KEYS (claude binary doesn't need)", SECRET_KEYS.has("FEISHU_APP_ID"));

// ── 3. Value-pattern catch-all (unknown key name, secret-like value) ───────

const env3 = {
  // anet network token — value pattern only
  RANDOMLY_NAMED_VAR_1: "ntok_EXAMPLEEXAMPLEEXAMPLE",
  // anet user token — value pattern
  ANOTHER_VAR: "utok_EXAMPLEEXAMPLEEXAMPLE",
  // anet legacy/admin token — also still product-accepted (通信牛 round 1 catch)
  ANY_OPERATOR_NAME: "atok_EXAMPLEEXAMPLEEXAMPLE",
  // GitHub fine-grained PAT (uppercase only — was the only shape my round 1 regex matched)
  CUSTOM_GH_VAR: "github_pat_HEAD_LONG_PART_LONG_PART_TAIL",
  // GitHub fine-grained PAT (mixed-case — 通信牛 round 1 catch — round 1 `[A-Z0-9_]` missed this)
  MIXED_CASE_PAT: "github_pat_abcDEF1234567890_abcDEF1234567890",
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
  FEISHU_APP_ID: "cli_EXAMPLEEXAMPLEXX", // public id but masked defense-in-depth (round 2)
  FEISHU_APP_SECRET: "VERY_REAL_SECRET_DO_NOT_LEAK",
  HUB_URL: "http://172.18.0.1:9200",
  HUB_USER: "admin",
  HUB_PASSWORD: "admin-password-123",
  // Hub token under common operator-chosen var names (round 1 catch)
  COMMHUB_TOKEN: "atok_EXAMPLEEXAMPLEEXAMPLE",
  ANET_HUB_TOKEN: "any-custom-format-could-be",
  // From config.json reading (custom var name — caught by value pattern)
  ANET_HUB_TOKEN_FROM_SOMEWHERE: "ntok_EXAMPLEEXAMPLEEXAMPLE",
  GH_PAT_VINCENT: "ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
};
const realMasked = maskedEnv(realisticEnv);

// Must mask
for (const k of [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "HUB_PASSWORD",
  "COMMHUB_TOKEN",
  "ANET_HUB_TOKEN",
  "ANET_HUB_TOKEN_FROM_SOMEWHERE",
  "GH_PAT_VINCENT",
]) {
  expect(`realistic: ${k} masked`, realMasked[k] === MASK_PLACEHOLDER, `got "${realMasked[k]}"`);
}
// Must keep
for (const k of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANET_MODEL", "HUB_URL", "HUB_USER", "PATH", "HOME"]) {
  expect(`realistic: ${k} preserved`, realMasked[k] === realisticEnv[k], `got "${realMasked[k]}"`);
}

// ── 9. 通信牛 #326 round-1 exact counterexample regression ─────────────────

// He pasted this exact JSON and showed the round-1 mask passed several values
// through. After the round-2 fixes (atok_ pattern + COMMHUB_TOKEN/AUTH_TOKEN/
// ANET_HUB_TOKEN keys + mixed-case PAT regex), all four entries should land
// in the mask. ANTHROPIC_AUTH_TOKEN deliberately stays (Layer A scope per
// 通信龙 8378d987 — protection moves to Layer B tool denylist).
const niuExample = {
  ANTHROPIC_AUTH_TOKEN: "sk-ant-live-example",
  COMMHUB_TOKEN: "atok_1234567890abcdef1234567890abcdef",
  ANET_HUB_TOKEN: "custom-secret",
  LOWER_PAT: "github_pat_abcDEF1234567890_abcDEF1234567890",
};
const niuMasked = maskedEnv(niuExample);
expect("通信牛-counter: ANTHROPIC_AUTH_TOKEN preserved (Layer A intent)", niuMasked.ANTHROPIC_AUTH_TOKEN === "sk-ant-live-example");
expect("通信牛-counter: COMMHUB_TOKEN masked (SECRET_KEYS)", niuMasked.COMMHUB_TOKEN === MASK_PLACEHOLDER);
expect("通信牛-counter: ANET_HUB_TOKEN masked (SECRET_KEYS)", niuMasked.ANET_HUB_TOKEN === MASK_PLACEHOLDER);
expect("通信牛-counter: LOWER_PAT (mixed-case PAT) masked (regex fix)", niuMasked.LOWER_PAT === MASK_PLACEHOLDER);

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
