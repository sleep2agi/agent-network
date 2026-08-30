// RFC-024 — node-side config apply runtime.
//
// Called by cli.ts when an SSE `{type:"config_update"}` or
// `{type:"restart"}` doorbell arrives. Pulls the patch from hub via the
// commhub MCP tool, validates locally (defense-in-depth against hub
// validator drift), then routes to one of three paths per
// `apply_mode`:
//   - "hot"          → atomic write file + update in-process mutable
//                      flags obj + ack applied immediately (zero restart)
//   - "restart"      → atomic write file + .prev backup + drain
//                      in-flight think + ack restarting + exit(75)
//   - "restart_only" → no file write, drain + ack restarting + exit(75)
//
// Pure-ish module: pulls in MCP client lazily, exposes the validator
// as a top-level pure helper so unit tests don't need a real hub. The
// exit(75) is gated behind an injected `exit` hook so tests can verify
// the path without terminating the test runner.

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

/** Sentinel exit code for "supervisor please restart me with the new
 * config" — borrows BSD EX_TEMPFAIL semantics. The parent supervisor
 * (W1, see launchAgent wrap) keys on this exact code to differentiate
 * restart-intent from a fatal exit. */
export const RESTART_SENTINEL = 75;

/** Defense-in-depth local validation. Same allowlist as hub but
 * intentionally duplicated — if hub validator drifts loose, the node
 * still refuses anything outside this set.
 *
 * NB on teammateMode (dropped from P1 scope per #290 review):
 *   The dashboard schema in RFC-024 §4 originally listed teammateMode
 *   as one of the 6 dashboard-editable flags. Investigation found
 *   teammateMode is ONLY consumed by `claude-code-cli` runtime via
 *   agent-network/bin/cli.ts (passed as --teammate-mode CLI arg at
 *   spawn). The agent-node-driven runtimes (claude-agent-sdk /
 *   codex-sdk / grok-build-acp) that PR B's config-apply runtime
 *   targets do NOT consume it. Including it in the allowlist would
 *   silently ack `applied` for changes that have zero effect — same
 *   class of issue as BLOCKER 2 (budget/timeout schema mismatch).
 *   P2 to add a claude-code-cli config-apply path.
 */
const ALLOWED_FLAGS = new Set<string>([
  "permissionMode",
  "dangerouslySkipPermissions",
  "maxTurns",
  "budget",
  "timeout",
]);

const RESTART_REQUIRED_FLAGS = new Set<string>([
  "permissionMode",
  "dangerouslySkipPermissions",
  "timeout",
]);

/**
 * Channel keys the dashboard may enable/disable on this node via
 * update_node_config. Restart-tier — the boot flow in cli.ts reads
 * `config.channels` once and forks per-channel workers from it, so a
 * swap here takes effect the next time the parent supervisor respawns
 * this process (see #260 P5). MUST match server/src/config-apply-
 * validate.ts EDITABLE_CHANNELS.
 *
 * Only telegram + feishu are wired here: cli.ts:673 rejects any other
 * channel type with `process.exit(1)` at boot, so accepting anything
 * else in a patch would ship a "smuggle-a-crash" foot-gun. `commhub`
 * is the RPC transport (always present, not a channel worker).
 */
const EDITABLE_CHANNELS = new Set<string>([
  "telegram",
  "feishu",
]);

export type ApplyMode = "hot" | "restart" | "restart_only";

export interface ConfigPatch {
  model?: string;
  flags?: Record<string, unknown>;
  /** #260 P5 — dashboard-driven channel enable/disable. Restart-tier
   *  (agent-node boot forks channel workers from config.channels).
   *  Only telegram / feishu / commhub keys are accepted here; anything
   *  else is dropped by the hub before the patch reaches this node. */
  channels?: string[];
}

export interface ConfigUpdate {
  update_id: string;
  patch: ConfigPatch;
  apply_mode: ApplyMode;
  base_revision: number;
}

/** Validation outcome. `null` = pass; otherwise the rejection envelope. */
export type ValidationResult = { field: string; reason: string } | null;

export function validateLocalPatch(patch: ConfigPatch): ValidationResult {
  if (patch.model !== undefined) {
    if (typeof patch.model !== "string" || patch.model.length === 0 || patch.model.length > 200) {
      return { field: "model", reason: "must be a non-empty string ≤ 200 chars" };
    }
  }
  if (patch.channels !== undefined) {
    if (!Array.isArray(patch.channels)) {
      return { field: "channels", reason: "must be an array of strings" };
    }
    if (patch.channels.length > 16) {
      return { field: "channels", reason: "too many entries (max 16)" };
    }
    for (const c of patch.channels) {
      if (typeof c !== "string") {
        return { field: "channels", reason: "must contain only strings" };
      }
      if (!EDITABLE_CHANNELS.has(c)) {
        return { field: `channels.${c}`, reason: "not in local editable channels allowlist" };
      }
    }
  }
  const flags = patch.flags || {};
  for (const [key, val] of Object.entries(flags)) {
    if (!ALLOWED_FLAGS.has(key)) {
      return { field: `flags.${key}`, reason: "not in local allowlist" };
    }
    switch (key) {
      case "permissionMode":
        if (
          typeof val !== "string" ||
          !["default", "auto", "bypassPermissions", "acceptEdits", "plan"].includes(val)
        ) {
          return { field: "flags.permissionMode", reason: "invalid enum" };
        }
        break;
      case "dangerouslySkipPermissions":
        if (typeof val !== "boolean") return { field: `flags.${key}`, reason: "must be boolean" };
        break;
      case "maxTurns":
        if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 10000) {
          return { field: "flags.maxTurns", reason: "must be int in [0, 10000]" };
        }
        break;
      case "budget":
        if (typeof val !== "number" || val < 0 || val > 1_000_000) {
          return { field: "flags.budget", reason: "must be number in [0, 1_000_000]" };
        }
        break;
      case "timeout":
        if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 3_600_000) {
          return { field: "flags.timeout", reason: "must be int ms in [0, 3_600_000]" };
        }
        break;
    }
  }
  return null;
}

/** Classify whether a patch needs restart vs hot apply. Empty patch
 * → "restart_only" (used by restart_node tool). Mirrors hub helper —
 * see config-apply-validate.ts. */
export function computeApplyMode(patch: ConfigPatch): ApplyMode {
  const hasModel = patch.model !== undefined;
  const flags = patch.flags || {};
  const flagKeys = Object.keys(flags);
  const hasChannels = patch.channels !== undefined;
  if (!hasModel && flagKeys.length === 0 && !hasChannels) return "restart_only";
  if (hasModel) return "restart";
  if (hasChannels) return "restart";
  for (const key of flagKeys) {
    if (RESTART_REQUIRED_FLAGS.has(key)) return "restart";
  }
  return "hot";
}

/** Atomic JSON write — temp + rename. Mirrors writeAccessJsonAtomic
 * in agent-network/bin/cli.ts (PR #261 P0-1 catch). Crash-safe; on
 * Ctrl-C / disk-full / concurrent write the target file is never
 * left half-written.
 *
 * Cleans up the tmp file on either write or rename failure so a
 * disk-full event doesn't leak `.tmp.<pid>.<ts>` litter every retry
 * (caught by cross-agent review on PR B).
 */
export function atomicWriteJson(path: string, data: unknown): void {
  atomicWritePrivateText(path, JSON.stringify(data, null, 2) + "\n");
}

export function atomicWritePrivateText(path: string, body: string): void {
  const parent = dirname(path);
  repairPrivateDirectory(parent, isManagedAnetDirectory(parent));
  const tmp = join(parent, `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(fd, body, "utf8");
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Only Agent Network-owned state below a literal `.anet` path component has
 * a product contract that its directory is private. `--config` is a public
 * flag and may point at `$HOME/agent.json`, a project checkout, or another
 * operator-owned directory; changing that parent to 0700 would be a
 * destructive, surprising side effect. Files are still repaired/written as
 * 0600 everywhere, but directory tightening is scoped to managed state.
 */
function isManagedAnetDirectory(path: string): boolean {
  return resolve(path).split(sep).includes(".anet");
}

function repairPrivateDirectory(path: string, tightenMode: boolean): void {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`private config refuses non-directory or linked parent: ${path}`);
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    const uid = process.getuid?.();
    if (!opened.isDirectory()
      || (uid !== undefined && opened.uid !== uid)
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`private config parent is not owner-controlled: ${path}`);
    }
    if (tightenMode && posixFileModesSupported()) fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
}

/**
 * POSIX 文件模式位（0600/0700）在这个平台上有没有意义。
 *
 * 🔴 Windows 的 NTFS 走 ACL，没有 mode 位；`fchmod` 直接 EPERM，
 *    实测报错是 `Refusing unsafe global config: EPERM: operation not permitted, fchmod`。
 *    ⇒ 在那里跳过的只有【收紧模式位】这一个动作；
 *      symlink / nlink / 正规文件 / dev+ino 一致 / uid 这些校验**一条都不放过**。
 *      把它们一起跳掉会把这个函数变成恒真的空壳。
 */
function posixFileModesSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/** Tighten legacy umask-derived config state before reading any token. */
export function repairPrivateConfigPermissions(path: string): void {
  if (!existsSync(path) && !existsSync(`${path}.prev`)) return;
  const parent = dirname(path);
  repairPrivateDirectory(parent, isManagedAnetDirectory(parent));
  for (const candidate of [path, `${path}.prev`]) {
    if (!existsSync(candidate)) continue;
    const before = lstatSync(candidate);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      throw new Error(`private config refuses linked or non-regular file: ${candidate}`);
    }
    const fd = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = fstatSync(fd);
      const uid = process.getuid?.();
      if (!opened.isFile() || opened.nlink !== 1
        || (uid !== undefined && opened.uid !== uid)
        || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error(`private config is not owner-controlled: ${candidate}`);
      }
      if (posixFileModesSupported()) fchmodSync(fd, 0o600);
    } finally { closeSync(fd); }
  }
}

/** Copy the current config to a .prev sidecar so a restart can roll
 * back if the new config wedges the node. Tolerates a missing
 * config (first-write case) — caller handles. */
export function backupConfigPrev(path: string): { backedUp: boolean } {
  if (!existsSync(path)) return { backedUp: false };
  atomicWritePrivateText(`${path}.prev`, readFileSync(path, "utf8"));
  return { backedUp: true };
}

/** Boot self-heal — read config.json, on parse / validate fail try
 * the .prev sidecar. Returns the loaded config + a flag describing
 * which path produced it. Throws only if BOTH primary and .prev are
 * unusable (truly bricked — surfaced for caller to log + exit). */
export interface SelfHealOutcome {
  config: any;
  source: "primary" | "prev";
  primaryError?: string;
}
export function loadConfigWithSelfHeal(path: string): SelfHealOutcome {
  let primaryError: string | undefined;
  try {
    const txt = readFileSync(path, "utf-8");
    const parsed = JSON.parse(txt);
    return { config: parsed, source: "primary" };
  } catch (e: any) {
    primaryError = String(e?.message || e);
  }
  // Primary failed — try .prev.
  const prevPath = `${path}.prev`;
  if (!existsSync(prevPath)) {
    throw new Error(`config.json parse failed (${primaryError}) and no .prev backup exists`);
  }
  try {
    const prevTxt = readFileSync(prevPath, "utf-8");
    const prevParsed = JSON.parse(prevTxt);
    // Recovery: copy .prev back to primary so the next boot uses it.
    atomicWritePrivateText(path, prevTxt);
    return { config: prevParsed, source: "prev", primaryError };
  } catch (e: any) {
    throw new Error(
      `config.json parse failed (${primaryError}); .prev parse also failed (${String(e?.message || e)})`,
    );
  }
}

/** Parse a channel spec into its bare type key. Mirrors
 * `parseChannelSpec` in cli.ts but only extracts the type — the caller
 * doesn't need the path. Malformed specs (empty, starts with `:`, ends
 * with `:`) return null so mergePatch can drop them defensively rather
 * than propagate the corruption. */
function channelSpecType(spec: unknown): string | null {
  if (typeof spec !== "string") return null;
  const sep = spec.indexOf(":");
  if (sep < 0) return spec || null;
  if (sep === 0 || sep === spec.length - 1) return null;
  return spec.slice(0, sep);
}

/** Merge a patch into the existing file config. Returns the new
 * config object — caller writes it. Defensive: clones the input so
 * the live mutable flag obj isn't accidentally shared with the
 * file representation. */
export function mergePatch(existing: any, patch: ConfigPatch): any {
  const next = JSON.parse(JSON.stringify(existing || {}));
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.flags) {
    next.flags = { ...(next.flags || {}), ...patch.flags };
  }
  if (patch.channels !== undefined) {
    // Channels replace-with-preserve-paths:
    //   - `patch.channels: []` disables everything (empty array
    //     survives; boot forks no workers).
    //   - Otherwise, for each type in the patch, if the existing
    //     config had a path-qualified spec of the same type
    //     ("telegram:/abs/path" or "feishu:/opt/foo"), keep the FULL
    //     spec so the .env / access.json under that dir stays
    //     wired up. A bare-key patch that arrived because the
    //     dashboard doesn't know about the path would otherwise
    //     drop that path and force the boot flow to
    //     `defaultChannelDir()` — which won't have the operator-
    //     provisioned secrets. Codex catch on PR #411.
    const existingByType = new Map<string, string>();
    const existingChannels = Array.isArray(next.channels) ? next.channels : [];
    for (const spec of existingChannels) {
      const t = channelSpecType(spec);
      if (t && !existingByType.has(t)) existingByType.set(t, String(spec));
    }
    next.channels = patch.channels.map((t) => existingByType.get(t) ?? t);
  }
  return next;
}

/** Build the masked config snapshot the node reports via
 * report_status's `config_snapshot` field. Strips secrets — env
 * `_envRef` placeholders stay opaque; nothing from `env` block at all
 * is included. Only model + the 6 dashboard-editable flags + role
 * (daemon discovery, see issue #338 / RFC-026 P2). */
export interface DaemonCapabilities {
  /** RFC-026 §9.3 — list of runtimes this daemon advertises support
   * for (declaration only; D2 spawn fail-fast catches "declared but
   * binary missing" at create-time). */
  runtimes_supported?: string[];
  /** RFC-026 §9.3 — env-var keys this daemon accepts in env_blob
   * (fail-closed default per §9.7). */
  allowed_secret_keys?: string[];
  /** RFC-026 §9 — hub backpressure cap (tools.ts daemon_max_children).
   * Daemon-side enforcement also uses this. Default 20 if unset. */
  max_concurrent_children?: number;
  /** #1353 —— 这个 daemon **现在**能不能创建节点。
   *
   * 🔴 它和 `runtimes_supported` 不是一回事:后者是**声明**(我支持哪些 runtime),
   *    这个是**当下的实际能力**。一个 daemon 可以声明支持三种 runtime,
   *    同时因为 ANET_BIN pin 解析不出来而一种也创建不了。
   *
   * 为什么需要它:pin 只存在于 `/etc/anet-daemon/path.conf` 或(显式开启的)环境变量里,
   * **重启不带环境就会丢**。丢了之后 daemon 照常注册、在线、收 doorbell,
   * hub 返回 `ok:true` + request_id,而节点永远不出现 ——
   * 失败只写在 daemon 自己的日志里。**「在线」和「能干活」是两件事。** */
  can_create_nodes?: boolean;
  /** #1353 —— `can_create_nodes === false` 时的原因**代码**。
   *
   * 🔴 只报代码,**永远不报原始报错文本**。`unsafePathHelp()` 的消息里带
   *    完整的机器路径,而这个字段会一路走到 hub 和 Dashboard ——
   *    一条「哪台机器的哪个路径缺什么」本身就是一张地图。 */
  /** #1353 + #1545 —— `can_create_nodes` 是**多久以前**测出来的(毫秒)。
   *
   * 🔴 缺席 ≠ 0。preview.67 及更早的 daemon 在**开机时算一次**就永久缓存,
   *    它们不发这一格;把缺席渲染成 0 等于替它们宣称"这是刚测的",
   *    正好朝「没问题」方向说谎。读的人必须能把
   *    「刚测的」「很久以前测的」「不知道」分成三件事说。
   *
   * 为什么是时长不是时间戳:见 buildConfigSnapshot 里的赋值处注释(时钟偏移)。 */
  create_capability_observed_ms_ago?: number;
  create_nodes_blocked_reason?: CreateNodesBlockedReason;
}

/** #1353 —— `can_create_nodes === false` 时的原因代码。
 *
 * 🔴 #1545:这个联合**只在这里定义一处**。此前 `agent-node/src/cli.ts` 里另有一份
 *    同样的 `CreateBlockedReason`,两份会各自漂移 —— 而漂移的表现是「daemon 报了个
 *    hub enum 里没有的值」,那会被 zod 静默丢掉(daemon_capabilities 非 strict),
 *    现场看起来像"daemon 明明发了、hub 上没有"。 */
export type CreateNodesBlockedReason =
  | "anet_bin_identity"     // 这个文件不是 anet 的 bin ⇒ 重装或 unset ANET_BIN_ABS
  | "anet_bin_source"       // pin 从哪来 ⇒ 写 /etc/anet-daemon/path.conf（要 sudo）
  | "anet_bin_shape"        // 路径形态 ⇒ 换成 realpath
  | "anet_bin_permission"   // 权限 ⇒ 一行 chmod go-w
  | "anet_bin_unknown";     // 拿不到类别时的兜底（见下）

export interface MaskedSnapshot {
  model?: string | null;
  flags: Record<string, unknown>;
  config_revision?: number;
  config_update_capable: boolean;
  /** #698 protocol capability. The Hub stores this bit only when the
   * reporting ntok is immutably bound to this exact node_id. */
  peer_reply_inbox_capable: true;
  /** Runtime-observed, fail-closed SideThread capability. No secrets or paths. */
  side_thread_capability?: {
    supported: boolean; runtime: string; runtimeVersion: string; topology: string;
    evidenceRevision: string; mode?: "native-exact-fork";
    exactBoundary?: { through: boolean; before: boolean };
    reason?: "runtime" | "version" | "topology" | "experimental-api" | "exact-boundary";
  };
  /** Node role surfaced to hub /api/nodes for daemon discovery (#337).
   * "host_supervisor" = anet daemon (receives create_node dispatches);
   * undefined / other values = regular agent-node. Read from config.json's
   * `role` field, narrow-typed (only string passes). */
  role?: string | null;
  /** Daemon-self-declare bundle. Nested under `daemon_capabilities`
   * because the hub's `create_node` tool already reads
   * `snapshot.daemon_capabilities.allowed_runtimes / .max_concurrent_children`
   * (tools.ts:2010/2075). PR1+PR2 mistakenly put the fields at the
   * top level → hub never saw them → max_concurrent_children stayed
   * the hardcoded 20 default + allowlist enforcement was bypassed.
   * 通信龙 nit ① decision: nest, don't delete. */
  daemon_capabilities?: DaemonCapabilities;
  /** #260 P5 — bare-type channel set currently in this process's
   *  forked worker map. Always emitted (even as `[]`) so the hub's
   *  content-match finalize (finalizePendingMatchingUpdates) can prove
   *  a channels-only restart landed and — separately — so
   *  /api/nodes reflects a disable-all instead of the stale COALESCE'd
   *  value. Path-qualified specs in config.channels are collapsed to
   *  the bare type key; anything unparseable is silently dropped.
   *
   *  Deployment: a channels update is restart-tier — the process
   *  drain + exit(75)'s and RELIES ON a supervisor to respawn it.
   *  Bare-spawn `agent-node ...` (no `anet node start` / systemd
   *  Restart / docker restart-policy) can't restart itself, so the
   *  node just disappears until an operator brings it back. RFC-024
   *  §6.7.1. Hub gates this via config_update_capable — bare-spawn
   *  should set ANET_CONFIG_UPDATE_CAPABLE=0 (default) so restart-
   *  tier POSTs are refused instead of quietly killing the node. */
  channels: string[];
}
export function buildConfigSnapshot(
  fileConfig: any,
  configUpdateCapable: boolean,
  revision: number,
  /** #1353 —— daemon 当下能不能创建节点。**由调用方算好传进来**,不在这里算。
   *
   * 🔴 为什么是依赖注入而不是直接 import:算这个要用
   *    `create-node-daemon.ts` 的 `loadAndVerifyAnetBin()`,而**那个文件已经
   *    import 了本文件**(`atomicWriteJson` 等)。反向 import 会成环。
   *
   * `undefined` = 调用方没算(非 daemon 节点,或旧调用点)⇒ 不上报这两格,
   * 与改动前的行为逐字相同。 */
  createCapability?: {
    ok: boolean;
    /** 兼容:.40 及更早的调用点传 "anet_bin_pin_unresolved"(hub enum 仍收它)。 */
    reason?: CreateNodesBlockedReason | "anet_bin_pin_unresolved";
    /** #1545 —— 这次判断是什么时候做出来的(调用方的 `Date.now()`)。
     *  给了就换算成 `create_capability_observed_ms_ago` 一起上报;
     *  没给就**不上报那一格**(读的人据此说「年龄未知」)。 */
    probedAtMs?: number;
  },
  /** #1545 测试注入点:默认取 `Date.now()`。**只为可测,不改语义。** */
  nowMs: number = Date.now(),
): MaskedSnapshot {
  const out: MaskedSnapshot = {
    model: typeof fileConfig?.model === "string" ? fileConfig.model : null,
    flags: {},
    config_revision: revision,
    config_update_capable: configUpdateCapable,
    peer_reply_inbox_capable: true,
    role: typeof fileConfig?.role === "string" ? fileConfig.role : null,
    // Always emit — see MaskedSnapshot.channels comment. Sort +
    // dedup so the hub's Set-equality content-match doesn't care
    // about the order the operator listed them in.
    channels: (() => {
      const raw = fileConfig?.channels;
      if (!Array.isArray(raw)) return [];
      const seen = new Set<string>();
      const out2: string[] = [];
      for (const spec of raw) {
        const t = channelSpecType(spec);
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out2.push(t);
      }
      return out2.sort();
    })(),
  };
  // Self-declare nested under daemon_capabilities — only emit fields
  // when valid (typeof + Array.isArray narrow per
  // per team rule: any typed scalar extracted from untrusted JSON must be typeof-narrowed at the boundary; don't trust user JSON).
  const caps: DaemonCapabilities = {};
  const rt = fileConfig?.runtimes_supported;
  if (Array.isArray(rt) && rt.every((s: unknown) => typeof s === "string")) {
    caps.runtimes_supported = rt;
  }
  const ask = fileConfig?.allowed_secret_keys;
  if (Array.isArray(ask) && ask.every((s: unknown) => typeof s === "string")) {
    caps.allowed_secret_keys = ask;
  }
  const mc = fileConfig?.max_concurrent_children;
  if (typeof mc === "number" && Number.isFinite(mc) && mc > 0) {
    caps.max_concurrent_children = mc;
  }
  // #1353 —— 只在调用方真的算过的时候才上报。没算过就完全不出现这两个字段,
  // 这样旧 hub 和旧调用点的行为逐字不变。
  if (createCapability) {
    caps.can_create_nodes = createCapability.ok;
    // #1545 —— 「能不能」旁边必须带上「**这是什么时候测的**」。
    //
    // 🔴 上报时长而不是绝对时间戳:这个值来自本机的钟,而 hub 拿它去和自己的钟
    //    比较。时钟偏移下,绝对时间戳算出的年龄既可能"永远新鲜"也可能"来自 1970",
    //    **错的方向不可预测**。时长对偏移免疫 —— hub 用自己的钟在收到时换算成绝对时间。
    //
    // 🔴 `Math.max(0, …)`:系统时钟可能被 NTP 往回拨,那会算出负数年龄。
    //    夹到 0 是**朝"更旧"方向保守**的那一侧吗?不是 —— 0 表示"刚测的",
    //    是朝"更新鲜"错。之所以仍然这么写,是因为负数会被 hub 的消毒直接丢掉
    //    (读取侧对 `rawAge >= 0` 有断言),那等于**整格消失**、读的人退回"年龄未知";
    //    而时钟回拨的量级(NTP 单次校正通常 < 1s)远小于这一格要分辨的尺度
    //    (分钟 vs 周)。两害相权,保住这一格。
    if (typeof createCapability.probedAtMs === "number"
        && Number.isFinite(createCapability.probedAtMs)) {
      caps.create_capability_observed_ms_ago =
        Math.max(0, nowMs - createCapability.probedAtMs);
    }
    if (!createCapability.ok && createCapability.reason) {
      caps.create_nodes_blocked_reason = createCapability.reason;
    }
  }
  if (Object.keys(caps).length > 0) {
    out.daemon_capabilities = caps;
  }
  const f = (fileConfig?.flags || {}) as Record<string, unknown>;
  for (const k of ALLOWED_FLAGS) {
    if (k in f) out.flags[k] = f[k];
  }
  return out;
}
