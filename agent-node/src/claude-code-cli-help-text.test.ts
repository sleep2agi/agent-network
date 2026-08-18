// #909 (corrected) — claude-code-cli's execution lane lives in the LAUNCHER (agent-network/bin/cli.ts,
// `anet node start` → spawns the real `claude` CLI), NOT in agent-node. So agent-node's --help must not
// present it as a `--runtime` value you pass to agent-node (agent-node correctly rejects it at RUNTIME_MAP —
// that rejection is NOT touched here; this is a help-text fix only). It stays documented, but marked as
// anet-provided. Do NOT assert on the launcher here, and do NOT claim it's unimplemented — it is.

import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { join } from "path";

const CLI = join(import.meta.dir, "cli.ts");

function run(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("bun", [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(out); }, 15_000);
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("exit", () => { clearTimeout(t); resolve(out); });
    child.on("error", () => { clearTimeout(t); resolve(out); });
  });
}

const help = () => run(["--help"]);

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

// 🔴 #917 修了 --help,却把同一句错话留在了**用户真正撞上的那一处**:
//    RUNTIME_MAP 的拒绝分支只会说 `Unsupported runtime "claude-code-cli"`。
//    对这个二进制而言「unsupported」是真的,对产品而言是假的 —— 它已实现、
//    有 e2e、在出货,只是住在 launcher 里。说「unsupported」会把人推去找一个
//    不存在的 runtime,而不是推去隔壁那条命令。
describe("#909 rejecting claude-code-cli says where it actually lives", () => {
  test("it does not call claude-code-cli unsupported, and names `anet node start`", async () => {
    const out = await run(["--alias", "t", "--runtime", "claude-code-cli"]);
    expect(out).toContain("anet node start");
    expect(out).toMatch(/does not run through agent-node/);
    // 🔴 这是本条的核心断言:那个词不能出现在 claude-code-cli 这一句里。
    expect(out).not.toMatch(/Unsupported runtime "claude-code-cli"/);
  }, 20_000);

  test("负对照 —— 真正不存在的 runtime 仍然走原来那句", async () => {
    const out = await run(["--alias", "t", "--runtime", "definitely-not-a-runtime"]);
    expect(out).toMatch(/Unsupported runtime "definitely-not-a-runtime"/);
    // 不该把特判泄漏到别的名字上
    expect(out).not.toMatch(/anet node start/);
  }, 20_000);
});
