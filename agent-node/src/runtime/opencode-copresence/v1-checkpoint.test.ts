import { describe, test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readV1Checkpoint, writeV1Checkpoint, verifyV1ImportedHistory, type V1SessionData } from "./v1-checkpoint";

const owner = { nodeId: "n_test906", networkId: "net_test906" };
const data: V1SessionData = { info: { id: "ses_history906" }, messages: [
  { info: { id: "msg_user906", sessionID: "ses_history906", role: "user" }, parts: [
    { id: "prt_text906", messageID: "msg_user906", sessionID: "ses_history906", type: "text", text: "fixture history" },
  ] },
] };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "v1-checkpoint906-"));
  chmodSync(dir, 0o700);
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("V1 checkpoint core", () => {
  test("private save/read preserves exact session and history", () => {
    const f = fixture();
    try {
      expect(readV1Checkpoint(f.dir, owner)).toBeUndefined();
      writeV1Checkpoint(f.dir, owner, data, true);
      const checkpoint = readV1Checkpoint(f.dir, owner, data.info.id)!;
      expect(checkpoint.cleanShutdown).toBe(true);
      expect(checkpoint.data).toEqual(data);
      verifyV1ImportedHistory(checkpoint, JSON.parse(JSON.stringify(data)));
    } finally { f.close(); }
  });
  test("wrong node/network/session cannot read or restore the snapshot", () => {
    const f = fixture();
    try {
      writeV1Checkpoint(f.dir, owner, data, true);
      for (const identity of [{ ...owner, nodeId: "n_other" }, { ...owner, networkId: "net_other" }]) {
        expect(() => readV1Checkpoint(f.dir, identity, data.info.id)).toThrow("node/network/session mismatch");
      }
      expect(() => readV1Checkpoint(f.dir, owner, "ses_other")).toThrow("node/network/session mismatch");
      const checkpoint = readV1Checkpoint(f.dir, owner)!;
      expect(() => verifyV1ImportedHistory(checkpoint, { info: data.info, messages: [] })).toThrow("history count mismatch");
    } finally { f.close(); }
  });
  test("failed write leaves the old snapshot unchanged", () => {
    const f = fixture();
    try {
      writeV1Checkpoint(f.dir, owner, data, true);
      const path = join(f.dir, "opencode-v1-session.json");
      const before = readFileSync(path);
      const malformed = structuredClone(data);
      malformed.messages[0].parts[0].sessionID = "ses_other";
      expect(() => writeV1Checkpoint(f.dir, owner, malformed, false)).toThrow("part identity mismatch");
      expect(readFileSync(path)).toEqual(before);
    } finally { f.close(); }
  });
  test("snapshot symlink is not followed", () => {
    const f = fixture();
    try {
      const other = join(f.dir, "other");
      mkdirSync(other, { mode: 0o700 });
      writeV1Checkpoint(other, owner, data, true);
      symlinkSync(join(other, "opencode-v1-session.json"), join(f.dir, "opencode-v1-session.json"));
      expect(() => readV1Checkpoint(f.dir, owner)).toThrow();
      expect(() => writeV1Checkpoint(f.dir, owner, data, true)).toThrow();
    } finally { f.close(); }
  });
});
