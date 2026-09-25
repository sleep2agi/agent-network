// node_rules_requests content retention (privacy).
//
// The rules-file / skills (and project-folder) queue carries **node file
// contents** through the hub: `result_content` holds what the node sent back
// (CLAUDE.md / AGENTS.md, SKILL.md, directory listings, file bodies) and
// `content` holds write payloads (the full new rules file). Before this module
// nothing ever cleared or deleted those rows — every file anyone ever opened in
// the desktop app stayed in the hub DB forever.
//
// Policy (metadata — status, op, file_name, file_exists, error, timestamps,
// requester — is kept for audit; only file bytes are dropped):
//
//   1. Read-once + grace: the first time an authorized requester reads a
//      TERMINAL result (done/failed/timeout) the row is stamped `first_read_at`.
//      CONTENT_GRACE_MS later the content is purged. Not immediate, because the
//      desktop app has a real second-reader path: when enqueue is rejected with
//      `request_in_flight` the app FOLLOWS the existing request id
//      (requestIdToFollow → waitForRulesFileResult, NodeRulesSection /
//      NodeSkillsSection / NodeFilesSection). Two windows (or a remount) polling
//      the same request reach terminal within one poll interval (≤ 3 s) of each
//      other; an immediate purge would hand the second one `done` with no
//      content and NodeRulesSection would load an EMPTY editor (`content ?? ''`)
//      that a Save would then write back to the node. 60 s is 20× the slowest
//      poll interval.
//   2. TTL: anything older than CONTENT_TTL_MS gets its content purged whether
//      or not anyone ever read it (e.g. the app was closed mid-request). A
//      still-pending/in_progress row that old is first flipped to `timeout`, so
//      a node that comes back after a day can never pull a write whose payload
//      was just nulled (it would otherwise receive `content: ""` and write an
//      empty rules file).
//   3. Rows older than ROW_TTL_MS are deleted outright.
//
// Every statement is bounded (LIMIT via `request_id IN (SELECT … LIMIT n)` —
// SQLite's UPDATE/DELETE … LIMIT needs a compile flag we don't control) and
// uses an index (idx_nrr_created / idx_nrr_first_read). It runs
// opportunistically on enqueue and on terminal reads, from a one-shot timer
// armed at the first terminal read, and from the hourly retention sweeper
// (retention.ts) — so the first sweep after deploy also clears every old row
// that predates this module.

import { db } from "./db.js";

export const CONTENT_GRACE_MS = 60_000;
export const CONTENT_TTL_MS = 24 * 60 * 60 * 1000;
export const ROW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SWEEP_BATCH = 500;

export type NodeRequestSweepResult = { timedOut: number; purged: number; deleted: number };

// `content` is only a file body for op=write. For skill_read / file_read it is
// the skill name / relative path the requester asked for — audit metadata, kept.
const PURGE_SET =
  "result_content = NULL, content = CASE WHEN op = 'write' THEN NULL ELSE content END, content_purged_at = ?1";

function purgeWhere(where: string, params: (string | number)[], now: number): number {
  const r = db.run(
    `UPDATE node_rules_requests SET ${PURGE_SET} WHERE request_id IN (SELECT request_id FROM node_rules_requests WHERE content_purged_at IS NULL AND ${where} LIMIT ${SWEEP_BATCH})`,
    [now, ...params],
  );
  return r.changes ?? 0;
}

export function sweepNodeRequestContent(now: number = Date.now()): NodeRequestSweepResult {
  const out: NodeRequestSweepResult = { timedOut: 0, purged: 0, deleted: 0 };
  try {
    // Delete first so rows past the row TTL aren't pointlessly purged, then
    // expire stale non-terminal rows, then purge.
    out.deleted = db.run(
      `DELETE FROM node_rules_requests WHERE request_id IN (SELECT request_id FROM node_rules_requests WHERE created_at < ?1 LIMIT ${SWEEP_BATCH})`,
      [now - ROW_TTL_MS],
    ).changes ?? 0;
    const ttlCutoff = now - CONTENT_TTL_MS;
    out.timedOut = db.run(
      `UPDATE node_rules_requests SET status = 'timeout', acked_at = ?1, error = ?2 WHERE request_id IN (SELECT request_id FROM node_rules_requests WHERE created_at < ?3 AND status IN ('pending', 'in_progress') LIMIT ${SWEEP_BATCH})`,
      [now, "expired by retention sweep (node never answered)", ttlCutoff],
    ).changes ?? 0;
    // ?1 = now (PURGE_SET), ?2… = where params.
    out.purged += purgeWhere("first_read_at IS NOT NULL AND first_read_at <= ?2 AND status IN ('done', 'failed', 'timeout')", [now - CONTENT_GRACE_MS], now);
    out.purged += purgeWhere("created_at < ?2 AND status IN ('done', 'failed', 'timeout')", [ttlCutoff], now);
  } catch (e: any) {
    console.log(`[commhub retention] node_rules_requests sweep failed: ${e?.message ?? e}`);
  }
  return out;
}

/** Called by get_rules_file_result AFTER the requester passed every auth check
 *  and only for a terminal status. Stamps the first terminal read, arms a
 *  one-shot purge for after the grace window, and reports whether this row's
 *  content is already gone. */
export function noteTerminalResultRead(requestId: string, now: number = Date.now()): { purged: boolean } {
  const r = db.run(
    "UPDATE node_rules_requests SET first_read_at = ?1 WHERE request_id = ?2 AND first_read_at IS NULL",
    [now, requestId],
  );
  if ((r.changes ?? 0) > 0) {
    const t = setTimeout(() => { sweepNodeRequestContent(); }, CONTENT_GRACE_MS + 1_000);
    (t as any).unref?.();
  }
  const row = db.get<{ content_purged_at: number | null }>(
    "SELECT content_purged_at FROM node_rules_requests WHERE request_id = ?1",
    requestId,
  );
  return { purged: row?.content_purged_at != null };
}
