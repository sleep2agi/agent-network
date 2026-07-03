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
  // RFC-029 PR③ — opencode-cli's per-node auth.json holds the
  // vendor API key (ANTHROPIC_API_KEY or OPENAI_API_KEY). The
  // running opencode agent MUST NOT be able to Read / exfil its
  // own key — same secret-exfil defense as the feishu bot's
  // access.json (see reference feishu-open-channel-secret-exfil).
  // Match anywhere under `.local/share/opencode/auth.json` so we
  // catch both dev and container paths.
  /\/\.local\/share\/opencode\/auth\.json$/,
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
 *   - Literal secret tokens in the command bytes — `ghp_xxx...` /
 *     `github_pat_xxx...` / `ntok_xxx...` / `utok_xxx...` / `atok_xxx...`
 *     / `xoxb-...` / `xoxp-...`. If the LLM has somehow obtained a real
 *     PAT (e.g. via prompt injection where Vincent pasted his own PAT
 *     for the bot to "verify") we don't want it echoed in a `curl -H
 *     "Authorization: Bearer ghp_..."` Bash call. This is a defense
 *     against the bot becoming an outbound exfiltration vector.
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
  // Literal secret tokens — catches the bot being prompted to make an
  // outbound HTTP call carrying a real PAT. Pattern lengths matched to
  // typical token shapes (GitHub PAT: ghp_ + 36 chars; classic PAT min
  // 20; anet ntok_/utok_/atok_ hex; slack tokens xoxb-/xoxp-/xoxa-).
  /\b(ghp_|github_pat_|ntok_|utok_|atok_)[A-Za-z0-9_-]{20,}/,
  /\bxox[bpoars]-[0-9]+-[0-9A-Za-z-]{10,}/,
];

/**
 * Strip one layer of matching shell quotes from a path token. Catches
 * `"/work/.anet/config.json"` and `'/work/.anet/config.json'` so the
 * downstream regex match against READ/WRITE_PATH_DENY actually sees the
 * path bytes. Does not interpret backslash escapes / heredocs / `$()`.
 */
function stripQuotes(s: string): string {
  if (s.length >= 2) {
    if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Resolve `..` segments lexically — `/work/.anet/../.anet/x` → `/work/.anet/x`.
 * Lexical (string-only) so a symlink hiding in the path is NOT resolved
 * here; symlink unwrap is a separate optional step (see `tryRealpath`).
 *
 * Algorithm:
 *  1. Split on `/`; walk segments.
 *  2. `..` pops the previous segment (clamped at root for absolute paths).
 *  3. `.` is dropped.
 *  4. Rejoin with `/`.
 */
function collapseDotDot(p: string): string {
  const absolute = p.startsWith("/");
  const parts = p.split("/").filter((s) => s.length > 0);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      // else: at root, `..` does nothing.
    } else if (part !== ".") {
      out.push(part);
    }
  }
  return (absolute ? "/" : "") + out.join("/");
}

/**
 * Try to resolve a path through `fs.realpathSync` to defeat symlink-based
 * bypasses (eg. `/tmp/innocent` → symlink → `/work/.anet/config.json`).
 *
 * Graceful behavior:
 *  - If realpath fails (ENOENT for Write targets that don't exist yet,
 *    permission denied, etc.) return null — caller falls back to the
 *    lexically-normalized path.
 *  - Wrapped in try/catch so denial logic NEVER throws into the SDK
 *    PreToolUse hook. A failed realpath must not crash the worker.
 *  - Lazy require so the test harness can mock or skip if running in
 *    a Bun environment that resolves the import differently.
 */
function tryRealpath(p: string): string | null {
  try {
    // Resolve all symlinks. Bun + node both support realpathSync.
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Normalize a path token to defeat the obvious bypasses (通信牛
 * #327 round 1 blocker 2 + round 2 dispatch). Performs:
 *
 *  1. Strip one layer of quotes (`"/x"` / `'/x'` → `/x`).
 *  2. Expand leading `~/` → `$HOME` (defaults to `/root` if HOME unset
 *     in the worker env, which is the typical Docker container default).
 *  3. Expand `$HOME` / `${HOME}` literal substrings to the env value.
 *  4. Resolve leading `./` against `cwd` if provided.
 *  5. Collapse repeated `/` (`/work//.anet/...` → `/work/.anet/...`).
 *  6. Collapse `..` and `.` segments lexically — `/work/.anet/../.anet/x`
 *     no longer escapes the denylist.
 *  7. If `resolveSymlinks=true` (default for Read/Write hook), additionally
 *     try `fs.realpathSync` to defeat symlink-based redirects. Falls back
 *     to lexical form if the file doesn't exist or realpath errors.
 *
 * Both the lexical AND (when available) symlink-resolved forms should be
 * checked by callers — `realpath` exists only when the target is on
 * disk, so for Write to a brand-new path the lexical form is what we
 * have. We return both via the sibling `normalizeAllForms` helper.
 *
 * Residual (documented in PR body threat model):
 *  - String-concat assembly inside a python `-c` script (`'/work' +
 *    '/.anet/...'`) — `extractBashPathTokens` doesn't see this; only
 *    `BASH_SENSE_PATTERNS` heuristics can catch it.
 *  - Glob expansion at shell level (`/work/.a*` resolves at exec time).
 *  - base64-encoded path decoded at runtime.
 *  - `eval`/`exec` strings constructed dynamically.
 *  These accept that operator-trust (access.json restriction) is the
 *  outer perimeter; a bubblewrap sandbox follow-up tracks the
 *  irreducible "untrusted user" case.
 */
export function normalizePathForDenyCheck(raw: string, cwd?: string): string {
  let p = stripQuotes(raw);
  const home = (typeof process !== "undefined" && process.env && process.env.HOME) || "/root";
  // ~/foo or just ~  →  $HOME(/foo)?
  if (p === "~") {
    p = home;
  } else if (p.startsWith("~/")) {
    p = home + "/" + p.slice(2);
  }
  // Inline $HOME / ${HOME}.
  p = p.replace(/\$\{?HOME\}?/g, home);
  if (p.startsWith("./") && cwd) {
    p = cwd.replace(/\/+$/, "") + "/" + p.slice(2);
  }
  // Collapse repeated slashes.
  p = p.replace(/\/{2,}/g, "/");
  // Lexical `..` / `.` collapse.
  p = collapseDotDot(p);
  return p;
}

/**
 * Return both the lexical form AND (where resolvable) the realpath form
 * of a path token, so callers can run regex denylist against EITHER.
 * Symlink bypass requires both forms be allowed; lexical-only protection
 * keeps Write-to-new-path working (realpath would ENOENT there).
 */
export function normalizeAllForms(raw: string, cwd?: string): string[] {
  const lex = normalizePathForDenyCheck(raw, cwd);
  const real = tryRealpath(lex);
  if (real && real !== lex) return [lex, real];
  return [lex];
}

/**
 * Extract write-target paths from a Bash command. Catches the common
 * shell write vectors:
 *   - `> /path/to/file` redirect
 *   - `>> /path/to/file` append redirect
 *   - `tee /path/to/file` (with or without -a)
 *   - `cp X /path/to/file` (last positional is destination)
 *   - `mv X /path/to/file`
 *
 * Path tokens may be quoted — `> "/path with spaces"` works.
 *
 * Returns the set of destination paths. Caller normalizes + checks each
 * against `WRITE_PATH_DENY`.
 *
 * NOTE: heredocs / process substitution / eval'd python -c open() write
 * etc. are not covered. The combination of Layer B Bash denylist +
 * deny-by-default on Write/Edit/MultiEdit (which DO go through the hook
 * directly) closes the typical paths; novel eval-style write vectors
 * are accepted residual risk for this PR (see threat-model honesty
 * section in PR body — will be addressed in a B.1 follow-up if a real
 * attack shows up).
 */
export function extractBashWriteTargets(cmd: string): string[] {
  const targets: string[] = [];
  // > path / >> path — the path token after a redirect operator.
  // Path may be unquoted, "double-quoted", or 'single-quoted'.
  const redirRe = /(?<![>])>{1,2}\s*("[^"]+"|'[^']+'|[^\s|;&<>()]+)/g;
  let m: RegExpExecArray | null;
  while ((m = redirRe.exec(cmd)) !== null) targets.push(stripQuotes(m[1]));
  // tee [-a] path (path is first non-flag arg, quoted variants OK)
  const teeRe = /(?<![a-zA-Z0-9_])tee\b(?:\s+-[a-z]+)*\s+("[^"]+"|'[^']+'|[^\s|;&"'`]+)/g;
  while ((m = teeRe.exec(cmd)) !== null) targets.push(stripQuotes(m[1]));
  // cp/mv last positional. Heuristic — only triggers when cp/mv with at
  // least 2 args; we take the LAST non-flag whitespace token.
  const cpMvMatch = cmd.match(/(?<![a-zA-Z0-9_])(cp|mv)\b(.*)/);
  if (cpMvMatch) {
    const tail = cpMvMatch[2].trim();
    const tokens = tail.split(/\s+/).filter((t) => t && !t.startsWith("-"));
    if (tokens.length >= 2) targets.push(stripQuotes(tokens[tokens.length - 1]));
  }
  return targets;
}

/**
 * Extract path-like tokens from a Bash command — used to gate read-side
 * exfil via `cat` / `head` / `grep` / `python -c open()` / etc.
 * (通信牛 #327 round 1 blocker 1).
 *
 * A token counts as a path if it starts with `/` (absolute) OR begins
 * with `./` (relative-to-cwd). We DO NOT try to enumerate every shell
 * read command — instead we look at the path tokens regardless of
 * command, then re-check each against READ_PATH_DENY. So `cat /work/.anet/X`
 * and `python3 -c "open('/work/.anet/X')"` both hit because both
 * contain `/work/.anet/X` as a substring.
 *
 * Quoted paths supported (`"/work/.anet"` matches). Pipeline-joined
 * commands and `&&`/`||`/`;` separators are walked.
 *
 * NOTE residual: a determined attacker can:
 *  - assemble the path from string concat ("'/work' + '/.anet/...'")
 *  - use shell glob expansion (`/work/.a* /conf* .json`)
 *  - hide the path inside base64 then decode at runtime
 * These are NOT covered by this layer — explicit residual, see PR body.
 * For those vectors the operator-trust boundary (access.json restriction
 * to known users only) is the line of defense.
 */
export function extractBashPathTokens(cmd: string): string[] {
  const tokens: string[] = [];
  // Quoted absolute / ~ / $HOME path: "/foo" / '~/foo' / "$HOME/.ssh/x"
  const quotedRe = /("([\/~][^"]*|\$\{?HOME\}?[^"]*)"|'([\/~][^']*|\$\{?HOME\}?[^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = quotedRe.exec(cmd)) !== null) tokens.push(m[2] ?? m[3] ?? "");
  // Bare absolute, relative-to-cwd, ~/-prefixed, or $HOME-prefixed path
  // tokens (no whitespace / shell metachars). The leading negative
  // look-behind ensures we don't pick up `--option=/path` style middles.
  const bareRe = /(?<![a-zA-Z0-9_./~-])((?:\/|\.\/|~\/?|\$\{?HOME\}?)[^\s|;&"'`<>()]*)/g;
  while ((m = bareRe.exec(cmd)) !== null) tokens.push(m[1]);
  return tokens.filter((t) => t.length > 0);
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
    const raw: string = toolInput.file_path || toolInput.pattern || "";
    const globPath: string = toolInput.path || ""; // Glob's search root
    // Normalize so `./.anet/...` (relative to /work cwd), `//` runs,
    // `..` traversal, `~`/`$HOME` expansion all funnel into the literal
    // regex. Also try symlink realpath where the target exists on disk.
    const forms = normalizeAllForms(raw, "/work");
    for (const p of forms) {
      for (const r of READ_PATH_DENY) {
        if (r.test(p)) {
          return {
            deny: true,
            reason: `路径 ${p} 在飞书 channel 受限 (含 secret/config, 不可读)`,
          };
        }
      }
    }
    // Glob: also check the search-root arg (`path`) AND scan the pattern
    // for embedded denied prefixes. `Glob({path:"/work/.anet"})` would
    // otherwise enumerate the denied tree; `Glob({pattern:"/work/.anet/**"})`
    // does it via the pattern. (通信牛 #327 round 1 blocker 3 + round 2.)
    if (toolName === "Glob") {
      if (globPath) {
        const rootForms = normalizeAllForms(globPath, "/work");
        for (const np of rootForms) {
          for (const r of READ_PATH_DENY) {
            if (r.test(np)) {
              return {
                deny: true,
                reason: `Glob 搜索根 ${np} 在飞书 channel 受限 (枚举 secret 树)`,
              };
            }
          }
        }
      }
      // Substring check on the raw pattern (defeats `**/.anet/**` etc.
      // where the literal denied prefix is embedded mid-pattern). The
      // pattern is matched against each DENIED_SUBSTRING string — this
      // is a coarser check than path regex, so kept conservative.
      const pat = (toolInput.pattern || "") as string;
      for (const sub of GLOB_PATTERN_DENY_SUBSTRINGS) {
        if (pat.includes(sub)) {
          return {
            deny: true,
            reason: `Glob 模式包含敏感前缀 (${sub}) — 在飞书 channel 受限`,
          };
        }
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
    const raw: string = toolInput.file_path || "";
    const forms = normalizeAllForms(raw, "/work");
    for (const p of forms) {
      for (const r of WRITE_PATH_DENY) {
        if (r.test(p)) {
          return {
            deny: true,
            reason: `路径 ${p} 在飞书 channel 受限 (config 写保护; 改 access/config 走 anet CLI 或 dashboard)`,
          };
        }
      }
    }
  }

  // Bash: 4-layer check. (通信牛 #327 round 1 blocker 1: previously only
  // env/proc/grep patterns + write-target check were gated, so a direct
  // `cat /work/.anet/config.json` bypassed the Read denylist. Now we
  // ALSO extract path-like tokens from the command and re-check each
  // against the READ + WRITE denylists, in BOTH lexical and realpath
  // forms.)
  if (toolName === "Bash") {
    const cmd: string = toolInput.command || "";
    // (a) command-substring sense patterns (env/printenv/grep TOKEN/$VAR-of-secret
    //     + literal token bytes like `ghp_...` / `ntok_...`)
    for (const r of BASH_SENSE_PATTERNS) {
      if (r.test(cmd)) {
        return {
          deny: true,
          reason: `Bash 命令在飞书 channel 受限 (env/secret 提取模式或 secret literal 字面值)`,
        };
      }
    }
    // (b) path tokens — covers cat/head/tail/less/more/od/xxd/strings/
    //     base64/dd/sed/awk/grep/cp/tar/zip/python -c open()/etc. reads.
    //     Each token's lexical AND (optional) realpath forms are checked
    //     against READ_PATH_DENY.
    for (const raw of extractBashPathTokens(cmd)) {
      for (const t of normalizeAllForms(raw, "/work")) {
        for (const r of READ_PATH_DENY) {
          if (r.test(t)) {
            return {
              deny: true,
              reason: `Bash 读到敏感路径 ${t} 在飞书 channel 受限 (cat/head/grep/python/dd/tar/zip 等任意命令)`,
            };
          }
        }
      }
    }
    // (c) write targets (>, >>, tee, cp, mv last positional) → WRITE deny.
    for (const raw of extractBashWriteTargets(cmd)) {
      for (const t of normalizeAllForms(raw, "/work")) {
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
  }

  return { deny: false };
}

/**
 * Substring fragments that, if present anywhere in a Glob pattern,
 * indicate the pattern is reaching into a denied tree. Kept short and
 * specific — broad fragments (`/etc/`) would false-positive on legit
 * `Glob({pattern: "/etc/hostname"})` style calls.
 */
export const GLOB_PATTERN_DENY_SUBSTRINGS: string[] = [
  "/.anet/",
  "/.anet",
  "/.claude/",
  "/.ssh/",
  "/.env",
  "/proc/self/environ",
];

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
