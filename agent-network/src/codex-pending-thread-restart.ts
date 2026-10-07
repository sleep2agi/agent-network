import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * #602 — what `anet node start` does with a `codexPendingThread` it finds in
 * the node config before launching a new co-presence generation.
 *
 * The candidate is written by the bridge when the TUI opens a thread that has
 * not had a conversation yet (codex only writes a rollout on the first turn).
 * It is bound to the identity marker of the generation that saw it, so a
 * restart after a crash can carry it over to the next generation without
 * guessing (`migrateCodexPendingThread`) once its exact rollout exists. A
 * candidate acknowledged by RPC but never materialized remains pending and
 * is dropped on the next start, even if the old marker file survived.
 *
 * A clean `anet node stop` reaps that generation and removes its marker, but
 * the candidate stays in the config. Before #602 the next start then refused
 * for good: "pending Codex thread is not bound to the exact private
 * previous-generation marker" — every node whose TUI was never used could be
 * stopped once and never started again.
 *
 * A candidate whose marker file is gone AND whose thread has no rollout under
 * this node's CODEX_HOME holds nothing: codex never persisted the thread, its
 * app-server generation is gone, and no app-server can resume it. Dropping it
 * adopts nothing and loses nothing; the new generation starts a fresh thread
 * exactly like a first start. Everything else keeps the old fail-closed
 * answer — in particular a candidate whose thread HAS a rollout while the
 * marker that bound it is gone is never adopted, because nothing proves the
 * binding was ours.
 */
export type PendingThreadAtStart =
  | { kind: "none" }
  | { kind: "migrate"; oldMarker: string }
  | { kind: "drop-unmaterialized"; threadId: string }
  | { kind: "refuse"; reason: string };

export type PendingMarkerFact =
  | { kind: "ok"; marker: string }
  | { kind: "missing" }
  | { kind: "unreadable"; cause: string };

/** Rollout files for exactly this thread id (suffix match, no prefix guessing), or `null` if the search itself failed. */
export type RolloutLookup = (threadId: string) => string[] | null;

const THREAD_ID = /^[A-Za-z0-9_-]{8,200}$/;

export function decidePendingThreadAtStart(
  pending: unknown,
  marker: PendingMarkerFact,
  rollouts: RolloutLookup,
): PendingThreadAtStart {
  if (pending === undefined) return { kind: "none" };
  const p = pending as { version?: unknown; threadId?: unknown; marker?: unknown } | null;
  const markerOf = typeof p?.marker === "string" ? p.marker : undefined;
  if (marker.kind === "ok") {
    if (markerOf === undefined || markerOf !== marker.marker) {
      return { kind: "refuse", reason: "the pending candidate is bound to a different marker than the one on disk" };
    }
    if (!p || p.version !== 1 || typeof p.threadId !== "string" || !THREAD_ID.test(p.threadId)) {
      return { kind: "refuse", reason: "the pending candidate is malformed" };
    }
    const found = rollouts(p.threadId);
    if (found === null) return { kind: "refuse", reason: "could not search CODEX_HOME for the candidate's rollout" };
    return found.length === 0
      ? { kind: "drop-unmaterialized", threadId: p.threadId }
      : { kind: "migrate", oldMarker: marker.marker };
  }
  if (marker.kind === "unreadable") {
    return { kind: "refuse", reason: `the identity marker cannot be trusted (${marker.cause})` };
  }
  // Marker file is absent: the generation that bound the candidate was stopped (or never existed).
  if (!p || p.version !== 1 || typeof p.threadId !== "string" || !THREAD_ID.test(p.threadId)) {
    return { kind: "refuse", reason: "the pending candidate is malformed" };
  }
  const found = rollouts(p.threadId);
  if (found === null) return { kind: "refuse", reason: "could not search CODEX_HOME for the candidate's rollout" };
  if (found.length > 0) {
    return { kind: "refuse", reason: `the candidate thread has a rollout (${found[0]}) but the marker that bound it is gone` };
  }
  return { kind: "drop-unmaterialized", threadId: p.threadId };
}

/**
 * Every `*-<threadId>.jsonl` under `<codexHome>/sessions` and
 * `<codexHome>/archived_sessions`. A missing directory is "no rollouts"; any
 * other read error makes the whole lookup `null` (the caller then refuses).
 */
export function findThreadRollouts(codexHome: string, threadId: string): string[] | null {
  const out: string[] = [];
  let failed = false;
  const walk = (dir: string, depth: number, isRoot: boolean) => {
    if (depth > 6 || failed) return;
    let entries: string[];
    try { entries = readdirSync(dir); }
    catch (e: any) {
      if (isRoot && e?.code === "ENOENT") return;
      failed = true;
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let st;
      try { st = lstatSync(path); } catch { failed = true; return; }
      if (st.isDirectory()) walk(path, depth + 1, false);
      else if (name.endsWith(`-${threadId}.jsonl`)) out.push(path);
    }
  };
  for (const sub of ["sessions", "archived_sessions"]) walk(join(codexHome, sub), 0, true);
  return failed ? null : out.sort();
}
