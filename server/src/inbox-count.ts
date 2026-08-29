import { db } from "./db.js";

/**
 * Unacked inbox rows for `alias` — the number a client should show as
 * "new". This is the count `new_task` has shipped since #1304; it is
 * lifted here verbatim so every SSE event that carries `inbox_count`
 * derives it the same way instead of hardcoding a digit.
 *
 * The SQL and its network scoping are unchanged from the `new_task`
 * sites (tools.ts / server.ts): falsy `networkId` means "no network
 * filter", matching both `addScope()` and the inline `if (taskNetId)`
 * guard those sites already use.
 *
 * The `?? 1` fallback only fires if the COUNT itself returns no row,
 * which SQLite does not do. It is not a default count: it is the
 * fail-closed direction for this gate. Every caller pushes right after
 * inserting an inbox row, so the floor is genuinely 1, and under-
 * reporting an unread (badge says 0, a message is sitting there) is the
 * failure this event exists to prevent.
 */
export function pendingInboxCount(alias: string, networkId?: string | null): number {
  const params: any[] = [alias];
  let sql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
  if (networkId) {
    sql += " AND network_id = ?2";
    params.push(networkId);
  }
  return db.get<{ cnt: number }>(sql, ...params)?.cnt ?? 1;
}
