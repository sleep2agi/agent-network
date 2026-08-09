// #503 — the DEV_OPEN half of the upload attribution matrix (row U3).
//
// Separate file for the same reason #495/#500 split theirs: DEV_OPEN is
// frozen at server.ts module-load time, so it cannot be flipped inside a
// process that already loaded the module with DEV_OPEN=false.
//
// The row that matters: an unauthenticated DEV_OPEN caller must NOT be
// able to file a blob into a real tenant network, even by asking for one
// via ?network_id=. The upload succeeds (that is the point of dev-open
// mode) but lands unattributed, and "unattributed" must be the key being
// ABSENT rather than written as null — the writer and validateIndexEntry
// have to agree on one shape or a dev-mode upload would be unreadable by
// its own server.

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SERVER_DB = mkdtempSync(join(tmpdir(), "anet-503-devopen-db-")) + "/commhub.db";
const UPLOADS_DIR = mkdtempSync(join(tmpdir(), "anet-503-devopen-fs-"));

process.env.COMMHUB_DB ||= SERVER_DB;
process.env.COMMHUB_UPLOADS_DIR = UPLOADS_DIR;
process.env.HOST = "127.0.0.1";
process.env.COMMHUB_DEV_OPEN = "1";
delete process.env.COMMHUB_AUTH_TOKEN;

const { register } = await import("./auth.js");

const stamp = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
const seed = register(`u503dorealnet${stamp}`, "BootstrapPw123Aa!", undefined, "seed");
if (!seed.ok) throw new Error(`seed register failed: ${seed.error}`);
const REAL_NETWORK_ID = seed.network_id!;

const { bootServer } = await import("./server.js");
const server = bootServer({ port: 0, hostname: "127.0.0.1" });
const BASE = `http://127.0.0.1:${server.port}`;
await new Promise((r) => setTimeout(r, 100));

async function uploadAnon(body: string, filename: string, networkId?: string): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([new TextEncoder().encode(body)], { type: "application/octet-stream" }), filename);
  const url = networkId
    ? `${BASE}/api/upload?network_id=${encodeURIComponent(networkId)}`
    : `${BASE}/api/upload`;
  return fetch(url, { method: "POST", body: form });
}

// Probe whether the loaded module really has DEV_OPEN on. In an aggregate
// run a sibling may have loaded server.ts first; `skipIf` then reports
// "skipped" rather than a green that measured the wrong build.
const devOpenActive = (await uploadAnon("probe", "probe.bin")).status === 200;

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(UPLOADS_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(SERVER_DB, { recursive: true, force: true }); } catch {}
  delete process.env.COMMHUB_DEV_OPEN;
});

function readEntry(fileId: string): any {
  return JSON.parse(readFileSync(join(UPLOADS_DIR, ".index", `${fileId}.json`), "utf-8"));
}

describe.skipIf(!devOpenActive)("#503 U3 — DEV_OPEN anonymous uploads are never attributed to a network", () => {
  test("U3: anonymous DEV_OPEN upload asking for a REAL network → 200, but the network_id key is absent", async () => {
    // The requested network genuinely exists, so an absent key proves the
    // request was refused attribution, not that the lookup missed.
    const { db } = await import("./db.js");
    expect(db.get<any>("SELECT * FROM networks WHERE network_id = ?1", REAL_NETWORK_ID)).toBeTruthy();

    const res = await uploadAnon("dev-open-payload", "u3.bin", REAL_NETWORK_ID);
    expect(res.status).toBe(200);
    const fileId = (await res.json() as any).file_id;

    const entry = readEntry(fileId);
    expect("network_id" in entry).toBe(false);
    expect(entry.network_id).toBeUndefined();
    expect(entry.owner_id).toBeNull();
  });

  test("U3b: an unattributed DEV_OPEN blob is still readable by its own server (writer and validator agree)", async () => {
    const res = await uploadAnon("round-trip", "u3b.bin");
    expect(res.status).toBe(200);
    const fileId = (await res.json() as any).file_id;
    expect("network_id" in readEntry(fileId)).toBe(false);

    // If the writer had emitted `network_id: null`, validateIndexEntry
    // would reject the entry here and this would 404 — the "自己打死
    // 自己" failure the spread pattern exists to prevent.
    const dl = await fetch(`${BASE}/api/files/${fileId}`);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe("round-trip");
    expect(existsSync(join(UPLOADS_DIR, ".index", `${fileId}.json`))).toBe(true);
  });
});
