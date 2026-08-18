// #909 (corrected) — claude-code-cli's execution lane lives in the LAUNCHER (agent-network/bin/cli.ts,
// `anet node start` → spawns the real `claude` CLI), NOT in agent-node. So agent-node's --help must not
// present it as a `--runtime` value you pass to agent-node (agent-node correctly rejects it at RUNTIME_MAP —
// that rejection is NOT touched here; this is a help-text fix only). It stays documented, but marked as
// anet-provided. Do NOT assert on the launcher here, and do NOT claim it's unimplemented — it is.

import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { join } from "path";

const CLI = join(import.meta.dir, "cli.ts");

function help(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("bun", [CLI, "--help"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(out); }, 15_000);
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("exit", () => { clearTimeout(t); resolve(out); });
    child.on("error", () => { clearTimeout(t); resolve(out); });
  });
}

describe("#909 agent-node --help does not present claude-code-cli as a directly-passable runtime", () => {
  test("the `--runtime <type>` value list omits claude-code-cli (agent-node does not accept it)", async () => {
    const out = await help();
    const line = out.split(/\r?\n/).find((l) => /--runtime <type>/.test(l)) ?? "";
    expect(line).not.toContain("claude-code-cli");
    // positive control: it still offers the runtimes agent-node DOES accept (didn't strip the whole list).
    expect(line).toContain("claude-agent-sdk");
    expect(line).toContain("codex-sdk");
  }, 20_000);

  test("it stays documented, marked anet-provided — and is NOT called unimplemented (it is implemented)", async () => {
    const out = await help();
    expect(out).toContain("claude-code-cli"); // still in the Runtime section
    expect(out).toContain("anet node start"); // says how it is actually started
    expect(out).toMatch(/不能直接传给 agent-node|not by passing --runtime to agent-node/);
    // 🔴 the whole point of the correction: it must NOT be described as a gap/unimplemented.
    expect(out).not.toMatch(/not yet implemented|no execution lane|known gap/);
  }, 20_000);
});
