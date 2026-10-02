import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { verifyProcessTreeCodexHome } from "./codex-home-enforce";

// #448 根因的真机复现(私有 tmux socket,不碰默认服务器上的任何会话):
// tmux new-session 的初始进程环境取自 **tmux 服务器**,不是发命令的那个进程。服务器若在某台
// 节点的 pane 里被首次拉起,之后所有新会话的外层 shell 都带着那台节点的 CODEX_HOME。
// 只靠命令串里的 `export` 盖住它,任何一条漏了 export 的重生路径就会用邻居的登录态。
const HAS_TMUX = process.platform === "linux" && spawnSync("tmux", ["-V"]).status === 0;
const SOCK = `anet448-${randomBytes(4).toString("hex")}`;
const NEIGHBOUR = "/w/.anet/nodes/neighbour/codex-home";
const MINE = "/w/.anet/nodes/mine/codex-home";
const tmux = (args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync("tmux", ["-L", SOCK, "-f", "/dev/null", ...args], { encoding: "utf-8", env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
const panePid = (session: string): number => {
  const out = tmux(["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"]);
  const row = out.split("\n").map((l) => l.split("\t")).find(([s]) => s === session);
  if (!row) throw new Error(`no pane for ${session}`);
  return Number(row[1]);
};

afterAll(() => {
  if (!HAS_TMUX) return;
  try { tmux(["kill-server"]); } catch { /* already gone */ }
  try { rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, SOCK), { force: true }); } catch { /* best-effort */ }
});

describe.skipIf(!HAS_TMUX)("#448 tmux server env leaks a neighbour's CODEX_HOME into new sessions", () => {
  test("setup: the private tmux server is born with the neighbour's CODEX_HOME", () => {
    tmux(["new-session", "-d", "-s", "seed", "sleep 60"], { ...process.env, CODEX_HOME: NEIGHBOUR });
  });

  test("witnessed red: new-session WITHOUT -e → the pane's first process carries the neighbour's home", () => {
    // 发命令的进程这边**没有** CODEX_HOME —— 泄漏来自服务器,不是调用方。
    const env = { ...process.env }; delete env.CODEX_HOME;
    tmux(["new-session", "-d", "-s", "no-e", "sleep 60"], env);
    const v = verifyProcessTreeCodexHome({ rootPid: panePid("no-e"), expected: MINE, label: "no-e" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.actual).toBe(NEIGHBOUR);
  });

  test("fix: new-session -e CODEX_HOME=<own> → pane tree verified", () => {
    const env = { ...process.env }; delete env.CODEX_HOME;
    tmux(["new-session", "-d", "-s", "with-e", "-e", `CODEX_HOME=${MINE}`, "bash", "-c", "sleep 60 & wait"], env);
    // 等孙进程出现
    const deadline = Date.now() + 2_000;
    let v = verifyProcessTreeCodexHome({ rootPid: panePid("with-e"), expected: MINE, label: "with-e" });
    while (v.ok && v.checked.length < 2 && Date.now() < deadline) {
      Bun.sleepSync(20);
      v = verifyProcessTreeCodexHome({ rootPid: panePid("with-e"), expected: MINE, label: "with-e" });
    }
    expect(v).toEqual({ ok: true, checked: expect.any(Array) });
    if (v.ok) expect(v.checked.length).toBe(2);
  });
});
