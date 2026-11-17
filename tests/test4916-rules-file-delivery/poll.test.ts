import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as node from "../../agent-node/src/runtime/rules-file";
import * as channel from "../../agent-network/src/rules-file";

for (const [name, api] of [["agent-node", node], ["channel", channel]] as const) {
  test(`${name}: lost doorbell is recovered by polling, serially with a concurrent wake`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-poll-"));
    let pulls = 0, concurrent = 0, maxConcurrent = 0, ackCount = 0;
    const queue = [{ request_id: "rf_write", op: "write", content: "managed rules" }];
    const deps = { runtime: "claude", workDir: dir, log() {}, warn() {}, callCommHub: async (method: string) => {
      if (method === "get_rules_file_request") {
        pulls++; concurrent++; maxConcurrent = Math.max(concurrent, maxConcurrent);
        await Bun.sleep(15); concurrent--;
        return { request: queue.shift() ?? null };
      }
      ackCount++; return { ok: true };
    } };
    const stop = api.startRulesFilePolling(deps, 5);
    try {
      await Bun.sleep(10); // poll is now in flight, no SSE delivered
      await Promise.all([api.processRulesFileRequests(deps), api.processRulesFileRequests(deps)]);
      expect(ackCount).toBe(1);
      expect(maxConcurrent).toBe(1);
      expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("managed rules");
    } finally { stop(); await Bun.sleep(30); rmSync(dir, { recursive: true, force: true }); }
    const afterStop = pulls; await Bun.sleep(25); expect(pulls).toBe(afterStop);
  });

  test(`${name}: failed poll releases single flight and never logs upstream secrets`, async () => {
    let calls = 0;
    const warnings: string[] = [];
    const stop = api.startRulesFilePolling({ runtime: "claude", workDir: ".", log() {}, warn: msg => warnings.push(msg),
      callCommHub: async () => { calls++; if (calls === 1) throw Error("ntok_secret /private/path"); return { request: null }; },
    }, 5);
    try { await Bun.sleep(50); } finally { stop(); }
    expect(calls).toBeGreaterThan(1);
    expect(warnings).toEqual(["[rules-file] poll_failed"]);
  });
}

test("both consumers keep the same audited implementation and a poll period below the 60s expiry", () => {
  expect(node.RULES_FILE_POLL_MS).toBe(15_000);
  expect(readFileSync(new URL("../../agent-node/src/runtime/rules-file.ts", import.meta.url), "utf8"))
    .toBe(readFileSync(new URL("../../agent-network/src/rules-file.ts", import.meta.url), "utf8"));
});
