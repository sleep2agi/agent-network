// Antigravity CLI（agy）版本钉与就绪判定。
//
// 负责人 2026-11-20 定：**钉版本，不让它自更新**。agy 默认会自我升级，
// 一升级模型 slug / ACP 能力就可能漂，节点上的会话行为跟着变。
// 所以这里把「验收过的版本」写成常量，节点启动前比对；不一致就报清楚，
// 由我们审过再手动升，而不是静默跟随。
//
// 2026-11-21 真机补充：agy 的自动升级关不掉（settings.json 的 AutoUpdate 不生效），
// 而基线是写死的常量 —— 运维被升级一次就完全没有退路。现在留一个**显式**的
// 逃生口：`AGY_ACCEPTED_VERSION`。默认值不变，仍然是钉死的那一版；只有运维
// 审过新版本后主动设置环境变量，节点才会接受，不会再出现"只能等发版"的死局。
//
// 纯函数，不 spawn：spawn 的部分在 readiness.ts（集成测试用真 agy）。

/** 我们验收过的版本（2026-11-20 实测，ACP initialize 回 1.5.13）。 */
export const DEFAULT_PINNED_AGY_VERSION = "1.5.13";

/** 兼容旧引用：默认基线。运行时判定请用 `pinnedAgyVersion()`。 */
export const PINNED_AGY_VERSION = DEFAULT_PINNED_AGY_VERSION;

const VERSION_SHAPE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * 当前生效的验收基线。
 *
 * `AGY_ACCEPTED_VERSION` 给了合法版本号时以它为准（审计/升级场景），
 * 非法值或未设置时退回默认基线 —— 避免一个手滑的环境变量把节点变成
 * "什么版本都放行"。
 */
export function pinnedAgyVersion(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AGY_ACCEPTED_VERSION?.trim();
  if (raw && VERSION_SHAPE.test(raw)) return raw.replace(/^v/, "");
  return DEFAULT_PINNED_AGY_VERSION;
}

export interface AgyVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
  pre?: string;
}

/** 解析 `agy --version` 的输出（实测就是一行 `1.5.13`）。 */
export function parseAgyVersion(output: string): AgyVersion | null {
  const line = output.split("\n").map(l => l.trim()).find(Boolean) ?? "";
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(line);
  if (!m) return null;
  const v: AgyVersion = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: line };
  if (m[4]) v.pre = m[4];
  return v;
}

export function formatAgyVersion(v: AgyVersion): string {
  return `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ""}`;
}

export type AgyPinState = "pinned" | "newer" | "older" | "unknown";

/** 与钉的版本比：完全相等才算 pinned；更高/更低都要人看一眼（不自动跟随）。 */
export function compareAgyVersion(actual: AgyVersion | null, pinned = pinnedAgyVersion()): AgyPinState {
  if (!actual) return "unknown";
  const p = parseAgyVersion(pinned);
  if (!p) return "unknown";
  if (formatAgyVersion(actual) === formatAgyVersion(p)) return "pinned";
  const a = [actual.major, actual.minor, actual.patch];
  const b = [p.major, p.minor, p.patch];
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return "newer";
    if (a[i] < b[i]) return "older";
  }
  return "pinned";
}

/**
 * 给节点/向导看的就绪文案：pinned 之外都不算 ready（钉版本是硬规则）。
 *
 * 文案必须**可执行**：真机上节点只打印"升级要我们先审过"，运维还得回来问
 * "那我怎么修"。这里把两条退路直接写进去（降级锁定 / 审过后放行），
 * 顺便解释自动升级关不掉这件事 —— 否则下次还会有人被咬。
 */
export function agyReadinessMessage(state: AgyPinState, actual: AgyVersion | null, pinned = pinnedAgyVersion()): string {
  const seen = actual ? formatAgyVersion(actual) : "?";
  switch (state) {
    case "pinned":
      return `Antigravity CLI ${pinned}（已验收版本）`;
    case "newer":
      return `Antigravity CLI ${seen} 比建议版本 ${pinned} 新：不阻断，仅提示（未验收版本可能改 ACP 行为）。` +
        `出问题先装回 ${pinned} 并锁定二进制（chflags uchg "$(command -v agy)" / Windows attrib +R，agy 的自动升级关不掉）；` +
        `确认要以 ${seen} 为新基线就设 AGY_ACCEPTED_VERSION=${seen}。`;
    case "older":
      return `Antigravity CLI ${seen} 比建议版本 ${pinned} 旧：不阻断，仅提示。建议升到 ${pinned} 以上（curl -fsSL https://antigravity.google/cli/install.sh | bash）。`;
    default:
      return "没读到 Antigravity CLI 的版本：确认 `agy` 在 PATH 里（或设置 AGY_BIN），并运行 `agy --version` 复核，或装上验收过的 " + pinned + "。";
  }
}