// 多用户 Agent 权限 —— 受限成员与上传文件。
// 文件按网络归属;受限成员(只看授权 Agent 的成员)在受限网络里不能凭 file_id 读网络里任意文件,
// 也不能把自己看不见的 file_id 塞进发给授权 Agent 的任务(那等于借 Agent 的网络令牌去读)。
import { existsSync, readFileSync } from "fs";
import { db } from "./db.js";
import { addOwnTrafficScope, type RestNetworkScope } from "./network-scope.js";
import { FILE_ID_REGEX, indexEntryPath, validateIndexEntry } from "./uploads.js";

/**
 * 受限成员能不能看见这个文件:只认**对方(授权 Agent / 给他发私信的人)放进来**的附件 ——
 *   user_inbox 里发给自己的私信附件;
 *   授权 Agent 发给自己的任务 / inbox 行的 attachments;
 *   自己发给授权 Agent 的任务上,Agent 回复写进的 reply_attachments。
 * 自己随任务带出去的 attachments **不算**:否则把任意 file_id 塞进自己的任务就能「解锁」别人的文件。
 */
export function restrictedMemberSeesFile(userId: string, username: string, networkId: string, fileId: string): boolean {
  if (!FILE_ID_REGEX.test(fileId)) return false;
  const listed = (metaJson: string | null | undefined, key: "attachments" | "reply_attachments"): boolean => {
    if (!metaJson) return false;
    try {
      const list = JSON.parse(metaJson)?.[key];
      return Array.isArray(list) && list.some((a: any) => a && typeof a === "object" && a.file_id === fileId);
    } catch { return false; }
  };
  // LIKE 只做预筛(file_id 只含 [A-Za-z0-9_-],`_` 转义后逐字匹配),真正的判定在 listed() 里按键解析。
  const needle = `%"${fileId.replace(/_/g, "\\_")}"%`;
  for (const row of db.all<{ meta_json: string | null }>(
    "SELECT meta_json FROM user_inbox WHERE user_id = ?1 AND network_id = ?2 AND meta_json LIKE ?3 ESCAPE '\\' LIMIT 50",
    userId, networkId, needle,
  )) {
    if (listed(row.meta_json, "attachments")) return true;
  }
  const scope: RestNetworkScope = { networkId, networkIds: null, agentRestriction: { userId, username, networkIds: [networkId] } };
  const taskParams: unknown[] = [needle];
  const taskSql = addOwnTrafficScope("SELECT from_name, to_name, meta_json FROM tasks WHERE meta_json LIKE ?1 ESCAPE '\\'", taskParams, scope, { from: "from_name", to: "to_name", fromNodeId: "from_node_id", toNodeId: "to_node_id" });
  for (const row of db.all<{ from_name: string; to_name: string; meta_json: string | null }>(taskSql + " LIMIT 50", ...taskParams)) {
    if (row.to_name === username && listed(row.meta_json, "attachments")) return true;
    if (row.from_name === username && listed(row.meta_json, "reply_attachments")) return true;
  }
  const inboxParams: unknown[] = [needle];
  const inboxSql = addOwnTrafficScope("SELECT session_name, meta_json FROM inbox WHERE meta_json LIKE ?1 ESCAPE '\\'", inboxParams, scope, { from: "from_session", to: "session_name" });
  for (const row of db.all<{ session_name: string; meta_json: string | null }>(inboxSql + " LIMIT 50", ...inboxParams)) {
    if (row.session_name === username && listed(row.meta_json, "attachments")) return true;
  }
  return false;
}

/** 受限成员能不能用这个文件(下载 / 当附件转给 Agent):自己传的,或 restrictedMemberSeesFile。 */
export function restrictedMemberCanUseFile(userId: string, username: string, networkId: string, fileId: string): boolean {
  if (!FILE_ID_REGEX.test(fileId)) return false;
  const path = indexEntryPath(fileId);
  if (!path || !existsSync(path)) return false;
  let entry: any;
  try { entry = JSON.parse(readFileSync(path, "utf8")); } catch { return false; }
  if (!validateIndexEntry(entry) || entry.file_id !== fileId) return false;
  if (entry.network_id !== networkId) return false;
  if (entry.owner_id === userId) return true;
  return restrictedMemberSeesFile(userId, username, networkId, fileId);
}

/**
 * 受限成员发给 Agent 的任务 / 消息里的附件:每个 file_id 都必须是他自己能用的文件。
 * 返回第一个不合格的 file_id(调用方回 403),全部合格返回 null。
 */
export function restrictedMemberAttachmentsDenied(userId: string, username: string, networkId: string, raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    const fileId = item && typeof item === "object" ? (item as { file_id?: unknown }).file_id : undefined;
    if (fileId === undefined) continue;
    if (typeof fileId !== "string" || !restrictedMemberCanUseFile(userId, username, networkId, fileId)) return String(fileId);
  }
  return null;
}
