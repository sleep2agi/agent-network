// GET /api/requirements 的服务端搜索(q=)与分页(limit / cursor)。纯函数,requirements.ts 接线。
//
// 为什么要:列表一直是 `ORDER BY created_at DESC LIMIT 500`,App 的任务搜索只在读到的行里搜 ——
// 生产一个网络已经 ~400 张卡,过了 500 最老的那些就搜不到、也翻不到。
//
// 语义与 App 的任务搜索(agent-network-app src/task-search.ts)一致,两边搜同一个词得到同一批卡:
//   · 字段:标题、描述(去掉 markdown 图片 / 链接的地址,链接文字保留)、负责人 / 负责 Agent / 参与人的显示名、
//     旧 assignee 文本、项目名、标签
//   · NFKC(全角 → 半角)+ 小写;中文按子串;空白隔开的词是「且」,每个词可以落在不同字段,但不跨字段拼
//   · 调用者看不见的节点(受限成员)在卡片上本来就被隐去,它的名字也不参与匹配 —— 否则 q= 就成了
//     「这张卡是不是某个没授权给我的 Agent 负责」的探测器
//
// 分页:按 (created_at DESC, requirement_id DESC) 排,cursor = 上一页最后一行的这两个值(不透明的 base64url)。
// 不带 limit / cursor / q 的旧请求:同样的 500 行、同样的顺序,响应只多两个字段 has_more / next_cursor。

export const DEFAULT_LIST_LIMIT = 500;
export const MAX_LIST_LIMIT = 1000;
export const MAX_QUERY_LENGTH = 200;

const fold = (s: string): string => s.normalize("NFKC").toLocaleLowerCase();

/** 搜索词:归一后按空白切开,去重、去空。 */
export function searchTerms(q: string): string[] {
  return [...new Set(fold(q).split(/\s+/).filter(Boolean))];
}

/** 描述是 markdown:图片 / 链接的地址不参与搜索,链接文字保留;html 标签去掉。 */
export function descriptionText(md: string | null | undefined): string {
  if (!md) return "";
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ");
}

type Ref = { kind?: unknown; id?: unknown } | null | undefined;
export type SearchableRow = {
  name: string;
  description: string;
  assignee: string;
  tags: readonly string[];
  project_id: string | null;
  owner: Ref;
  agent_owner: Ref;
  participants: readonly Ref[] | unknown;
};
export type NameMaps = {
  /** `user:<id>` / `node:<id>` → 显示名(看不见的节点不在里面)。 */
  people: ReadonlyMap<string, string>;
  /** project_id → 项目名。 */
  projects: ReadonlyMap<string, string>;
};

const refName = (ref: Ref, maps: NameMaps): string => {
  if (!ref || typeof ref !== "object" || typeof ref.id !== "string" || (ref.kind !== "user" && ref.kind !== "node")) return "";
  return maps.people.get(`${ref.kind}:${ref.id}`) ?? "";
};

/** 一张卡能被搜到的文字,字段之间用换行隔开(一个词不会跨两个字段拼出来)。 */
export function searchText(row: SearchableRow, maps: NameMaps): string {
  const participants = Array.isArray(row.participants) ? row.participants as Ref[] : [];
  return fold([
    row.name,
    descriptionText(row.description),
    refName(row.owner, maps),
    refName(row.agent_owner, maps),
    ...participants.map(r => refName(r, maps)),
    row.assignee,
    row.project_id ? maps.projects.get(row.project_id) ?? "" : "",
    ...row.tags,
  ].filter(Boolean).join("\n"));
}

export function matchesTerms(row: SearchableRow, terms: readonly string[], maps: NameMaps): boolean {
  if (!terms.length) return true;
  const hay = searchText(row, maps);
  return terms.every(t => hay.includes(t));
}

export type Cursor = { createdAt: string; id: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.createdAt, c.id]), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor | null {
  if (!raw || raw.length > 600 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || typeof v[1] !== "string" || !v[0] || !v[1]) return null;
    return { createdAt: v[0], id: v[1] };
  } catch {
    return null;
  }
}

export type ListQuery = { limit: number; cursor: Cursor | null; terms: string[]; /** 整句当任务 ID 去对(taskIdQuery);空 = 没有搜索。 */ idQuery: string; /** #471 —— 只要带这个标签的卡(精确、区分大小写);null = 不按标签筛。 */ tag: string | null };

/**
 * 任务 ID(同 App 的 task-short-id.ts matchesTaskId):「#42」「42」精确对短号 seq;完整 id,或 8 位以上的
 * id 前缀(带不带 req_ 都行)对主键。整句当一个 ID —— 和文字匹配是「或」,不拆成「ID 且文字」。
 * 全角「＃４２」先 NFKC 归一(ID 本身都是 ASCII)。
 */
export const taskIdQuery = (q: string): string => q.trim().normalize("NFKC").toLowerCase();
export const seqOfQuery = (idQuery: string): number | null => {
  const m = /^#?(\d{1,15})$/.exec(idQuery);
  return m ? Number(m[1]) : null;
};
export function matchesTaskId(row: { requirement_id: string; seq?: number | null }, idQuery: string): boolean {
  if (!idQuery) return false;
  const n = seqOfQuery(idQuery);
  if (n !== null) return typeof row.seq === "number" && row.seq === n;
  const id = row.requirement_id.toLowerCase();
  if (idQuery === id) return true;
  const bare = idQuery.replace(/^req_/, "");
  return bare.length >= 8 && id.replace(/^req_/, "").startsWith(bare);
}

/** 解析 limit / cursor / q。不合法 → 错误码(400)。都没带 = 旧行为(500 行、第一页、不搜)。 */
export function parseListQuery(params: URLSearchParams): ListQuery | { error: string } {
  let limit = DEFAULT_LIST_LIMIT;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (!/^\d{1,5}$/.test(rawLimit)) return { error: "invalid_limit" };
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_LIST_LIMIT) return { error: "invalid_limit" };
  }
  let cursor: Cursor | null = null;
  const rawCursor = params.get("cursor");
  if (rawCursor !== null && rawCursor !== "") {
    cursor = decodeCursor(rawCursor);
    if (!cursor) return { error: "invalid_cursor" };
  }
  const q = params.get("q") ?? "";
  if (q.length > MAX_QUERY_LENGTH) return { error: "invalid_q" };
  const terms = searchTerms(q);
  // #471 —— tag=:和卡片标签同一套规范(去首尾空白、1–20 个字符、不含控制字符);不带 = 旧行为。
  const rawTag = params.get("tag");
  let tag: string | null = null;
  if (rawTag !== null) {
    tag = rawTag.trim();
    if (!tag || [...tag].length > 20 || /[\u0000-\u001f\u007f]/u.test(tag)) return { error: "invalid_tag" };
  }
  return { limit, cursor, terms, idQuery: terms.length ? taskIdQuery(q) : "", tag };
}
