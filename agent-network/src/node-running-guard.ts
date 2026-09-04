// #1130 —— 对一个已经在跑的节点执行 `anet node start`,此前会「Starting new session」起第二个进程
// 接管同一个 alias;第二个进程退出时向 hub 报 offline,原进程还活着,hub 从此不再推送。
// `anet project up` 早就「skip already-running」,这里把同一条规则用到 `node start` 上。
// 纯逻辑:pid 文件里的 pid 是否还属于一个 agent-node/anet 进程(pid 会被复用,光 kill -0 不够)。

export const isAgentNodeCommand = (cmdline: string): boolean => {
  const c = cmdline.trim();
  if (!c) return false;
  return /agent-node[\\/]dist[\\/]cli\.js|\/agent-node(\s|$)|\banet(\.js)?\s+node\s+start\b|\bagent-node\b/.test(c);
};

export interface RunningNodeProbe {
  pidFileContent: string | null;
  isAlive: (pid: number) => boolean;
  commandOf: (pid: number) => string | null;
}

/** 返回还活着且确实是 agent-node 的 pid;否则 null(不存在 / 死了 / pid 被别的进程复用)。 */
export const runningNodePid = (probe: RunningNodeProbe): number | null => {
  const raw = (probe.pidFileContent ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (!probe.isAlive(pid)) return null;
  const cmd = probe.commandOf(pid);
  // 读不到命令行(权限/平台)时不敢断定是复用,按活着处理:宁可拒绝一次让人去 stop,也不起第二个。
  if (cmd === null) return pid;
  return isAgentNodeCommand(cmd) ? pid : null;
};

export const alreadyRunningMessage = (displayName: string, pid: number): string[] => [
  `[anet] ❌ node "${displayName}" is already running locally (pid ${pid}) — refusing to start a second session for the same alias.`,
  `[anet]    A second process would take over the alias and mark it offline when it exits (#1130).`,
  `[anet]    Use: anet node restart '${displayName}'   (or: anet node stop '${displayName}' && anet node start '${displayName}')`,
];
