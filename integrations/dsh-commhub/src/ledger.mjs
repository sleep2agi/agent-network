// Small durable ledger of task ids this node has handled, so a reconnect, a
// duplicate doorbell, or a plugin restart never produces a second reply.
// States: started → answered (reply text kept until the hub accepts it) → done.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_ENTRIES = 500;

export function createLedger(path) {
  let entries = {};
  if (path) {
    try { entries = JSON.parse(readFileSync(path, "utf8")).tasks ?? {}; } catch { entries = {}; }
  }
  const persist = () => {
    if (!path) return;
    const ids = Object.keys(entries);
    if (ids.length > MAX_ENTRIES) {
      ids.sort((a, b) => (entries[a].at ?? 0) - (entries[b].at ?? 0));
      for (const id of ids.slice(0, ids.length - MAX_ENTRIES)) delete entries[id];
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tasks: entries }), { mode: 0o600 });
    renameSync(tmp, path);
  };
  return {
    get: (id) => entries[id],
    set(id, value) { entries[id] = { ...value, at: Date.now() }; persist(); },
    snapshot: () => JSON.parse(JSON.stringify(entries)),
  };
}
