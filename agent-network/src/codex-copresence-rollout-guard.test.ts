import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { copresenceRolloutGuard } from "./codex-copresence-rollout-guard";

const THREAD = "01a11846-d796-72f1-af68-8d9215a65dc8";
const meta = (historyMode?: string) =>
  JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: THREAD, ...(historyMode ? { history_mode: historyMode } : {}) } });

function home(firstLine?: string): string {
  const h = mkdtempSync(join(tmpdir(), "r734n-"));
  if (firstLine !== undefined) {
    const dir = join(h, "sessions", "2026", "10", "07");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-10-07T21-30-58-${THREAD}.jsonl`), `${firstLine}\n{}\n`);
  }
  return h;
}

describe("board #734 co-presence pre-start guard", () => {
  test("blocks 0.133 on paginated, with the node-specific --codex-bin hint", () => {
    const h = home(meta("paginated"));
    try {
      const r = copresenceRolloutGuard({ codexHome: h, threadIds: [THREAD], codexBin: "codex", displayName: "n1", probeVersion: () => "0.133.0" });
      expect(r.block).not.toBeNull();
      expect(r.block!.join("\n")).toContain("anet node start n1 --codex-bin");
    } finally { rmSync(h, { recursive: true, force: true }); }
  });

  test("allows 0.159.2 on paginated and 0.133 on legacy", () => {
    const p = home(meta("paginated"));
    const l = home(meta());
    try {
      expect(copresenceRolloutGuard({ codexHome: p, threadIds: [THREAD], codexBin: "codex", displayName: "n1", probeVersion: () => "0.159.2" }).block).toBeNull();
      expect(copresenceRolloutGuard({ codexHome: l, threadIds: [THREAD], codexBin: "codex", displayName: "n1", probeVersion: () => "0.133.0" }).block).toBeNull();
    } finally { rmSync(p, { recursive: true, force: true }); rmSync(l, { recursive: true, force: true }); }
  });

  test("checks the pending thread too; no thread = no probe", () => {
    const h = home(meta("paginated"));
    try {
      let probes = 0;
      const probe = () => { probes++; return "0.133.0"; };
      expect(copresenceRolloutGuard({ codexHome: h, threadIds: [undefined, THREAD], codexBin: "codex", displayName: "n1", probeVersion: probe }).block).not.toBeNull();
      expect(copresenceRolloutGuard({ codexHome: h, threadIds: [], codexBin: "codex", displayName: "n1", probeVersion: probe }).block).toBeNull();
      expect(probes).toBe(1);
    } finally { rmSync(h, { recursive: true, force: true }); }
  });

  test("missing rollout warns, does not block, and does not probe", () => {
    const h = home();
    try {
      let probes = 0;
      const r = copresenceRolloutGuard({ codexHome: h, threadIds: [THREAD], codexBin: "codex", displayName: "n1", probeVersion: () => { probes++; return "0.133.0"; } });
      expect(r.block).toBeNull();
      expect(r.warnings.join("\n")).toContain("not found");
      expect(probes).toBe(0);
    } finally { rmSync(h, { recursive: true, force: true }); }
  });
});
