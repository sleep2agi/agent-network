// #1650 — what a *failed* codex co-presence create may leave behind.
//
// 共存的 `anet node start` 把 app-server / 桥 / TUI 起在三个 tmux 会话里,自己退出
// (见 agent-network/bin/cli.ts `copresenceTmuxSessions`)。post-spawn 校验失败时,
// daemon 需要回答「这三个会话还在不在」——但**判据只能是节点自己的身份标记**:
//
//   🔴 没有 `copresence-identity.json` 时,CLI 的 stop 会退回按显示名清扫
//      (legacy 路径 = 按名字杀,#596 明令禁止)。所以这里连「读」都不做:
//      会话名相同 ≠ 本代。`owned === false` 时一律返回空,让上层只能报
//      `no_live_generation`,而不是凭名字认领别人的会话。
//
// 这里只做只读探测,不提供任何 kill 能力:tmux 会话只经 `anet node stop` 收。
import { execTmux } from "../tmux.js";

export interface CodexSessionResidue {
  /** 保留字段,与 opencode 侧同形;codex 从不借用宿主 generation。 */
  borrowed: boolean;
  alive: Array<{ id: string; role: "tui" | "appsrv" | "bridge" }>;
}

export function copresenceSessionNames(
  alias: string,
): Array<{ name: string; role: "tui" | "appsrv" | "bridge" }> | undefined {
  const name = alias.trim();
  // 拼不出「一个确定的名字」就不探:空、路径片段、控制字符、以 `=` 开头
  // (tmux 的精确匹配前缀,拼进去会变成 `==…`)。
  if (!name || name === "." || name === ".." || name.startsWith("=") || /[\0\n\r]/.test(name)) return undefined;
  return [
    { name, role: "tui" },
    { name: `${name}-appsrv`, role: "appsrv" },
    { name: `${name}-桥`, role: "bridge" },
  ];
}

/** `tmux has-session -t =<name>`:精确名字,argv 传参,不经 shell。 */
export type SessionProbe = (name: string) => boolean;

export const defaultSessionProbe: SessionProbe = (name) => {
  try {
    // #505: 走共享的 tmux 入口(它负责 socket 隔离与环境规整)。裸 execFileSync("tmux", …)
    // 会探到默认 server 上,和本仓「只碰自己那台 server」的规矩相反 —— 棘轮测试就是这么抓到的。
    execTmux(["has-session", "-t", `=${name}`], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    // tmux 不在、会话不在、或探测超时 —— 都无法证明它活着,按不在处理。
    return false;
  }
};

/** `owned` = 本次 create 写的 config 仍是我们的、且 identity marker 在盘上。 */
export function copresenceSessionResidue(
  alias: string,
  owned: boolean,
  probe: SessionProbe = defaultSessionProbe,
): CodexSessionResidue {
  if (!owned) return { borrowed: false, alive: [] };
  const sessions = copresenceSessionNames(alias);
  if (!sessions) return { borrowed: false, alive: [] };
  return {
    borrowed: false,
    alive: sessions.filter((s) => probe(s.name)).map((s) => ({ id: s.name, role: s.role })),
  };
}
