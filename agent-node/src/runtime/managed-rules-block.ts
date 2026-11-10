// #993 / RFC-043 — 受管块（managed block）的纯逻辑：渲染与"写进文件"这一步。
//
// 这里刻意**不含任何产品决定**：
//   * 不决定什么时候注入（启动时 / 门铃推送）——那是 RFC §4；
//   * 不决定三层怎么裁决冲突——那是 RFC §2；
//   * 不读 Hub、不碰文件系统、不启动进程。
// 它只回答两个机械问题，而这两个问题无论最后选哪套语义都必须答对：
//   1. 把若干层文本渲染成一个带来源与 revision 的块（renderManagedBlock）；
//   2. 把块写进用户文件的正确位置，**块外一个字节都不动**，并且在文件被改坏时拒绝写入
//      而不是猜（applyManagedBlock）。
//
// 为什么单独拎出来先做：块外内容丢失、标记只写一半、同 revision 反复注入产生 diff——
// 这三类错误与"优先级怎么定"无关，却是最容易在集成时才暴露的。先让它们有独立的测试。

/** 块标记。改动即破坏兼容：已注入的块必须能被新版本原样识别。 */
export const MANAGED_BLOCK_BEGIN = (revision: number) =>
  `<!-- ANET:TEAM-RULES v${revision} BEGIN — 由 CommHub 自动维护，块外内容不会被修改 -->`;
export const MANAGED_BLOCK_END = (revision: number) => `<!-- ANET:TEAM-RULES v${revision} END -->`;

const BEGIN_RE = /<!-- ANET:TEAM-RULES v(\d+) BEGIN[^>]*-->/g;
const END_RE = /<!-- ANET:TEAM-RULES v(\d+) END -->/g;

export type RulesLayer = {
  /** 来源标识，用于 provenance（例如 `Hub / 网络 net_xxx`、`Daemon / host-a`）。 */
  source: string;
  /** 该层文本正文（可以为空串，表示这一层没有内容）。 */
  content: string;
  /** 该层的 revision；Hub 层来自 `network_rules.revision`。 */
  revision: number;
  /** 最近更新时间（ISO 8601），仅用于 provenance，可为空。 */
  updated_at?: string | null;
};

/**
 * 渲染受管块。`layers` 的顺序就是注入顺序（RFC §2.3：Hub → Daemon → 节点）；
 * 空内容的层会被跳过，但**至少有一层非空**才渲染，否则返回 null（调用方据此保留旧块或不动文件）。
 */
export function renderManagedBlock(layers: RulesLayer[], revision: number): string | null {
  const usable = layers.filter((l) => typeof l.content === "string" && l.content.trim() !== "");
  if (usable.length === 0) return null;
  const parts: string[] = [MANAGED_BLOCK_BEGIN(revision), "## 团队规则（CommHub 自动维护）", ""];
  for (const layer of usable) {
    const when = layer.updated_at ? `，更新于 ${layer.updated_at}` : "";
    parts.push(`### 来源：${layer.source}（revision ${layer.revision}${when}）`);
    // 层内内容原样保留：不 trim 尾部以外的任何东西，避免吞掉作者刻意留的空行结构。
    parts.push(layer.content.replace(/\s+$/, ""));
    parts.push("");
  }
  parts.push(MANAGED_BLOCK_END(revision));
  return parts.join("\n") + "\n";
}

export type ApplyOutcome =
  | { action: "unchanged"; content: string }
  | { action: "inserted"; content: string }
  | { action: "replaced"; content: string }
  | { action: "refused"; reason: string; content: string };

/**
 * 把块写进文件内容。
 *
 * 规则（对应 RFC §3.1 与 §7 的用例）：
 *   * 没有标记 → 追加到**顶部**（块在最前，用户内容在块后，逐字节保留）；
 *   * 成对标记 → 整块替换；
 *   * 只有一半 / 成对但 revision 不一致 / 出现多对 → **拒绝写入**并说明原因，不猜；
 *   * 块内容与已有块逐字节相同 → `unchanged`（避免无意义 diff 与文件 mtime 变化）。
 */
export function applyManagedBlock(fileContent: string, block: string): ApplyOutcome {
  const begins = [...fileContent.matchAll(BEGIN_RE)];
  const ends = [...fileContent.matchAll(END_RE)];

  if (begins.length === 0 && ends.length === 0) {
    const sep = fileContent.length === 0 || fileContent.startsWith("\n") ? "" : "\n";
    return { action: "inserted", content: block + sep + fileContent };
  }
  if (begins.length !== 1 || ends.length !== 1) {
    return {
      action: "refused",
      reason: `expected exactly one BEGIN and one END marker, found begin=${begins.length} end=${ends.length}`,
      content: fileContent,
    };
  }
  const begin = begins[0];
  const end = ends[0];
  const beginRevision = Number(begin[1]);
  const endRevision = Number(end[1]);
  const beginAt = begin.index ?? -1;
  const endAt = end.index ?? -1;
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    return { action: "refused", reason: "END marker appears before BEGIN marker", content: fileContent };
  }
  if (beginRevision !== endRevision) {
    return {
      action: "refused",
      reason: `BEGIN is v${beginRevision} but END is v${endRevision}`,
      content: fileContent,
    };
  }
  const endLineEnd = fileContent.indexOf("\n", endAt);
  const stop = endLineEnd === -1 ? fileContent.length : endLineEnd + 1;
  const existing = fileContent.slice(beginAt, stop);
  if (existing === block) return { action: "unchanged", content: fileContent };
  return { action: "replaced", content: fileContent.slice(0, beginAt) + block + fileContent.slice(stop) };
}

/** 从文件里读回当前块的 revision 与正文（供"已应用哪一版"的审计使用）。 */
export function readManagedBlock(fileContent: string): { revision: number; body: string } | null {
  const begins = [...fileContent.matchAll(BEGIN_RE)];
  const ends = [...fileContent.matchAll(END_RE)];
  if (begins.length !== 1 || ends.length !== 1) return null;
  const beginAt = begins[0].index ?? -1;
  const endAt = ends[0].index ?? -1;
  if (beginAt < 0 || endAt < beginAt) return null;
  const endLineEnd = fileContent.indexOf("\n", endAt);
  const stop = endLineEnd === -1 ? fileContent.length : endLineEnd;
  return { revision: Number(begins[0][1]), body: fileContent.slice(beginAt, stop) };
}
