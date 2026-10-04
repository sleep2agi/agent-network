// Board #556 — anet (#533) and agent-node each carry tmux-format.ts: the two
// packages cannot import each other, so the helper is a byte-identical mirror and
// this test is what keeps it one helper (same pattern as opencode-versions-parity).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO = join(import.meta.dir, "..", "..");
const ANET = join(REPO, "agent-network", "src", "tmux-format.ts");
const NODE = join(REPO, "agent-node", "src", "tmux-format.ts");

describe("tmux-format helper parity (#533/#556)", () => {
  test("agent-network and agent-node carry byte-identical copies", () => {
    expect(readFileSync(NODE, "utf8")).toBe(readFileSync(ANET, "utf8"));
  });

  test("the copy imports nothing, so both packages can bundle it as-is", () => {
    expect(readFileSync(ANET, "utf8")).not.toMatch(/^\s*import\s/m);
  });

  test("both copies behave the same on the measured shapes", async () => {
    const a = await import(ANET);
    const n = await import(NODE);
    expect(n.TMUX_FIELD_SEP).toBe(a.TMUX_FIELD_SEP);
    const out = `$1${a.TMUX_FIELD_SEP}通信牛\n$2\t通信牛-appsrv\r\n$0_______\n`;
    expect(n.parseTmuxRows(out, 2)).toEqual(a.parseTmuxRows(out, 2));
    expect(n.tmuxListArgs(["list-sessions"], ["#{session_id}", "#{session_name}"]))
      .toEqual(a.tmuxListArgs(["list-sessions"], ["#{session_id}", "#{session_name}"]));
  });
});
