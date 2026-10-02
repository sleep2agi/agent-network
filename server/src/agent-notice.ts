// Hub 以某个节点的名义发给一个用户的一条通知(#462 登录失效、#464 定时任务卡住)。
//
// 走 user_inbox + /events/users/me 的 desktop_message —— 与 send_desktop_message 同一张表、同一条推送,
// from_session = 节点别名,所以 App 把它显示在**与该节点的会话**里(主动消息)+ 未读角标 + 通知。不新增渠道。
// 只发给一个人;他不在本网络了就不发。推送在写库之后:收到推送的 App 立刻回读得到这一行。

import { db, uuidv4 } from "./db.js";
import { getUserNetworkRole } from "./auth.js";
import { pushUserEvent } from "./push.js";

export type AgentNotice = {
  networkId: string;
  userId: string;
  /** 节点别名:通知出现在与它的会话里。 */
  fromAlias: string;
  kind: string;
  title: string;
  text: string;
  severity?: "info" | "warning" | "error";
  meta: Record<string, unknown>;
  /** 消息 id 前缀(`dm_` 开头,与 App 的去重键同一套)。 */
  idPrefix: string;
};

/** 返回 message_id;没发(收件人不在本网络)→ null。 */
export function sendAgentNotice(n: AgentNotice): string | null {
  if (!getUserNetworkRole(n.userId, n.networkId)) return null;
  const messageId = `${n.idPrefix}${uuidv4()}`;
  const severity = n.severity ?? "warning";
  db.run(
    `INSERT INTO user_inbox (message_id, network_id, user_id, from_session, kind, title, content, severity, meta_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(message_id) DO NOTHING`,
    [messageId, n.networkId, n.userId, n.fromAlias, n.kind, n.title, n.text, severity, JSON.stringify(n.meta)],
  );
  pushUserEvent(n.networkId, n.userId, {
    type: "desktop_message",
    message_id: messageId,
    kind: n.kind,
    from: n.fromAlias,
    title: n.title,
    message: n.text,
    severity,
    created_at: new Date().toISOString(),
    meta: n.meta,
  });
  return messageId;
}
