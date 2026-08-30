// #1522 —— grok 共存节点的「停机后该清什么」记录（契约层，本文件不含清理行为）。
//
// ## 它解决的问题
//
// `anet node stop` 给整棵树的宽限是有限的（marker 共存路径 3s / ordinary 路径
// 5s，`agent-network/bin/cli.ts:9731` 与 `:8926`），而 agent-node 侧的拆卸链最坏
// 可达 8s。越线即 SIGKILL ⇒ **清扫者被掐断**，`GROK_POST_STOP_CLEANUP_POLICY`
// 里排在后面的条目必然跑不到。
//
// 已经试过又被否掉的两条：
//   (A) 把 CLI 宽限调大 —— 抬高每次 stop 的最坏耗时，而且那个数是**当前**最坏值，
//       链条一变就过期、没有任何东西会提醒人；
//   (B) 把清理搬到拆卸链头部 —— **不安全**。提前删 Leader `.lock` ⇒ 另一个 Leader
//       能起来、两个都认为拥有同一个 session；提前删那 5 个 0444 placeholder ⇒
//       **把围栏亲手拆掉**，而活着的进程正好趁机建出一个真 `.grok`（正是要清的东西）；
//       而且与 `retainLocksForUnconfirmedPty` 直接冲突 —— 那条不变量说的是
//       「**未确认**时什么都别动，把反例原样留给外部扫描器」。
//
// ## 这份记录是什么
//
// 由 **agent-node** 在 spawn 之后写下「这一代会留下哪些具体路径、每条用什么守卫
// 才允许删」，CLI 只读。于是：
//   • 清单**只有一个作者**（agent-node，policy 本来就是它的知识），不存在第二份可分叉；
//   • agent-network **不需要 import 任何 agent-node 模块**（当前跨包 import = 0，不新增）；
//   • stop 被 SIGKILL 掐断也没关系，**记录还在**。
//
// 🔴 为什么不写进 copresence marker：marker 是 **CLI** 写的
// （`agent-network/bin/cli.ts:1318/1433/1593`，agent-node 侧 0 处），塞进去等于
// 让 CLI 重新需要 policy —— 跨包问题原样绕回来。而且 marker 的语义是**身份**
// （uuid / boot_id / owner_uid），"要删哪些文件"是另一种性质的东西。
//
// 🔴 路径在**写入时**展开成绝对路径，不是把 policy 序列化过去。一旦记录里出现
//    需要读取方去"算"的东西（basename 列表、pid 绑定规则、路径模板），那份知识
//    就在读取方有了第二个副本 —— 绕这一圈正是为了避免它。

/**
 * 一条痕迹允许被删除的依据。**判别式联合，加新条目时不填就编译不过** ——
 * 这是刻意的：下一个往清单里加第八样的人，必须回答"我这一样有没有 per-item 守卫"。
 * 写在文件头的注释不行，加清单项的人不会读文件头。
 */
export type PostStopGuard =
  /**
   * 这一条**自己可验证**：即使"属主已死"这个前提判错了，形状不对也不会误删。
   * 例：leader socket 有 `/proc/net/unix` 的监听者注册表；那 5 个 placeholder 有
   * 「单链空普通文件 + 0444 + 属主是当前 uid」三个特征。
   */
  | { readonly kind: "self-verifying"; readonly shape: PostStopShape }
  /**
   * 这一条**没有 per-item 守卫**，正确性完全押在前提上。
   * 目前唯一允许的前提是 `owner-proven-dead` —— 而它在 stop 里是**可判定的**，
   * 不是假设：marker 路径若证不出来会在 `cli.ts:9755` 直接 `exit(1)`，根本走不到清理。
   */
  | { readonly kind: "premise-only"; readonly premise: "owner-proven-dead" };

/** `self-verifying` 条目的形状判据。字段全部必填 —— 少一个就等于少一道闸。 */
export interface PostStopShape {
  readonly type: "single-link-empty-regular-file" | "unix-socket" | "regular-file" | "directory";
  /** 八进制字符串，例如 "0444"。留空不允许：模式是这几条形状判据里最容易漂的一格。 */
  readonly mode: string;
  /** 目前只有 "currentUid" 一种；写成枚举是为了让将来加别的属主判据时必须显式。 */
  readonly owner: "currentUid";
}

export interface PostStopManifestEntry {
  /** **绝对**路径，写入时展开。读取方不做任何拼接。 */
  readonly path: string;
  /** 这条痕迹的来源，仅用于诊断输出；判据不看它。 */
  readonly origin: string;
  readonly guard: PostStopGuard;
}

/**
 * 🔴 版本不认识时的约定是「**什么都不删并出声**」，不是尽力而为。
 *    静默降级会让"清理跑了"和"格式不认识"在日志里长得一模一样。
 */
export const POST_STOP_MANIFEST_VERSION = 1 as const;

export const POST_STOP_MANIFEST_FILENAME = "grok-post-stop-manifest.json";

export interface PostStopManifest {
  readonly version: typeof POST_STOP_MANIFEST_VERSION;
  /** 写下这份记录的那一代，仅用于诊断；判死亡仍走 boot_id + start-time。 */
  readonly generation: { readonly bootId: string; readonly writtenAtEpochMs: number };
  readonly entries: readonly PostStopManifestEntry[];
}

/**
 * 读取结果**刻意分成四态**，因为它们要求的动作完全不同：
 *
 *   ok            —— 按 entries 逐项走守卫；`entries: []` 是**正常**的
 *                    （这一代没留下痕迹），不是异常；
 *   missing       —— 记录不在。按契约②（写失败即阻断 spawn）这**本不该发生**，
 *                    所以它意味着别的东西坏了 ⇒ 该出声、该查；
 *   unknown-version —— 什么都不删并出声；
 *   unreadable    —— 同上，且带上原因。
 *
 * 🔴 「清了 0 条」和「记录不存在」必须是两种读数。把它们折叠成一个布尔，
 *    就等于把"这一代很干净"和"记录写丢了"说成同一件事。
 */
export type PostStopManifestRead =
  | { readonly kind: "ok"; readonly manifest: PostStopManifest }
  | { readonly kind: "missing" }
  | { readonly kind: "unknown-version"; readonly found: unknown }
  | { readonly kind: "unreadable"; readonly detail: string };

/** 解析一份已读入的 JSON 文本。**纯函数** —— 读取方（CLI）复用的就是这一段语义。 */
export function parsePostStopManifest(raw: string): PostStopManifestRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: "unreadable", detail: `invalid JSON: ${(error as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { kind: "unreadable", detail: "manifest is not an object" };
  }
  const version = (parsed as { version?: unknown }).version;
  if (version !== POST_STOP_MANIFEST_VERSION) {
    return { kind: "unknown-version", found: version };
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    return { kind: "unreadable", detail: "entries is not an array" };
  }
  for (const entry of entries) {
    const detail = describeInvalidEntry(entry);
    if (detail) return { kind: "unreadable", detail };
  }
  const generation = (parsed as { generation?: unknown }).generation;
  if (!generation || typeof generation !== "object") {
    return { kind: "unreadable", detail: "generation is missing" };
  }
  return { kind: "ok", manifest: parsed as PostStopManifest };
}

/**
 * 🔴 校验**拒绝**未知 guard.kind，而不是跳过它。
 *    跳过等于"读取方比写入方老时，静默少清几样" —— 而少清是不会有人发现的那个方向。
 */
function describeInvalidEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return "entry is not an object";
  const path = (entry as { path?: unknown }).path;
  if (typeof path !== "string" || !path.startsWith("/")) {
    return `entry path must be absolute, got ${JSON.stringify(path)}`;
  }
  const guard = (entry as { guard?: unknown }).guard;
  if (!guard || typeof guard !== "object") return `entry ${path} has no guard`;
  const kind = (guard as { kind?: unknown }).kind;
  if (kind === "premise-only") {
    const premise = (guard as { premise?: unknown }).premise;
    return premise === "owner-proven-dead" ? null : `entry ${path} has an unknown premise`;
  }
  if (kind === "self-verifying") {
    const shape = (guard as { shape?: unknown }).shape;
    if (!shape || typeof shape !== "object") return `entry ${path} is self-verifying without a shape`;
    const { type, mode, owner } = shape as Record<string, unknown>;
    if (typeof type !== "string" || typeof mode !== "string" || owner !== "currentUid") {
      return `entry ${path} has an incomplete shape`;
    }
    return null;
  }
  return `entry ${path} has an unknown guard kind ${JSON.stringify(kind)}`;
}
