import { join } from "node:path";
import { readSync } from "node:fs";
import { DaemonProviderError, DaemonProviderStore } from "./daemon-provider-store";
import { scanDaemonCodex } from './daemon-codex-inventory';
import { collectDaemonProvider } from './daemon-provider-collect';

export const DAEMON_PROVIDER_USAGE = "anet daemon provider <list|scan|put|collect|apply|initialize> <daemon> [--revision N] [--request dps_UUID] (put/collect/scan/apply/initialize read private JSON from stdin; no key in argv)";
export function readProviderInput(fd = 0): string {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(4096);
    const bytes = readSync(fd, chunk, 0, chunk.length, null);
    if (!bytes) return Buffer.concat(chunks, total).toString("utf8");
    total += bytes;
    if (total > 64 * 1024) throw new DaemonProviderError("input_too_large");
    chunks.push(chunk.subarray(0, bytes));
  }
}
export function runDaemonProvider(args: string[], deps: { nodesDir: string; readInput: () => string; print: (text: string) => void }): number {
  const [action, daemon, ...rest] = args;
  if (!["list", "scan", "put", "collect", "prepare-login"].includes(action) || !daemon || !/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,99}$/u.test(daemon)
    || (["list", "prepare-login"].includes(action) && rest.length !== 0)
    || (action === 'scan' && !(rest.length === 0 || (rest.length === 1 && rest[0] === '--discover-local')))
    || (["put", "collect"].includes(action) && (![2, 4].includes(rest.length) || rest[0] !== "--revision" || !/^(0|[1-9][0-9]*)$/.test(rest[1])
      || (rest.length === 4 && (rest[2] !== '--request' || !/^dps_[a-f0-9-]{36}$/.test(rest[3])))))) {
    deps.print(DAEMON_PROVIDER_USAGE); return 2;
  }
  try {
    const store = new DaemonProviderStore(join(deps.nodesDir, daemon));
    if (action === 'prepare-login') deps.print(JSON.stringify({ ok: true, ...store.prepareLoginDirectory() }));
    else if (action === "scan") {
      const snapshot = store.list();
      const input = deps.readInput();
      if (Buffer.byteLength(input) > 64 * 1024) throw new DaemonProviderError('input_too_large');
      const codex_inventory = scanDaemonCodex(deps.nodesDir, JSON.parse(input), snapshot.network_id, undefined, rest[0] === '--discover-local');
      deps.print(JSON.stringify({ ok: true, ...snapshot, codex_inventory }));
    } else if (action === "list") deps.print(JSON.stringify({ ok: true, ...store.list() }));
    else {
      const input = deps.readInput();
      if (Buffer.byteLength(input) > 64 * 1024) throw new DaemonProviderError("input_too_large");
      let value: unknown;
      try { value = JSON.parse(input); } catch { throw new DaemonProviderError("invalid_json"); }
      const saved = action === 'collect' ? collectDaemonProvider(deps.nodesDir, store, value as any, Number(rest[1]), rest[3])
        : store.upsert(value, Number(rest[1]), rest[3]);
      deps.print(JSON.stringify({ ok: true, ...saved }));
    }
    return 0;
  } catch (error) {
    // Raw fs/parser errors can contain file content or paths. Only fixed codes
    // leave this boundary; credentials never appear in errors or receipts.
    deps.print(JSON.stringify({ ok: false, error: error instanceof DaemonProviderError ? error.code : "provider_store_unavailable" }));
    return 1;
  }
}
