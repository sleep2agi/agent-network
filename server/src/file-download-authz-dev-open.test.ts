// #495 — DEV_OPEN mode null-owner allowance (Test B from PR #500 CR
// checklist). Sibling to file-download-authz.test.ts.
//
// Why a separate file: DEV_OPEN is captured at server.ts module-load
// time (`const DEV_OPEN = process.argv.includes("--dev-open") ||
// process.env.COMMHUB_DEV_OPEN === "1"`). Once the singleton is
// loaded with DEV_OPEN=false, no `process.env` change can flip it
// back inside the same Bun process. So the DEV_OPEN test lives in
// its own file that sets `COMMHUB_DEV_OPEN=1` BEFORE importing.
//
// Skip discipline: if this file runs in aggregate `bun test src/`
// AFTER file-download-authz.test.ts has already loaded server.ts
// with DEV_OPEN=false, our env change is ignored. We detect that at
// module load via a boot probe and `test.skipIf` the whole file so
// the runner reports "skipped" (NOT "passed"). Standalone run
// (`bun test src/file-download-authz-dev-open.test.ts`) always
// works — CI must include a standalone target for this file to
// guarantee it actually executes.

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SERVER_DB = mkdtempSync(join(tmpdir(), "anet-495-devopen-db-")) + "/commhub.db";
const UPLOADS_DIR = mkdtempSync(join(tmpdir(), "anet-495-devopen-fs-"));

// Set env BEFORE importing anything that touches db-adapter.ts or
// server.ts (both capture env at module load).
process.env.COMMHUB_DB = SERVER_DB;
process.env.COMMHUB_UPLOADS_DIR = UPLOADS_DIR;
process.env.HOST = "127.0.0.1";
process.env.COMMHUB_DEV_OPEN = "1";
delete process.env.COMMHUB_AUTH_TOKEN;

const { register } = await import("./auth.js");
const nameA = `useraaa_devopen_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
const rA = register(nameA, "BootstrapPw123Aa!", undefined, "userA");
if (!rA.ok) throw new Error(`userA register failed: ${rA.error}`);
const userAToken = rA.token!;

const { bootServer } = await import("./server.js");
const server = bootServer({ port: 0, hostname: "127.0.0.1" });
const BASE = `http://127.0.0.1:${server.port}`;
await new Promise((r) => setTimeout(r, 100));

// Probe: is DEV_OPEN active in the loaded server module? Upload a file
// with no auth — DEV_OPEN allows anon; production would 401.
async function probeDevOpen(): Promise<boolean> {
  const form = new FormData();
  form.append("file", new Blob([new TextEncoder().encode("probe")], { type: "application/octet-stream" }), "probe.bin");
  const res = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
  return res.status === 200;
}
const devOpenActive = await probeDevOpen();

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(UPLOADS_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(SERVER_DB, { recursive: true, force: true }); } catch {}
  delete process.env.COMMHUB_DEV_OPEN;
});

async function uploadAnon(content: Uint8Array, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "application/octet-stream" }), filename);
  const res = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(typeof body.file_id).toBe("string");
  return body.file_id;
}

async function downloadAs(token: string | null, fileId: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE}/api/files/${fileId}`, { headers });
}

describe.skipIf(!devOpenActive)("#495 — DEV_OPEN null-owner allowance (Test B)", () => {
  test("null-owner uploaded via anonymous DEV_OPEN request → normal user can download (200)", async () => {
    const devOpenFileId = await uploadAnon(new TextEncoder().encode("dev-open-blob"), "dev.bin");

    // Verify the upload really produced null-owner (matches the shape
    // production callers might see if DEV_OPEN were misconfigured).
    const { readFileSync } = await import("fs");
    const entryPath = join(UPLOADS_DIR, ".index", `${devOpenFileId}.json`);
    if (existsSync(entryPath)) {
      const entry = JSON.parse(readFileSync(entryPath, "utf-8"));
      expect(entry.owner_id).toBeNull();
    }

    const res = await downloadAs(userAToken, devOpenFileId);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("dev-open-blob");
  });
});
