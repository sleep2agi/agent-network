/** Small, network-local labels; count Unicode code points rather than UTF-16 units. */
export function normalizeTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const tags: string[] = [];
  for (const valueTag of value) {
    if (typeof valueTag !== "string") return null;
    const tag = valueTag.trim();
    if (!tag || [...tag].length > 20 || /[\u0000-\u001f\u007f]/u.test(tag)) return null;
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

export function storedTags(value: string | null): string[] {
  try { return normalizeTags(JSON.parse(value || "[]")) ?? []; } catch { return []; }
}

// ── 标签管理(改名 / 合并 / 删除 / 颜色) ──
// 标签只是卡片 tags 数组里的字符串,没有自己的表;批量操作 = 把网络里每张带这个标签的卡的数组改写一遍。
// 颜色是可选的,单独存在 network_tags(network_id, name, color);没行 = 客户端用默认灰。
export const MAX_MERGE_SOURCES = 50;
export type TagOp =
  | { op: "rename"; from: string; to: string }
  | { op: "merge"; from: string[]; to: string }
  | { op: "delete"; tag: string }
  | { op: "color"; tag: string; color: string | null };

/** 单个标签名,规则同 normalizeTags。不合法 = null。 */
export function tagName(value: unknown): string | null {
  const tags = normalizeTags([value]);
  return tags && tags.length === 1 ? tags[0] : null;
}

const TAG_COLOR = /^#[0-9a-fA-F]{6}$/;
/** 请求体 → 操作;不合法返回错误码。 */
export function parseTagOp(body: Record<string, unknown>): TagOp | { error: string } {
  switch (body.op) {
    case "rename": {
      const from = tagName(body.from), to = tagName(body.to);
      if (!from || !to) return { error: "invalid_tag" };
      if (from === to) return { error: "same_tag" };
      return { op: "rename", from, to };
    }
    case "merge": {
      if (!Array.isArray(body.from) || body.from.length === 0 || body.from.length > MAX_MERGE_SOURCES) return { error: "invalid_tag" };
      const from: string[] = [];
      for (const value of body.from) {
        const tag = tagName(value);
        if (!tag) return { error: "invalid_tag" };
        if (!from.includes(tag)) from.push(tag);
      }
      const to = tagName(body.to);
      if (!to) return { error: "invalid_tag" };
      // 目标自己出现在来源里不算来源(合并进自己 = 什么都不做)。
      const sources = from.filter(tag => tag !== to);
      if (!sources.length) return { error: "same_tag" };
      return { op: "merge", from: sources, to };
    }
    case "delete": {
      const tag = tagName(body.tag);
      return tag ? { op: "delete", tag } : { error: "invalid_tag" };
    }
    case "color": {
      const tag = tagName(body.tag);
      if (!tag) return { error: "invalid_tag" };
      if (body.color !== null && (typeof body.color !== "string" || !TAG_COLOR.test(body.color))) return { error: "invalid_tag_color" };
      return { op: "color", tag, color: body.color === null ? null : (body.color as string).toLowerCase() };
    }
    default:
      return { error: "invalid_tag_op" };
  }
}

/** 这张卡的标签被这个操作改写后的样子;没变返回 null。顺序保留(新名字占第一个来源的位置),去重。 */
export function applyTagOp(tags: string[], op: TagOp): string[] | null {
  let sources: string[];
  let to: string | null;
  if (op.op === "rename") { sources = [op.from]; to = op.to; }
  else if (op.op === "merge") { sources = op.from; to = op.to; }
  else if (op.op === "delete") { sources = [op.tag]; to = null; }
  else return null;
  if (!tags.some(tag => sources.includes(tag))) return null;
  const next: string[] = [];
  for (const tag of tags) {
    const mapped = sources.includes(tag) ? to : tag;
    if (mapped !== null && !next.includes(mapped)) next.push(mapped);
  }
  return next;
}
