/**
 * RFC-020 §13 Layer B — channel-aware tool-layer denylist.
 *
 * Layer A (`secret-mask.ts`) sanitizes the env table handed to the claude
 * binary. But Layer A deliberately keeps `ANTHROPIC_AUTH_TOKEN` (the SDK
 * needs it to auth the vendor call) and can't help with secrets that the
 * operator has placed in config files on disk. Layer B closes those gaps
 * by intercepting the LLM's PreToolUse hook and denying tool calls that
 * would reach secret-bearing paths or run secret-extracting commands.
 *
 * Threat surface this layer covers:
 *
 *  1. `cat /proc/self/environ` → reads the claude binary's env, which
 *     includes ANTHROPIC_AUTH_TOKEN.
 *  2. `cat /proc/<other>/environ` → reads the agent-node parent's env,
 *     which still has FEISHU_APP_SECRET / ntok_ / etc. (Layer A didn't
 *     touch parent env, only what's passed to the child).
 *  3. `Bash env`, `Bash printenv` → dumps the (now-masked) env, but any
 *     ANTHROPIC_* / OPENAI_* / etc. that Layer A intentionally preserved
 *     would still come through.
 *  4. `Read /work/.anet/** /config.json` → exfiltrates the hub `ntok_`
 *     written to disk (Layer A can't help — secret is in a file, not
 *     in env).
 *  5. `Read *.env` / `Read ~/.ssh/**` → assorted operator secrets.
 *  6. `Edit /work/.anet/** /channels/feishu/access.json` → privilege
 *     escalation. 2026-06-29 Vincent UAT caught: the bot received a
 *     legit-seeming DM ("restrict allowFrom to just me") and Edit'd its
 *     own access.json. An attacker could send the inverse ("add my
 *     open_id to allowFrom") and get past the access whitelist.
 *  7. `Bash echo X > /work/.anet/**` redirect-target → same write-side
 *     concern through a different vector. Catches the `>`, `>>`, `tee`
 *     argument paths.
 *
 * Scope discipline: this layer is applied ONLY when the current turn
 * originates from the feishu channel. Other channels (commhub-internal
 * task delivery, /loop wakeups, telegram) keep full tool access — those
 * surfaces aren't reachable by external users in the same way and the
 * agent-network design assumes operator trust on the commhub side.
 *
 * Channel context propagation: the cli.ts think() function receives a
 * `from` string ("feishu:...", "commhub:...", "telegram:...", etc.) and
 * stamps it onto the PreToolUse hook closure so the deny logic can read
 * it. No AsyncLocalStorage needed for Layer B — Layer C (commhub MCP
 * ACL) will introduce ALS for its own reasons.
 *
 * deny != crash: when a tool call is denied we return
 * `{ continue: false, stopReason: "..." }` so the SDK shows the agent a
 * "tool denied: <reason>" message instead of throwing an exception. The
 * agent then gets a chance to explain to the user that it can't do X.
 * Far better UX than a silent worker crash.
 */

/**
 * Path patterns that hold secrets — agent cannot READ them via Read,
 * Glob, or Bash (`cat`/`less`/`head`/etc.). Write-side denylist is a
 * separate strict superset; see `WRITE_PATH_DENY`.
 */
export const READ_PATH_DENY: RegExp[] = [
  // anet local config — node config.json, channel access.json, goals.json,
  // all .env files, hub session tokens, audit logs.
  /^\/work\/\.anet(\/|$)/,
  // claude binary's own session jsonl files (operator conversation history).
  /^\/root\/\.claude(\/|$)/,
  /^\/home\/[^/]+\/\.claude(\/|$)/,
  // env files anywhere — .env / .env.local / production.env / anet.env / etc.
  // Match the `.env` extension token followed by either a variant suffix
  // (`.env.local`), end-of-string, or `/`. Doesn't require leading `/` so
  // `anet.env` and `production.env` get caught too. Doesn't fire on words
  // like "myenvironment.log" (no `.env` substring at all).
  /\.env(\.|$|\/)/,
  // SSH keys.
  /^\/home\/[^/]+\/\.ssh(\/|$)/,
  /^\/root\/\.ssh(\/|$)/,
  // /etc passwords + shadow file (defense vs root containers).
  /^\/etc\/shadow$/,
  /^\/etc\/passwd$/,
  // /proc/*/environ — reads any process's env including agent-node parent
  // which still holds the full secret zoo (Layer A only masked the child
  // env). Self (`/proc/self/environ`) is the claude binary's env which
  // contains ANTHROPIC_AUTH_TOKEN; sibling proc reads can expose the
  // feishu worker's FEISHU_APP_SECRET + the parent's hub ntok_.
  /^\/proc\/[^/]+\/environ$/,
];

/**
 * Path patterns where Write/Edit/MultiEdit are denied. Superset of READ
 * deny (everything we don't let you read, you definitely don't let you
 * write) plus the specific anet config files where write = privilege
 * escalation.
 */
export const WRITE_PATH_DENY: RegExp[] = [
  ...READ_PATH_DENY,
  // channel access.json — the access whitelist itself. bot must NOT be
  // able to add open_ids to allowFrom even if a user DMs it asking to.
  /^\/work\/\.anet\/nodes\/[^/]+\/channels\/[^/]+\/access\.json$/,
  // node config.json — hub URL, ntok_, runtime, model, session.
  /^\/work\/\.anet\/nodes\/[^/]+\/config\.json$/,
  // goals.json — would let bot reschedule its own /loop targets.
  /^\/work\/\.anet\/nodes\/[^/]+\/goals\.json$/,
];

/**
 * Bash command-substring patterns that exfiltrate secrets. Cover:
 *
 *   - `env` / `printenv` direct dumps (Layer A masked secret values from
 *     the child env, but any preserved ANTHROPIC_* /etc. would still
 *     dump). Also catches `env|grep TOKEN` and `env > file`.
 *   - `/proc/* /environ` indirect reads via `cat`/`head`/`od`/etc.
 *   - `grep TOKEN/SECRET/KEY/PASSWORD` over any input — catches attempts
 *     to extract from files even if the file path itself wasn't on the
 *     denylist.
 *   - `$TOKEN_VAR` / `${SECRET_VAR}` expansion in command — catches
 *     attempts to interpolate secret env values into echo / curl.
 *
 * Word-boundary anchors prevent false-positive matches on incidental
 * substrings (e.g. "environment variable" doesn't trigger the env
 * pattern; only `env ` / `env|` / `env;` / `env$` do).
 */
export const BASH_SENSE_PATTERNS: RegExp[] = [
  // env command (alone or piped/redirected, not "env-vars" prose). The
  // left-anchor `(^|[;|&\s(/])` matches start-of-string OR a shell-token
  // boundary OR `/` (so absolute-path invocations `/usr/bin/env` count).
  /(^|[;|&\s(/])env(\s|$|[|&;>])/,
  // printenv — `\b` boundary handles both `printenv` and `/usr/bin/printenv`.
  // `printenvironment` (longer word) is excluded by the trailing `\b`.
  /\bprintenv\b/,
  // /proc/<pid>/environ reads
  /\/proc\/[^/\s]+\/environ\b/,
  // grep over TOKEN/SECRET/KEY/PASSWORD
  /\bgrep\b[^|;]*\b(TOKEN|SECRET|KEY|PASSWORD|API_KEY|AUTH)\b/i,
  // $VAR or ${VAR} where VAR contains TOKEN/SECRET/KEY/PASSWORD/AUTH
  /\$\{?[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD|AUTH)/i,
];

/**
 * Extract write-target paths from a Bash command. Catches the common
 * shell write vectors:
 *   - `> /path/to/file` redirect
 *   - `>> /path/to/file` append redirect
 *   - `tee /path/to/file` (with or without -a)
 *   - `cp X /path/to/file` (last positional is destination)
 *   - `mv X /path/to/file`
 *
 * Returns the set of destination paths. Caller checks each against
 * `WRITE_PATH_DENY`.
 *
 * NOTE: heredocs / process substitution / eval'd python -c open() write
 * etc. are not covered. The combination of Layer B Bash denylist +
 * deny-by-default on Write/Edit/MultiEdit (which DO go through the hook
 * directly) closes the typical paths; novel eval-style write vectors
 * are accepted residual risk for this PR (will be addressed in a B.1
 * follow-up if a real attack shows up).
 */
export function extractBashWriteTargets(cmd: string): string[] {
  const targets: string[] = [];
  // > path / >> path — the path token after a redirect operator.
  // We match >= 1 whitespace, then one path token (no spaces, no quote).
  const redirRe = /(?<![>])>{1,2}\s+([^\s|;&"'`]+)/g;
  let m: RegExpExecArray | null;
  while ((m = redirRe.exec(cmd)) !== null) targets.push(m[1]);
  // tee [-a] path (path is first non-flag arg)
  const teeRe = /(?<![a-zA-Z0-9_])tee\b(?:\s+-[a-z]+)*\s+([^\s|;&"'`]+)/g;
  while ((m = teeRe.exec(cmd)) !== null) targets.push(m[1]);
  // cp/mv last positional. Heuristic — only triggers when cp/mv with at
  // least 2 args; we take the LAST non-flag whitespace token.
  const cpMvMatch = cmd.match(/(?<![a-zA-Z0-9_])(cp|mv)\b(.*)/);
  if (cpMvMatch) {
    const tail = cpMvMatch[2].trim();
    const tokens = tail.split(/\s+/).filter((t) => t && !t.startsWith("-"));
    if (tokens.length >= 2) targets.push(tokens[tokens.length - 1]);
  }
  return targets;
}

export type ToolDenyDecision =
  | { deny: false }
  | { deny: true; reason: string };

/**
 * Commhub MCP tools — denied wholesale on feishu turns (2026-06-29
 * Vincent UAT catch: the bot was leaking commhub-protocol vocabulary
 * ("用 send_task 回复" / "已发送 task_id ..." / "alias_not_found")
 * INTO the user-facing feishu chat). Feishu replies travel back through
 * the bridge worker (adapter.send), NOT through commhub. The bot has
 * no legitimate reason to call commhub tools while processing a feishu
 * message — every such call is at minimum noise, at worst a horizontal
 * `commhub_send_task` to an arbitrary alias.
 *
 * Future-proof — defensively prefix-match: any tool name starting with
 * `mcp__commhub__` is denied. Catches commhub_send_task /
 * commhub_send_message / commhub_get_all_status / commhub_report_status
 * / commhub_reply explicitly + any future commhub MCP additions.
 *
 * If a future use case really needs feishu-side commhub access (e.g.
 * "@bot please ping agent X with my message"), Layer D config
 * (`commhubSendTaskAllow` per-channel allowlist) provides a single
 * override surface; this default-deny stays.
 */
function isCommhubMcpTool(toolName: string): boolean {
  return typeof toolName === "string" && toolName.startsWith("mcp__commhub__");
}

/**
 * Decide whether a single tool call should be denied. Returns
 * `{deny: false}` to allow the call; `{deny: true, reason}` to block
 * it with a user-visible explanation.
 *
 * Applied ONLY when channel is "feishu" — caller is responsible for
 * gating (see cli.ts PreToolUse hook).
 */
export function checkFeishuToolDeny(
  toolName: string,
  toolInput: any,
): ToolDenyDecision {
  // Commhub MCP mass-deny — first because the toolInput shape doesn't
  // matter for these (we reject regardless of params).
  if (isCommhubMcpTool(toolName)) {
    return {
      deny: true,
      reason: `工具 ${toolName} 在飞书 channel 不可用 (飞书消息走 bridge 直接回, 不经 commhub; 内部协作机制不暴露给用户)`,
    };
  }

  if (!toolInput || typeof toolInput !== "object") return { deny: false };

  // Read-side: Read / Glob over secret-bearing paths.
  if (toolName === "Read" || toolName === "Glob") {
    const p: string = toolInput.file_path || toolInput.pattern || "";
    for (const r of READ_PATH_DENY) {
      if (r.test(p)) {
        return {
          deny: true,
          reason: `路径 ${p} 在飞书 channel 受限 (含 secret/config, 不可读)`,
        };
      }
    }
  }

  // Write-side: Write / Edit / MultiEdit / NotebookEdit over secret/config paths.
  if (
    toolName === "Write" ||
    toolName === "Edit" ||
    toolName === "MultiEdit" ||
    toolName === "NotebookEdit"
  ) {
    const p: string = toolInput.file_path || "";
    for (const r of WRITE_PATH_DENY) {
      if (r.test(p)) {
        return {
          deny: true,
          reason: `路径 ${p} 在飞书 channel 受限 (config 写保护; 改 access/config 走 anet CLI 或 dashboard)`,
        };
      }
    }
  }

  // Bash: command-substring deny (env/printenv/proc-environ/grep TOKEN/$VAR-of-secret)
  // PLUS redirect-target check (>/>> /tee /cp/mv arg landing in WRITE deny).
  if (toolName === "Bash") {
    const cmd: string = toolInput.command || "";
    for (const r of BASH_SENSE_PATTERNS) {
      if (r.test(cmd)) {
        return {
          deny: true,
          reason: `Bash 命令在飞书 channel 受限 (env/secret 提取模式)`,
        };
      }
    }
    // Also check Bash redirect/copy targets against WRITE_PATH_DENY.
    const targets = extractBashWriteTargets(cmd);
    for (const t of targets) {
      for (const r of WRITE_PATH_DENY) {
        if (r.test(t)) {
          return {
            deny: true,
            reason: `Bash 写目标 ${t} 在飞书 channel 受限 (config/secret 写保护)`,
          };
        }
      }
    }
  }

  return { deny: false };
}

/**
 * Decide whether the current channel should run with Layer B denylist
 * applied. `from` is the prefix string cli.ts uses to track the source
 * of a turn ("feishu:dm:oc_...", "feishu:group:oc_...", "commhub:...",
 * "telegram:...", "/loop", etc.). Only the feishu surface is gated here
 * — commhub/loop/telegram are operator-trusted.
 */
export function isFeishuChannelTurn(from: string | undefined): boolean {
  if (!from) return false;
  return from.startsWith("feishu:");
}
