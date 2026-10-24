// 标签树(父子标签)。标签本身仍然只是卡片 tags_json 里的字符串(见 requirement-tags.ts);
// 这里只多存两件事:
//   ① 谁挂在谁下面 —— network_tag_nodes(network_id, name, parent_name);
//   ② 创建过但还没有任何卡片用的标签 —— 否则 0 任务的子标签在 GET /tags 里读不到(它只会数卡片)。
// 语义:网络内标签名就是 id(没有 tag_id),parent_name 指向父标签名;改名时父引用跟着改。
// 深度上限 MAX_TAG_DEPTH(含根)。父不存在 = 报错,不静默挂到根上。
import { tagName } from "./requirement-tags.js";

/** 最多 4 层(顶层是第 1 层)。比子需求(5 层)浅一层:侧栏要一屏放得下父子孙。 */
export const MAX_TAG_DEPTH = 4;

/** 客户端用这个 capability 判断 Hub 有没有「创建标签 / 父标签」;没有就灰掉入口,别调用。 */
export const TAG_TREE_CAPABILITY = "tag_tree";

export type TagNodeRow = { name: string; parent_name: string | null };

export type TagNodePublic = {
  name: string;
  parent_id: string | null;
  depth: number;
  /** 这张标签是不是「登记过」的节点(create 建的、或被 create 当父补登记的)。false = 只在卡片上出现过。 */
  registered: boolean;
};

export type CreateTagInput = { name: string; parent: string | null };

/**
 * POST /api/requirements/tags/create 的 body:
 *   { "name": "子标签", "parent_id": null | "父标签名" }
 * parent_id 缺省/null = 建在根上;给了字符串就必须是网络里已存在的标签 —— 不存在回 404,
 * **绝不**悄悄建到根上(客户端要预选父标签,静默 root fallback 会让 UI 显示的和实际存的不一致)。
 */
export function parseCreateTag(body: Record<string, unknown>): CreateTagInput | { error: string } {
  const name = tagName(body.name);
  if (!name) return { error: "invalid_tag" };
  const rawParent = body.parent_id;
  if (rawParent === undefined || rawParent === null) return { name, parent: null };
  if (typeof rawParent !== "string") return { error: "invalid_tag_parent_id" };
  const parent = tagName(rawParent);
  if (!parent) return { error: "invalid_tag_parent_id" };
  if (parent === name) return { error: "tag_parent_cycle" };
  return { name, parent };
}

/** 从 name 往上数几层(顶层 = 1)。链上有环(历史脏数据)返回 Infinity,调用方据此拒绝。 */
export function tagDepth(name: string, parentOf: Map<string, string | null>): number {
  let depth = 1;
  let cur = parentOf.get(name) ?? null;
  const seen = new Set<string>([name]);
  while (cur) {
    if (seen.has(cur)) return Number.POSITIVE_INFINITY;
    seen.add(cur);
    depth++;
    cur = parentOf.get(cur) ?? null;
  }
  return depth;
}

/** child 是不是 ancestor 的子孙(用于改名时的防环判断)。 */
export function isDescendant(child: string, ancestor: string, parentOf: Map<string, string | null>): boolean {
  let cur: string | null = parentOf.get(child) ?? null;
  const seen = new Set<string>();
  while (cur) {
    if (cur === ancestor) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/**
 * GET /api/requirements/tags 的 nodes:
 * 登记过的节点 ∪ 调用者看得见的在用标签(后者 parent_id = null、registered = false,
 * 老 Hub 上就是一堆平标签,升级后不会突然消失)。
 */
export function buildTagNodes(registered: TagNodeRow[], inUse: string[]): TagNodePublic[] {
  const parentOf = new Map<string, string | null>();
  const isRegistered = new Set<string>();
  for (const row of registered) {
    parentOf.set(row.name, row.parent_name ?? null);
    isRegistered.add(row.name);
  }
  for (const name of inUse) if (!parentOf.has(name)) parentOf.set(name, null);
  const nodes: TagNodePublic[] = [];
  for (const [name, parent] of parentOf) {
    const depth = tagDepth(name, parentOf);
    nodes.push({
      name,
      parent_id: parent,
      // 环/脏数据不给客户端 NaN/Infinity:按顶层展示,写接口仍然会拒绝往里挂。
      depth: Number.isFinite(depth) ? depth : 1,
      registered: isRegistered.has(name),
    });
  }
  return nodes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * name 这棵子树有几层(叶子 = 1)。改父级时用它算「搬过去之后最深到几层」:
 * 只检查新父的深度是不够的 —— 一个 3 层的子树挂到第 3 层下,最深会到 5 层。
 * 历史脏数据里有环时用 visited 兜住,不要为脏数据死循环。
 */
export function tagSubtreeHeight(name: string, parentOf: Map<string, string | null>): number {
  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of parentOf) {
    if (!parent) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(child); else childrenOf.set(parent, [child]);
  }
  let height = 1;
  let frontier = [name];
  const seen = new Set<string>([name]);
  for (;;) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const child of childrenOf.get(node) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        next.push(child);
      }
    }
    if (!next.length) return height;
    height++;
    frontier = next;
  }
}
