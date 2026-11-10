import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexForkEvidence } from "./codex-fork-result.js";

const REQUEST = "str_0123456789ab";
const OLD = "01a11846-d796-72f1-af68-8d9215a65dc8";
const NEW = "01a11900-0000-7000-8000-000000000001";
const entry = { requestId: REQUEST, oldThreadId: OLD, newThreadId: NEW,
  originalRollout: "/private/original", snapshot: "/private/snapshot", at: "2026-10-09T00:00:00Z" };
const roots: string[] = [];
function fixture(forks?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "fork-evidence-"));
  roots.push(dir);
  const path = join(dir, "codex-fork-recovery.json");
  if (forks !== undefined) writeFileSync(path, JSON.stringify({ forks }));
  return { dir, path };
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("exact request, not latest: return only thread IDs and preserve the file", () => {
  const f = fixture([{ ...entry, requestId: undefined }, entry, { ...entry, requestId: "str_newer" }]);
  const before = readFileSync(f.path, "utf8");
  expect(readCodexForkEvidence(f.dir, REQUEST)).toEqual({ state: "forked", old_thread_id: OLD, new_thread_id: NEW });
  expect(readFileSync(f.path, "utf8")).toBe(before);
});

test("missing file and unkeyed/other-request history are not evidence for this request", () => {
  for (const forks of [undefined, [], [{ ...entry, requestId: undefined }], [{ ...entry, requestId: "str_other" }]]) {
    expect(readCodexForkEvidence(fixture(forks).dir, REQUEST)).toEqual({ state: "not_observed" });
  }
});

test("unreadable or invalid history is unknown, with no path or raw error returned", () => {
  const f = fixture();
  mkdirSync(f.path);
  expect(readCodexForkEvidence(f.dir, REQUEST)).toEqual({ state: "unknown", reason: "history_unreadable" });
  for (const raw of ["{broken", "null", "{}", '{"forks":{}}']) {
    const g = fixture();
    writeFileSync(g.path, raw);
    expect(readCodexForkEvidence(g.dir, REQUEST)).toEqual({ state: "unknown", reason: "history_invalid" });
    expect(readFileSync(g.path, "utf8")).toBe(raw);
  }
});

test("multiple matching records are ambiguous, never last-entry-wins", () => {
  expect(readCodexForkEvidence(fixture([entry, entry]).dir, REQUEST)).toEqual({ state: "unknown", reason: "request_ambiguous" });
});

test("invalid or identical thread IDs cannot become a public fork result", () => {
  for (const newThreadId of [undefined, OLD, "/private/secret", NEW + "\n"]) {
    expect(readCodexForkEvidence(fixture([{ ...entry, newThreadId }]).dir, REQUEST)).toEqual({ state: "unknown", reason: "mapping_invalid" });
  }
});

test("invalid request IDs never match legacy records", () => {
  const f = fixture([{ ...entry, requestId: undefined }]);
  for (const requestId of ["", "str_", REQUEST + "\n", undefined as unknown as string]) {
    expect(readCodexForkEvidence(f.dir, requestId)).toEqual({ state: "unknown", reason: "invalid_request_id" });
  }
});
