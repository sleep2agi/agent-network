/**
 * Secret masking for the env handed to the claude-agent-sdk child process.
 *
 * The SDK forks the `claude` binary, which loads ANTHROPIC_AUTH_TOKEN /
 * ANTHROPIC_BASE_URL (it needs them) AND inherits everything else from the
 * parent. The LLM running inside that binary has `Bash` + `Read` + `Glob`
 * tools, so anything in the env table is one `env | grep TOKEN` away from
 * being absorbed into the LLM context and (per Vincent 2026-06-29 UAT)
 * potentially echoed back to the IM user.
 *
 * Strategy: SDK accepts `options.env` (see claude-agent-sdk/sdk.d.ts), so
 * we pass a sanitized copy. We KEEP everything the binary genuinely needs
 * (ANTHROPIC_*, PATH, HOME, USER, NODE_*, LANG, etc.) and STRIP a tight
 * allowlist of values that are pure operator secrets the binary will never
 * use:
 *
 *   By exact key name:
 *     FEISHU_APP_SECRET            — feishu app credential; lark client in
 *                                    the bridge worker holds its own copy,
 *                                    main agent-node + claude binary have
 *                                    no business reading it.
 *     FEISHU_VERIFICATION_TOKEN    — webhook signing secret (future, when
 *                                    HTTP callback mode lands).
 *     FEISHU_ENCRYPT_KEY           — payload encryption key (same).
 *     GH_TOKEN / GITHUB_TOKEN      — PAT for GitHub API; claude has no
 *                                    routine need.
 *     HUB_PASSWORD                 — anet user password seed for hub login.
 *     SLACK_TOKEN / TELEGRAM_TOKEN — other channel creds, same logic.
 *
 *   By value pattern (anti-leak — catches secrets stuffed under unknown
 *   custom names operators picked):
 *     /^ntok_[a-zA-Z0-9_-]{8,}/   — anet network token
 *     /^utok_[a-zA-Z0-9_-]{8,}/   — anet user token
 *     /^github_pat_[A-Z0-9_]{20,}/ — modern fine-grained GitHub PAT
 *     /^ghp_[a-zA-Z0-9]{36}/      — classic GitHub PAT
 *     /^xoxb-[a-zA-Z0-9-]{20,}/   — Slack bot token
 *
 * What's deliberately NOT masked (claude needs them):
 *   ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
 *   OPENAI_API_KEY / DEEPSEEK_API_KEY / MINIMAX_API_KEY / INTERN_S1_API_KEY
 *     — the active vendor key for the resolved model. Could be tightened
 *       per-model but cross-cuts model selection logic; defer.
 *   FEISHU_APP_ID  — public identifier, not a secret (visible to anyone
 *                    who opens the bot in Feishu).
 *
 * NOTE: this masks env passed to the LLM subprocess. It does NOT mask the
 * agent-node parent's own process.env, which is still the source of truth
 * for the feishu worker fork (lark client needs FEISHU_APP_SECRET).
 *
 * NOTE 2: This is Layer A of the Feishu channel hardening. Layers B (path
 * denylist on Bash/Read/Edit/Write/Glob) and C (commhub MCP channel ACL)
 * land in subsequent PRs. Without those, an LLM that explicitly asks for
 * "the FEISHU_APP_SECRET" by name will see `<masked>` here but could still
 * (in principle) ask the operator's claude binary to read /work/.anet/
 * config files. Defense-in-depth — env-mask alone isn't sufficient, but
 * it closes the lowest-effort exfil path (`Bash env | grep TOKEN`).
 */

export const SECRET_KEYS = new Set<string>([
  "FEISHU_APP_SECRET",
  "FEISHU_APP_ID", // public identifier but the claude binary doesn't need it (defense-in-depth, 通信龙 8378d987)
  "FEISHU_VERIFICATION_TOKEN",
  "FEISHU_ENCRYPT_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HUB_PASSWORD",
  // Hub token env var names (通信牛 #326 round 1 — common operator-chosen names
  // for the anet network token that aren't caught by value pattern if the
  // value happens to not match ntok_/utok_/atok_ shape).
  "COMMHUB_TOKEN",
  "ANET_HUB_TOKEN",
  "AUTH_TOKEN",
  "SLACK_TOKEN",
  "TELEGRAM_TOKEN",
  "TELEGRAM_BOT_TOKEN",
]);

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^ntok_[a-zA-Z0-9_-]{8,}/, // anet network token (current)
  /^utok_[a-zA-Z0-9_-]{8,}/, // anet user token (current)
  /^atok_[a-zA-Z0-9_-]{8,}/, // anet admin/legacy token (still accepted by product per 通信牛 #326 round 1)
  /^github_pat_[a-zA-Z0-9_]{20,}/, // GitHub fine-grained PAT (mixed-case — corrected from [A-Z0-9_] which missed real-world casing per 通信牛 review)
  /^ghp_[a-zA-Z0-9]{36}/, // GitHub classic PAT
  /^xoxb-[a-zA-Z0-9-]{20,}/, // Slack bot token
];

export const MASK_PLACEHOLDER = "<masked>";

/**
 * Return a copy of `src` with secrets replaced by `MASK_PLACEHOLDER`.
 *
 * - Stable order: we walk Object.entries(src) once, no shuffling.
 * - Pure: doesn't touch `src` itself.
 * - Empty/undefined values pass through (don't pretend to mask "").
 * - Non-string values (shouldn't happen for ProcessEnv, but defensive)
 *   pass through too — only string values get pattern-matched.
 */
export function maskedEnv(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null) {
      out[k] = v;
      continue;
    }
    if (SECRET_KEYS.has(k)) {
      out[k] = MASK_PLACEHOLDER;
      continue;
    }
    if (typeof v === "string" && v.length > 0) {
      let matched = false;
      for (const p of SECRET_VALUE_PATTERNS) {
        if (p.test(v)) {
          matched = true;
          break;
        }
      }
      if (matched) {
        out[k] = MASK_PLACEHOLDER;
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}
