// 2026-11-10 —— 「我这份 agent-node 是被哪个 anet CLI 起的」。
//
// 为什么需要它：`nodes.config_snapshot.anet_version` 是个**静态占位值**（写死 0.1.0），
// 不是真的版本号。于是客户端没法告诉用户这台机器该装哪一对 npm 包，只能给
// `npm install -g @sleep2agi/agent-node@preview` 这种「看起来对、其实不成对」的建议 ——
// 装完 CLI 拒绝启动（`Incompatible agent-node for opencode-cli`），节点直接离线。
//
// 口径（刻意保守）：
//   · 环境变量**只由** anet CLI 在 spawn 子进程时写入（见 agent-network/bin/cli.ts 的 childEnv）。
//   · 这里只做形状校验：`X.Y.Z` 或 `X.Y.Z-preview.N`，长度 ≤ 64。不认的形态一律当**没报**，
//     绝不用默认值/占位值冒充 —— 假版本比没有版本更害人（就是上面那个 bug 的成因）。
//   · 缺席 ⇒ 不上报这一格（旧 Hub、旧启动路径、daemon 自己 adopt 出来的子节点都属于这一类）。
export const LAUNCHED_BY_CLI_VERSION_ENV = "ANET_LAUNCHED_BY_CLI_VERSION";

/** 上报字段名（Hub 的 report_status schema 与 /api/nodes 投影用的是同一个）。 */
export const LAUNCHED_BY_CLI_VERSION_FIELD = "launched_by_cli_version";

/** 只认这两种形态：npm 稳定版 `2.3.0`、预发布版 `2.3.0-preview.226`。 */
const VERSION_SHAPE = /^[0-9]+\.[0-9]+\.[0-9]+(-preview\.[0-9]+)?$/;
const MAX_LEN = 64;

/**
 * 校验一个**不可信**的字符串（来自环境，可能被 profile/env 覆盖或被手工塞入）。
 * 返回合法版本号，或 `undefined` 表示「不知道」。
 */
export function readLaunchedByCliVersion(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env[LAUNCHED_BY_CLI_VERSION_ENV];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value || value.length > MAX_LEN) return undefined;
  return VERSION_SHAPE.test(value) ? value : undefined;
}

/**
 * 直接可以摊进心跳 `config_snapshot` 的一格。
 *
 * 缺席/形状不对时返回**空对象**（不是 `{key: undefined}`）：这样序列化出来的快照
 * 与改动前逐字节相同，旧 Hub 与旧客户端读到的也没有任何变化。
 */
export function launchedByCliVersionField(version: string | undefined): Record<string, string> {
  return version ? { [LAUNCHED_BY_CLI_VERSION_FIELD]: version } : {};
}
