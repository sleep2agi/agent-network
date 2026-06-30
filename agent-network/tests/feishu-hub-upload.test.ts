/**
 * RFC-020 §17 — feishu inbound bridge → hub /api/upload tests.
 *
 * Covers:
 *   - happy-path upload (file_id returned)
 *   - 12 MiB cap skip
 *   - missing / empty file skip
 *   - hub non-2xx (401, 413, 429, 500) → null fallback
 *   - hub down (fetch throws) → null fallback
 *   - malformed JSON response → null fallback
 *   - missing file_id in response → null fallback
 *   - concurrency cap (uploadFilesToHubConcurrent)
 *   - order preservation
 *   - mime sniffing from extension
 *
 * Run: `bun tests/feishu-hub-upload.test.ts`
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  uploadToHub,
  uploadFilesToHubConcurrent,
  HUB_UPLOAD_LIMIT_BYTES,
  DEFAULT_UPLOAD_CONCURRENCY,
} from "../src/im/feishu/hub-upload";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function mkTempFile(content: string | Buffer, ext: string = "png"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-hub-upload-"));
  const file = path.join(dir, `probe.${ext}`);
  fs.writeFileSync(file, content);
  return file;
}

function makeFetchMock(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return (async (url: any, init?: any) => handler(String(url), init)) as any;
}

// ── 1. Happy path ──────────────────────────────────────────────────────────

{
  const file = mkTempFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]), "png");
  let captured: { url?: string; auth?: string; hasFile?: boolean } = {};
  const fetchMock = makeFetchMock(async (url, init) => {
    captured.url = url;
    captured.auth = (init?.headers as any)?.Authorization;
    captured.hasFile = init?.body instanceof FormData;
    return new Response(
      JSON.stringify({ ok: true, file_id: "abc123def456", path: "/hub/uploads/2026-06-30/abc123def456.png" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  const r = await uploadToHub(file, {
    hubUrl: "http://hub.example.com",
    authToken: "ntok_FAKE_TEST_FIXTURE_XXXXX",
    fetch: fetchMock,
  });
  expect("happy: returns file_id", r?.file_id === "abc123def456", JSON.stringify(r));
  expect("happy: returns size", r?.size === 12, `got: ${r?.size}`);
  expect("happy: sniffs PNG mime", r?.mime === "image/png", `got: ${r?.mime}`);
  expect("happy: posted to /api/upload", captured.url?.endsWith("/api/upload") === true, captured.url);
  expect("happy: bearer auth header", captured.auth?.startsWith("Bearer ntok_") === true, captured.auth);
  expect("happy: multipart form body", captured.hasFile === true);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

// ── 2. File size cap (>12 MiB) → skip with stderr warn ────────────────────

{
  const big = Buffer.alloc(HUB_UPLOAD_LIMIT_BYTES + 1, 0);
  const file = mkTempFile(big, "bin");
  let fetched = false;
  const fetchMock = makeFetchMock(async () => {
    fetched = true;
    return new Response("should not reach", { status: 200 });
  });
  const r = await uploadToHub(file, {
    hubUrl: "http://hub.example.com",
    authToken: "ntok_X",
    fetch: fetchMock,
  });
  expect("oversize: returns null", r === null);
  expect("oversize: no fetch made", fetched === false);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

// ── 3. Missing / empty file → null without fetch ──────────────────────────

{
  let fetched = false;
  const fetchMock = makeFetchMock(async () => {
    fetched = true;
    return new Response("nope", { status: 200 });
  });
  const r1 = await uploadToHub("/tmp/__definitely__does__not__exist", {
    hubUrl: "http://hub.example.com",
    authToken: "ntok_X",
    fetch: fetchMock,
  });
  expect("missing file: returns null", r1 === null);
  expect("missing file: no fetch", fetched === false);

  const empty = mkTempFile(Buffer.alloc(0), "png");
  const r2 = await uploadToHub(empty, {
    hubUrl: "http://hub.example.com",
    authToken: "ntok_X",
    fetch: fetchMock,
  });
  expect("empty file: returns null", r2 === null);
  expect("empty file: no fetch", fetched === false);
  fs.rmSync(path.dirname(empty), { recursive: true, force: true });
}

// ── 4. Hub non-2xx → null fallback ────────────────────────────────────────

for (const status of [401, 413, 429, 500, 502, 503]) {
  const file = mkTempFile(Buffer.from([0x89, 0x50, 1, 2, 3, 4, 5, 6, 7, 8]), "png");
  const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ ok: false, error: "x" }), { status }));
  const r = await uploadToHub(file, {
    hubUrl: "http://hub.example.com",
    authToken: "ntok_X",
    fetch: fetchMock,
  });
  expect(`hub ${status} → null fallback`, r === null, `got: ${JSON.stringify(r)}`);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

// ── 5. Hub down (fetch throws) → null fallback ────────────────────────────

{
  const file = mkTempFile(Buffer.from([0x89, 0x50, 1, 2, 3, 4, 5, 6, 7, 8]), "png");
  const fetchMock = makeFetchMock(async () => {
    throw new Error("ECONNREFUSED");
  });
  const r = await uploadToHub(file, {
    hubUrl: "http://hub.example.com",
    authToken: "ntok_X",
    fetch: fetchMock,
  });
  expect("hub down: null fallback (no throw)", r === null);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

// ── 6. Malformed JSON response → null fallback ────────────────────────────

{
  const file = mkTempFile(Buffer.from([0x89, 0x50, 1, 2, 3, 4, 5, 6, 7, 8]), "png");
  const fetchMock = makeFetchMock(async () => new Response("<html>not json</html>", { status: 200 }));
  const r = await uploadToHub(file, {
    hubUrl: "http://hub.example.com",
    authToken: "ntok_X",
    fetch: fetchMock,
  });
  expect("malformed JSON: null fallback", r === null);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

// ── 7. Missing file_id in response → null fallback ────────────────────────

{
  const file = mkTempFile(Buffer.from([0x89, 0x50, 1, 2, 3, 4, 5, 6, 7, 8]), "png");
  const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ ok: true, oops_no_id: 1 }), { status: 200 }));
  const r = await uploadToHub(file, {
    hubUrl: "http://hub.example.com",
    authToken: "ntok_X",
    fetch: fetchMock,
  });
  expect("missing file_id field: null fallback", r === null);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

// ── 8. Mime sniff coverage ────────────────────────────────────────────────

for (const [ext, expectedMime] of [
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["pdf", "application/pdf"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["txt", "text/plain"],
  ["unknownext", "application/octet-stream"],
] as const) {
  const file = mkTempFile(Buffer.from([1, 2, 3, 4]), ext);
  const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ file_id: "x" + ext + "0000" }), { status: 200 }));
  const r = await uploadToHub(file, { hubUrl: "http://x", authToken: "ntok_X", fetch: fetchMock });
  expect(`mime sniff: .${ext} → ${expectedMime}`, r?.mime === expectedMime, `got: ${r?.mime}`);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

// ── 9. uploadFilesToHubConcurrent — order preservation + cap ──────────────

{
  // Build 10 files
  const files = Array.from({ length: 10 }, (_, i) =>
    mkTempFile(Buffer.from(`hello ${i}`.padEnd(20, "x")), "png"),
  );
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const fetchMock = makeFetchMock(async (url, init) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return new Response(JSON.stringify({ file_id: `file_${calls}` }), { status: 200 });
  });
  const all = await uploadFilesToHubConcurrent(
    files,
    { hubUrl: "http://hub", authToken: "ntok_X", fetch: fetchMock },
    4,
  );
  expect("concurrent: 10 results", all.length === 10);
  expect(
    "concurrent: max in-flight ≤ 4 (cap respected)",
    maxInFlight <= 4,
    `maxInFlight=${maxInFlight}`,
  );
  expect("concurrent: all returned file_id", all.every((r) => r?.file_id?.startsWith("file_")));
  for (const f of files) fs.rmSync(path.dirname(f), { recursive: true, force: true });
}

// ── 10. uploadFilesToHubConcurrent — mixed success / failure preserves order ──

{
  const files = Array.from({ length: 5 }, (_, i) =>
    mkTempFile(Buffer.from(`mixed ${i}`), "png"),
  );
  let idx = 0;
  const fetchMock = makeFetchMock(async () => {
    const i = idx++;
    if (i === 1 || i === 3) {
      return new Response("error", { status: 500 });
    }
    return new Response(JSON.stringify({ file_id: `f${i}_0000aaaa` }), { status: 200 });
  });
  const all = await uploadFilesToHubConcurrent(files, { hubUrl: "http://x", authToken: "ntok_X", fetch: fetchMock }, 1);
  expect("mixed: 5 results", all.length === 5);
  expect("mixed: slot 0 success", all[0]?.file_id === "f0_0000aaaa", JSON.stringify(all[0]));
  expect("mixed: slot 1 null (500)", all[1] === null);
  expect("mixed: slot 2 success", all[2]?.file_id === "f2_0000aaaa");
  expect("mixed: slot 3 null (500)", all[3] === null);
  expect("mixed: slot 4 success", all[4]?.file_id === "f4_0000aaaa");
  for (const f of files) fs.rmSync(path.dirname(f), { recursive: true, force: true });
}

// ── 11. Empty input → empty result ────────────────────────────────────────

{
  const r = await uploadFilesToHubConcurrent([], { hubUrl: "http://x", authToken: "ntok_X" });
  expect("empty input: empty result", r.length === 0);
}

// ── 12. Defaults sanity ──────────────────────────────────────────────────

expect("HUB_UPLOAD_LIMIT_BYTES = 12 MiB", HUB_UPLOAD_LIMIT_BYTES === 12 * 1024 * 1024);
expect("DEFAULT_UPLOAD_CONCURRENCY is 4", DEFAULT_UPLOAD_CONCURRENCY === 4);

// ── Summary ───────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} feishu-hub-upload tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
