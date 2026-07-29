// #221 — integration smoke for /api/upload + /api/files/:file_id + /api/task
// attachments. Spawns the real Bun.serve hub in a child process, hits it
// with real fetch() calls, asserts on the 6-item security checklist.
//
// Runs entirely under bun test — no Docker needed for the in-repo
// signal (Docker harness is documented in #221 for 测试马's UAT, but
// this file already exercises the same code path). The hub binds to
// an ephemeral port so multiple test runs don't collide.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, login } from "./auth.js";

const SERVER_DB = mkdtempSync(join(tmpdir(), "anet-upload-http-db-")) + "/commhub.db";
const UPLOADS_DIR = mkdtempSync(join(tmpdir(), "anet-upload-http-fs-"));
// #438 corrective: private bootServer({ port: 0 }) instance — the OS
// assigns the port and BASE is derived from the ACTUAL bound port, so
// this suite is immune to both the parent-side random-port TOCTOU and
// the aggregate module-cache no-op (import no longer boots anything).
let BASE = "";

let server: any;
let userToken = "";
let userNetworkId = "";

beforeAll(async () => {
  // Bootstrap a real admin + token on the temp DB so the server can
  // resolve it via requireAuth (we don't want to short-circuit auth —
  // we want to validate the production code path).
  process.env.COMMHUB_DB = SERVER_DB;
  process.env.COMMHUB_UPLOADS_DIR = UPLOADS_DIR;
  process.env.HOST = "127.0.0.1";

  // Use a unique username + strong password each run so we don't trip
  // over "already taken" from a prior test in the same DB. Strong
  // password keeps us past validatePasswordStrength even when we're
  // not the first user in the DB.
  const username = `upload_admin_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const password = "BootstrapPw123Aa!";
  let r = register(username, password, undefined, "seed");
  if (!r.ok) {
    console.error("[test bootstrap] register failed:", r.error);
  }
  if (r.token) {
    userToken = r.token;
    userNetworkId = r.network_id ?? "";
  } else {
    const lr = login(username, password);
    if (lr.token) userToken = lr.token;
    if (lr.network_id) userNetworkId = lr.network_id;
  }
  expect(userToken).toBeTruthy();

  // Importing is side-effect-free now; boot a private instance and
  // read the real port back.
  const { bootServer } = await import("./server.js");
  server = bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${server.port}`;
  // Tiny settle so the listener is ready.
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(UPLOADS_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(SERVER_DB, { recursive: true, force: true }); } catch {}
});

function authHeaders(): Record<string, string> {
  return { "Authorization": `Bearer ${userToken}` };
}

async function uploadFile(content: Uint8Array, filename: string, mime: string, opts: { skipAuth?: boolean; overrideContentLength?: string | null } = {}): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([content], { type: mime }), filename);
  const headers: Record<string, string> = opts.skipAuth ? {} : { ...authHeaders() };
  // Note: fetch sets Content-Length automatically; only override when
  // testing the missing-header path.
  const res = await fetch(`${BASE}/api/upload`, { method: "POST", body: form, headers });
  return res;
}

describe("POST /api/upload — 6-item security checklist (HTTP integration)", () => {
  test("(item 5) anonymous request → 401", async () => {
    const res = await uploadFile(new Uint8Array([1, 2, 3]), "tiny.bin", "application/octet-stream", { skipAuth: true });
    expect(res.status).toBe(401);
  });

  test("(item 5) bad bearer token → 401", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1, 2, 3])]), "tiny.bin");
    const res = await fetch(`${BASE}/api/upload`, {
      method: "POST",
      body: form,
      headers: { "Authorization": "Bearer this-is-not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  test("(items 1+2) successful upload returns server-generated file_id + url, blob lands inside uploads root", async () => {
    const content = new Uint8Array(1024).fill(0xab);
    const res = await uploadFile(content, "client-supplied-name.bin", "application/octet-stream");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.file_id).toBe("string");
    expect(body.file_id.length).toBe(32);
    expect(body.url).toBe(`/api/files/${body.file_id}`);
    expect(body.size).toBe(1024);
    // The path MUST live inside the configured uploads root.
    expect(String(body.path).startsWith(UPLOADS_DIR)).toBe(true);
    // The path MUST NOT contain the client-supplied filename.
    expect(String(body.path).includes("client-supplied-name")).toBe(false);
    // Blob really exists on disk.
    expect(existsSync(body.path)).toBe(true);
  });

  test("(item 4 stage-2) 12 MiB cap — slightly over the limit is rejected with 413", async () => {
    const overLimit = new Uint8Array(12 * 1024 * 1024 + 16).fill(0xcd);
    const res = await uploadFile(overLimit, "over.bin", "application/octet-stream");
    expect(res.status).toBe(413);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("payload_too_large");
    expect(body.limit_bytes).toBe(12 * 1024 * 1024);
  });

  test("(item 4 stage-1) missing Content-Length → 411 Length Required", async () => {
    // Forge a raw request with a body but no Content-Length. The
    // simplest way to do this in Bun is to construct a Request with a
    // streaming ReadableStream body — Bun then doesn't set
    // Content-Length on outgoing fetch.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not actually multipart"));
        controller.close();
      },
    });
    const res = await fetch(`${BASE}/api/upload`, {
      method: "POST",
      body: stream,
      headers: { ...authHeaders(), "Content-Type": "multipart/form-data; boundary=xxx", "Transfer-Encoding": "chunked" },
      // @ts-expect-error — Bun-specific to force streaming upload
      duplex: "half",
    });
    expect(res.status).toBe(411);
  });

  test("(extra defense) non-multipart body is rejected (415 or 400)", async () => {
    // We accept either 415 (Content-Type !multipart) or 400 (body
    // failed to parse as multipart). Both mean "we refused to accept
    // this body" which is the security property we care about; the
    // exact code depends on whether Bun's multipart parser bails before
    // or after our Content-Type pre-check.
    const res = await fetch(`${BASE}/api/upload`, {
      method: "POST",
      body: JSON.stringify({ nope: 1 }),
      headers: { ...authHeaders(), "Content-Type": "application/json" },
    });
    expect([400, 415]).toContain(res.status);
  });
});

describe("GET /api/files/:file_id — download safety", () => {
  let fileId = "";

  beforeAll(async () => {
    const content = new TextEncoder().encode("hello-world-from-#221-integration-test");
    const res = await uploadFile(content, "greeting.txt", "text/plain");
    const body = await res.json() as any;
    fileId = body.file_id;
  });

  test("(item 3) download returns the blob with Content-Disposition: attachment + X-Content-Type-Options: nosniff", async () => {
    const res = await fetch(`${BASE}/api/files/${fileId}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition") ?? "").toMatch(/^attachment(;|$)/i);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    const text = await res.text();
    expect(text).toBe("hello-world-from-#221-integration-test");
  });

  test("anonymous download is 401", async () => {
    const res = await fetch(`${BASE}/api/files/${fileId}`);
    expect(res.status).toBe(401);
  });

  test("traversal attempt in path is rejected at the regex layer with 400", async () => {
    const res = await fetch(`${BASE}/api/files/..%2Fetc%2Fpasswd`, { headers: authHeaders() });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("bad_file_id");
  });

  test("unknown file_id is 404", async () => {
    const res = await fetch(`${BASE}/api/files/0123456789abcdef0123456789abcdef`, { headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});

// NOTE on /api/task attachments coverage: the validation logic
// (validateAttachments) is exercised end-to-end in
// uploads.test.ts with 6 cases covering happy path / too-many /
// bad type / bad file_id / size cap / non-array. The HTTP wire-up
// (server/src/index.ts inside the /api/task handler) is a one-line
// merge that surfaces `validateAttachments`'s structured error as a
// 400 `bad_attachments` to the caller — see the #221 contract in
// the issue comment for the full request/response shape that N站马
// APP will consume.
