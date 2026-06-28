// MIRROR of agent-node/src/util/access-resolve.ts. Both files MUST stay
// in lockstep — diff them when editing either copy. Bun workspaces are
// not currently set up across the agent-node / agent-network packages,
// so the v0.11 security fix duplicates the helper to give feishu the
// same fail-mode shape as telegram. v0.12 follow-up: extract into a
// real shared package and dedupe.
//
// Inbound-channel access resolver. Shared by every IM channel that
// agent-node consumes (telegram / feishu / wechat / future). One file
// owns the "should this incoming message be allowed?" decision so the
// fail-mode (open vs closed) is identical across channels.
//
// Why fail-closed (the v0.11 change)
// ==================================
// Pre-v0.11, `telegramAllowed()` treated an empty `allowFrom` as
// allow-all. Combined with the default `dangerouslySkipPermissions`
// flag in `flags.json`, that meant a node whose access.json had been
// truncated / corrupted / wiped (the 2026-06 git-stash-u + git-clean-fd
// incident shape, see CLAUDE.md history) would silently accept commands
// from any Telegram user on the internet and drive the local Claude
// runtime with full skip-permissions. That is a remote-execution
// vector and must default to denying, not allowing.
//
// The new contract is symmetrical with the feishu adapter, which has
// always been fail-closed: only an explicit `"*"` wildcard opens the
// door, and any other empty / missing / malformed shape denies with a
// loud reason string suitable for `anet logs <alias>` triage.
//
// Pure helper: no I/O, no env reads, no side effects. The boot path is
// responsible for emitting the one-shot warn when an empty allowFrom
// is observed.

/**
 * Tiny loader that mirrors what `initTelegramChannel` does at boot —
 * read the parsed access.json blob and produce both the raw allowFrom
 * payload (handed to the resolver verbatim) AND a boot-time warning
 * string for the empty / malformed case.
 *
 * Extracted so wiring-level regression tests (e.g. "channel state
 * built from `{allowFrom: [123]}` MUST fail-closed when a message
 * arrives") run without spinning up a real telegram channel + fs
 * mocks. The previous bug — `.map(String)` rewriting [123] into
 * ["123"] at init time — slipped past resolver-only unit tests
 * because the resolver never saw the offending shape; the channel
 * state did.
 */
export interface LoadedTelegramAccess {
  /** Raw value from access.json — handed verbatim to resolveTelegramAccess. */
  allowFromRaw: unknown;
  /** Boot-time warning string when allowFrom is empty / malformed; null otherwise. */
  bootWarn: string | null;
}

export function loadTelegramAccess(opts: {
  channelDir: string;
  parsedAccess: { allowFrom?: unknown } | null | undefined;
}): LoadedTelegramAccess {
  const allowFromRaw = opts.parsedAccess?.allowFrom;
  const bootWarn = buildEmptyAllowlistWarn({
    channel: "telegram",
    channelDir: opts.channelDir,
    allowFrom: allowFromRaw,
  });
  return { allowFromRaw, bootWarn };
}

/**
 * Discriminated reason for an access decision. Callers can switch on
 * `kind` for routing (e.g. `empty-fail-closed` warrants a louder boot
 * warning than a simple `denied` mid-stream).
 */
export type AccessKind =
  | "wildcard-allow"      // explicit "*" in allowFrom
  | "explicit-allow"      // sender id / username matched the list
  | "empty-fail-closed"   // allowFrom is empty / missing / malformed
  | "denied";             // allowFrom present but sender not in it

export interface AccessDecision {
  allow: boolean;
  kind: AccessKind;
  /** Short, machine-readable reason for logging. */
  reason: string;
}

/**
 * Normalise an allowFrom input into a deduped string[] suitable for
 * the lookup checks. Accepts: a real string[] (the happy case), null /
 * undefined (treated as empty), a non-array shape (defensive — treated
 * as empty + reason surfaced).
 */
export function normalizeAllowFrom(raw: unknown): {
  list: string[];
  malformed: boolean;
} {
  if (Array.isArray(raw)) {
    const list = raw
      .filter((v) => typeof v === "string" && v.length > 0)
      .map((v) => String(v));
    return { list, malformed: false };
  }
  if (raw === undefined || raw === null) {
    return { list: [], malformed: false };
  }
  // Some other shape on disk (numeric, object, string). Treat as
  // empty AND flag it so the caller can include "malformed" in the
  // boot warning. This is the "corrupted access.json" path.
  return { list: [], malformed: true };
}

/**
 * Resolve whether an inbound Telegram message should be processed.
 *
 * Fail-closed: empty / missing / malformed `allowFrom` always denies.
 * Wildcard `"*"` always allows. Otherwise the sender's id OR username
 * (after non-empty check) must match a list entry.
 *
 * @param opts.allowFrom         the access.json `allowFrom` array
 * @param opts.senderId          numeric Telegram user id as string
 *                               (callers already coerce; we trust)
 * @param opts.senderUsername    optional `@username` (no `@` prefix)
 */
export function resolveTelegramAccess(opts: {
  allowFrom: unknown;
  senderId: string;
  senderUsername?: string | null;
}): AccessDecision {
  const { list, malformed } = normalizeAllowFrom(opts.allowFrom);

  if (list.length === 0) {
    return {
      allow: false,
      kind: "empty-fail-closed",
      reason: malformed
        ? "allowFrom malformed (not a string[]) — fail-closed"
        : "allowFrom empty — fail-closed (set [\"*\"] to open to all, or add specific ids)",
    };
  }

  if (list.includes("*")) {
    return { allow: true, kind: "wildcard-allow", reason: "allowFrom=[\"*\"]" };
  }

  const id = opts.senderId || "";
  const username = (opts.senderUsername || "").trim();
  if (id && list.includes(id)) {
    return { allow: true, kind: "explicit-allow", reason: `sender id ${id} in allowFrom` };
  }
  if (username && list.includes(username)) {
    return { allow: true, kind: "explicit-allow", reason: `sender username ${username} in allowFrom` };
  }
  return {
    allow: false,
    kind: "denied",
    reason: `sender id=${id} username=${username || "(none)"} not in allowFrom`,
  };
}

/**
 * Resolve whether an inbound Feishu/Lark event should be processed.
 *
 * Same fail-closed contract as telegram. DM path checks `allowFrom`;
 * group path checks `allowChats` first, then `groupPolicy` decides
 * whether listed chats trigger the agent (`all` → trigger any message;
 * `observe` → never trigger; `mention` → only on @-mention — caller
 * still has to honour that flag, this helper just returns allow=true).
 *
 * @param opts.conversationType  "dm" | "group" | "channel" | "thread"
 * @param opts.allowFrom         access.json `allowFrom` array
 * @param opts.allowChats        access.json `allowChats` array
 * @param opts.senderId          feishu open_id of the sender
 * @param opts.conversationId    feishu chat_id of the conversation
 * @param opts.groupPolicy       "all" | "mention" | "observe"
 */
export function resolveFeishuAccess(opts: {
  conversationType: "dm" | "group" | "channel" | "thread" | string;
  allowFrom: unknown;
  allowChats: unknown;
  senderId: string;
  conversationId: string;
  groupPolicy: "all" | "mention" | "observe" | string;
}): AccessDecision {
  if (opts.conversationType === "dm") {
    const { list, malformed } = normalizeAllowFrom(opts.allowFrom);
    if (list.length === 0) {
      return {
        allow: false,
        kind: "empty-fail-closed",
        reason: malformed
          ? "allowFrom malformed (not a string[]) — fail-closed (dm)"
          : "allowFrom empty — fail-closed (dm)",
      };
    }
    if (list.includes("*")) {
      return { allow: true, kind: "wildcard-allow", reason: "allowFrom=[\"*\"] (dm)" };
    }
    if (opts.senderId && list.includes(opts.senderId)) {
      return { allow: true, kind: "explicit-allow", reason: `sender ${opts.senderId} in allowFrom (dm)` };
    }
    return {
      allow: false,
      kind: "denied",
      reason: "sender not in allowFrom (dm)",
    };
  }

  // Non-DM (group / channel / thread): allowChats gates entry, then
  // groupPolicy decides whether to actually trigger.
  const chats = normalizeAllowFrom(opts.allowChats);
  if (chats.list.length === 0) {
    return {
      allow: false,
      kind: "empty-fail-closed",
      reason: chats.malformed
        ? "allowChats malformed — fail-closed (group)"
        : "allowChats empty — fail-closed (group)",
    };
  }
  const chatAllowed =
    chats.list.includes("*") || chats.list.includes(opts.conversationId);
  if (!chatAllowed) {
    return { allow: false, kind: "denied", reason: "chat not in allowChats" };
  }
  if (opts.groupPolicy === "all") {
    return { allow: true, kind: "explicit-allow", reason: "chat in allowChats + groupPolicy=all" };
  }
  if (opts.groupPolicy === "observe") {
    return {
      allow: false,
      kind: "denied",
      reason: "groupPolicy=observe — chat allowlisted but no trigger",
    };
  }
  // "mention" (or any other future flag): caller decides at message-
  // inspect time. Here we just say "chat is allowed, caller's call".
  return { allow: true, kind: "explicit-allow", reason: `chat allowed + groupPolicy=${opts.groupPolicy}` };
}

/**
 * Build the boot-time warning string when a channel starts with an
 * empty / malformed allowlist. Caller emits this via `warn()` once at
 * startup so operators see the fail-closed posture immediately rather
 * than discovering it the first time a message gets denied.
 *
 * Returns `null` when the allowlist has at least one entry (no boot
 * warning needed).
 */
export function buildEmptyAllowlistWarn(opts: {
  channel: string;           // "telegram" | "feishu" | etc.
  channelDir: string;        // absolute path to access.json's parent
  allowFrom: unknown;
}): string | null {
  const { list, malformed } = normalizeAllowFrom(opts.allowFrom);
  if (list.length > 0) return null;
  const detail = malformed ? "malformed (not a string[])" : "empty";
  return (
    `[${opts.channel}] FAIL-CLOSED: ${opts.channelDir}/access.json allowFrom is ${detail} — ` +
    `ALL inbound messages will be denied. To open the channel: edit access.json ` +
    `and set \`"allowFrom": ["*"]\` for any-sender, or add specific sender ids. ` +
    `Pre-v0.11 behaviour was fail-open; this is a deliberate security change ` +
    `(see release notes).`
  );
}
