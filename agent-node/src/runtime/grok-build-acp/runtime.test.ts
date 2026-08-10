import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runGrokAcpTurn } from "./runtime";

describe("runGrokAcpTurn runtime evidence", () => {
  test("separates prompt submission from exact prompt-response consumption", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-acp-evidence-"));
    const fake = join(cwd, "fake-grok.js");
    writeFileSync(fake, `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { authMethods: [{ id: "cached_token" }] } });
  } else if (req.method === "authenticate") {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  } else if (req.method === "session/new") {
    send({ jsonrpc: "2.0", id: req.id, result: { sessionId: "grok-evidence-session" } });
  } else if (req.method === "session/prompt") {
    setTimeout(() => send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } }), 25);
  }
});
`);
    chmodSync(fake, 0o755);
    const evidence: string[] = [];
    try {
      const turn = runGrokAcpTurn({
        cwd,
        binary: fake,
        prompt: "exact grok evidence",
        drainMs: 0,
        onSubmitted: () => evidence.push("submitted"),
        onConsumed: () => evidence.push("consumed"),
      });
      for (let i = 0; i < 100 && evidence.length === 0; i++) await Bun.sleep(2);
      expect(evidence).toEqual(["submitted"]);
      await turn;
      expect(evidence).toEqual(["submitted", "consumed"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
