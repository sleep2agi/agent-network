import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, writeFileSync, symlinkSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { V1_SHARED_CANDIDATE_FILE, writeV1SharedCandidate, readV1SharedCandidate, v1SharedCandidateCheckpoint, V1SharedCaptureError, type V1SharedCandidate } from "./v1-shared-capture";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "capture-unit-")); chmodSync(root, 0o700);
  const directory = join(root, "project"), backup = join(root, "backup");
  mkdirSync(directory, { mode: 0o700 }); mkdirSync(backup, { mode: 0o700 });
  const data = { info: { id: "ses_1236", directory }, messages: [
    { info: { id: "msg_user", sessionID: "ses_1236", role: "user" }, parts: [{ id: "prt_user", sessionID: "ses_1236", messageID: "msg_user", type: "text", text: "synthetic" }] },
    { info: { id: "msg_reply", sessionID: "ses_1236", role: "assistant", parentID: "msg_user", time: { completed: 1 } }, parts: [] },
  ] };
  const value: V1SharedCandidate = { schema: 1, purpose: "migration-candidate", cleanShutdown: false, savedAt: new Date().toISOString(),
    binding: { networkId: "net_fixture", nodeId: "n_fixture", serverIdentity: "host:instance", directory, sessionId: "ses_1236" },
    version: "1.18.34", cohortId: "fixture", model: "fixture/alpha", data,
    dataSha256: createHash("sha256").update(JSON.stringify(data)).digest("hex") };
  return { root, directory, backup, value, close: () => rmSync(root, { recursive: true, force: true }) };
}
test("candidate roundtrip remains nonfinal; exclusive retry preserves exact bytes", () => {
  const f = fixture(); try {
    writeV1SharedCandidate(f.backup, f.value);
    expect(readV1SharedCandidate(f.backup, f.value)).toEqual(f.value);
    expect(v1SharedCandidateCheckpoint(f.value, f.value).cleanShutdown).toBe(false);
    const path = join(f.backup, V1_SHARED_CANDIDATE_FILE), before = readFileSync(path);
    expect(() => writeV1SharedCandidate(f.backup, f.value)).toThrow(V1SharedCaptureError);
    expect(readFileSync(path)).toEqual(before); expect(readdirSync(f.backup)).toEqual([V1_SHARED_CANDIDATE_FILE]);
  } finally { f.close(); }
});
for (const key of ["networkId", "nodeId", "serverIdentity", "directory", "sessionId"] as const) test(`independent ${key} mismatch refuses candidate read`, () => {
  const f = fixture(); try {
    writeV1SharedCandidate(f.backup, f.value);
    expect(() => readV1SharedCandidate(f.backup, { ...f.value, binding: { ...f.value.binding, [key]: "foreign" } })).toThrow(V1SharedCaptureError);
  } finally { f.close(); }
});
test("unsafe output/root and symlink refuse without following or replacing recovery", () => {
  const f = fixture(); try {
    expect(() => writeV1SharedCandidate(f.directory, f.value)).toThrow(V1SharedCaptureError);
    chmodSync(f.backup, 0o755); expect(() => writeV1SharedCandidate(f.backup, f.value)).toThrow(V1SharedCaptureError); chmodSync(f.backup, 0o700);
    const sentinel = join(f.root, "sentinel"); writeFileSync(sentinel, "keep", { mode: 0o600 });
    symlinkSync(sentinel, join(f.backup, V1_SHARED_CANDIDATE_FILE));
    expect(() => writeV1SharedCandidate(f.backup, f.value)).toThrow(V1SharedCaptureError);
    expect(() => readV1SharedCandidate(f.backup, f.value)).toThrow(V1SharedCaptureError);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  } finally { f.close(); }
});
test("changed bytes, external files, unfinished/orphan replies and final masquerade refuse", () => {
  const f = fixture(); try {
    for (const alter of [
      (v: any) => { v.cleanShutdown = true; }, (v: any) => { v.purpose = "final"; },
      (v: any) => { v.data.messages[0].parts[0].text = "changed"; },
      (v: any) => { v.data.messages[0].parts[0] = { ...v.data.messages[0].parts[0], type: "file", url: "file:///private/real" }; },
      (v: any) => { delete v.data.messages[1].info.time.completed; },
      (v: any) => { v.data.messages[1].info.parentID = "msg_missing"; },
      (v: any) => { v.data.messages[1].info.parentID = "msg_reply"; },
      (v: any) => { v.binding.token = "synthetic-extra-field"; },
    ]) {
      const value = structuredClone(f.value); alter(value);
      if (value.data.messages[0].parts[0].text !== "changed") value.dataSha256 = createHash("sha256").update(JSON.stringify(value.data)).digest("hex");
      expect(() => writeV1SharedCandidate(f.backup, value)).toThrow(V1SharedCaptureError);
    }
  } finally { f.close(); }
});
