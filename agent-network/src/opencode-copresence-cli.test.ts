import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

function functionBody(name: string): string {
  const start = cli.indexOf(`async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = cli.slice(start + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("OpenCode co-presence CLI wiring", () => {
  const body = functionBody("startOpencodeCopresenceOrchestration");

  test("persists copresence mode before launching the bridge", () => {
    const save = body.indexOf('opencodeMode: "copresence"');
    const bridge = body.indexOf('"new-session"');
    expect(save).toBeGreaterThan(-1);
    expect(bridge).toBeGreaterThan(save);
  });

  test("starts only exact alias and alias-bridge tmux sessions", () => {
    expect(body).toContain("const bridgeSession = `${displayName}-桥`");
    expect(body).toContain("const tuiSession = displayName");
    expect(body).not.toContain("pkill");
    expect(body).not.toContain("killall");
  });

  test("does not depend on a long-lived tmux server's stale launcher environment", () => {
    expect(body).toContain('export PATH=${shellQuote(process.env.PATH ?? "")}');
    expect(body).toContain("export ANET_AGENT_NODE_BIN=");
    expect(body).toContain("export ANET_OPENCODE_SAFE_BASE=");
  });

  // #1225 —— 失败现场必须**落盘**。判失败那一刻 bridge 会话往往已经没了，
  // 而 `tmux capture-pane` 对一个不存在的会话只能给空串：那次用户只拿到一行
  // 泛泛的超时，真正的死因（agent-node 崩在 host.ip 上）谁都看不到。
  test("bridge 的输出落到节点日志目录，而不是只留在 tmux pane 里", () => {
    expect(body).toContain("copresence-bridge.log");
    // fd 重定向用不带命令的 `exec`（只改 fd、不替换进程），后面那条
    // `exec node …` 仍然原样接管 —— 进程身份不变，node stop 的 pgid 语义不受影响。
    const teeAt = body.indexOf("exec > >(tee -a");
    const execAt = body.indexOf("exec ${shellQuote(process.execPath)}");
    expect(teeAt).toBeGreaterThan(-1);
    expect(execAt).toBeGreaterThan(teeAt);
  });

  test("超时后的输出交给诊断模块，且区分「桥死了」和「桥还活着」", () => {
    expect(body).toContain("describeCopresenceStartupFailure");
    expect(body).toContain("const bridgeAlive = tmuxSessionRunning(bridgeSession)");
    // 落盘日志要真的被读出来 —— 否则"落盘"只是写进去没人看。
    expect(body).toContain("readFileSync(bridgeLog");
  });

  test("waits for the owner-only runtime launcher before starting the official TUI", () => {
    const wait = body.indexOf("while (!existsSync(attachScript)");
    const tuiSpawn = body.lastIndexOf('"new-session"');
    expect(wait).toBeGreaterThan(-1);
    expect(tuiSpawn).toBeGreaterThan(wait);
    expect(body).toContain("exec ${shellQuote(attachScript)}");
  });

  test("the generic --copresence dispatcher selects OpenCode by stored runtime", () => {
    const dispatch = cli.indexOf('if (copresenceRuntime === "opencode-cli")');
    expect(dispatch).toBeGreaterThan(-1);
    expect(cli.slice(dispatch, dispatch + 240)).toContain("startOpencodeCopresenceOrchestration(id, opts.hub)");
  });

  test("operator help names the create, attach, and stop commands", () => {
    expect(cli).toContain("anet node create <name> --runtime opencode-cli --mode copresence");
    expect(cli).toContain("tmux attach -t '=<name>'");
    expect(cli).toContain("anet node stop <name>");
  });

  test("prints an exact tmux target so an exited TUI cannot prefix-match the bridge", () => {
    expect(body).toContain("tmux attach -t ${shellQuote(`=${displayName}`)}");
    expect(body).not.toContain("tmux attach -t ${shellQuote(displayName)}");
  });
});
