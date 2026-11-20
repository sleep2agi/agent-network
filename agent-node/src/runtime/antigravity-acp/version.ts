// Antigravity CLI（agy）版本钉与就绪判定。
//
// 负责人 2026-11-20 定：**钉版本，不让它自更新**。agy 默认会自我升级，
// 一升级模型 slug / ACP 能力就可能漂，节点上的会话行为跟着变。
// 所以这里把「验收过的版本」写成常量，节点启动前比对；不一致就报清楚，
// 由我们审过再手动升，而不是静默跟随。
//
// 纯函数，不 spawn：spawn 的部分在 readiness.ts（集成测试用真 agy）。

/** 我们验收过的版本（2026-11-20 实测，ACP initialize 回 1.5.13）。 */
export const PINNED_AGY_VERSION = "1.5.13";

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
export function compareAgyVersion(actual: AgyVersion | null, pinned = PINNED_AGY_VERSION): AgyPinState {
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

/** 给节点/向导看的就绪文案：pinned 之外都不算 ready（钉版本是硬规则）。 */
export function agyReadinessMessage(state: AgyPinState, actual: AgyVersion | null, pinned = PINNED_AGY_VERSION): string {
  switch (state) {
    case "pinned": return `Antigravity CLI ${pinned}（已验收版本）`;
    case "newer": return `Antigravity CLI ${actual ? formatAgyVersion(actual) : "?"} 比验收版本 ${pinned} 新：升级要我们先审过，节点暂不给用。`;
    case "older": return `Antigravity CLI ${actual ? formatAgyVersion(actual) : "?"} 比验收版本 ${pinned} 旧：请安装 ${pinned}，不要让它自动升级。`;
    default: return "没读到 Antigravity CLI 的版本：确认 `agy` 在 PATH 里，或装上验收过的 " + pinned + "。";
  }
}
