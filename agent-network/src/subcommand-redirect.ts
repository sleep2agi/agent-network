/**
 * `anet daemon <sub>` 认不出子命令时，原先只走 `suggestSimilar`，而它的候选集
 * 是 `["init","start","restart","up","list"]` —— **全是会改变状态的命令**。
 *
 * 🔴 实测（用仓里那个 `suggestSimilar` 本身跑的，不是推的）：
 *
 *      anet daemon rm     → 建议 "up"      想删,被指去「创建 + 启动」
 *      anet daemon state  → 建议 "start"   想看状态,被指去「启动」
 *      anet daemon stat   → 建议 "start"   同上
 *      anet daemon stop   → 建议 null      (levenshtein("stop","start") = 3)
 *
 * 一个「你是不是想 X」的提示，把只读/销毁意图导向一个会动世界的命令，
 * 比不给提示更贵。
 *
 * 而这些动作**本来就有**：daemon 就是一个 role=host_supervisor 的 agent-node，
 * `anet daemon restart` 内部调的正是 `anet node stop` 用的那个 stopCommand()。
 * 缺的从来不是功能，是**可发现性**。
 */

type Redirect = { command: (name: string) => string; note: string };

/** 键是用户可能敲的动词；值是真实存在的 node 级命令（已逐个核过存在于
 *  `anet node <create|start|stop|restart|resume|delete|ls|rename|loop|…>`）。 */
const NODE_LEVEL: Record<string, Redirect> = {
  stop:   { command: n => `anet node stop ${n}`,   note: "daemon 就是个 agent-node;`anet daemon restart` 内部用的也是它" },
  kill:   { command: n => `anet node stop ${n}`,   note: "没有 kill;正常停用 node stop" },
  halt:   { command: n => `anet node stop ${n}`,   note: "没有 halt;正常停用 node stop" },
  delete: { command: n => `anet node delete ${n}`, note: "删除走 node 级命令" },
  del:    { command: n => `anet node delete ${n}`, note: "删除走 node 级命令" },
  rm:     { command: n => `anet node delete ${n}`, note: "删除走 node 级命令" },
  remove: { command: n => `anet node delete ${n}`, note: "删除走 node 级命令" },
  status: { command: () => "anet node ls",         note: "看在不在跑用 node ls;`anet daemon list` 只列本机配置过的 daemon" },
  state:  { command: () => "anet node ls",         note: "看在不在跑用 node ls" },
  stat:   { command: () => "anet node ls",         note: "看在不在跑用 node ls" },
  ps:     { command: () => "anet node ls",         note: "看在不在跑用 node ls" },
  info:   { command: n => `anet info ${n}`,        note: "单个节点的详情" },
};

/** 这些是 `anet daemon` 自己的子命令 —— 它们**会改变状态**，所以任何
 *  只读/销毁意图都不该被导向它们。测试用它做对照。 */
export const DAEMON_STATE_CHANGING = ["init", "start", "restart", "up"] as const;

/** `anet project` 的候选集是 ["up","restart","down","ls"]。实测 `rm` → `up`
 *  —— 想删项目,被指去**启动项目里所有节点**。项目级根本没有删除操作。 */
const PROJECT_LEVEL: Record<string, Redirect> = {
  rm:      { command: () => "anet project down", note: "项目级没有删除;停掉项目里所有节点用 down,删单个节点用 anet node delete <name>" },
  remove:  { command: () => "anet project down", note: "项目级没有删除;停掉项目里所有节点用 down,删单个节点用 anet node delete <name>" },
  delete:  { command: () => "anet project down", note: "项目级没有删除;停掉项目里所有节点用 down,删单个节点用 anet node delete <name>" },
  stop:    { command: () => "anet project down", note: "项目级的停叫 down" },
  status:  { command: () => "anet node ls",      note: "看节点在不在跑" },
  state:   { command: () => "anet node ls",      note: "看节点在不在跑" },
  stat:    { command: () => "anet node ls",      note: "看节点在不在跑" },
  ps:      { command: () => "anet node ls",      note: "看节点在不在跑" },
};
export const PROJECT_STATE_CHANGING = ["up", "restart"] as const;

/** `anet node` 的候选集里已经有 stop/delete/ls,所以只剩「看状态」那一类会被
 *  误导:实测 `state` / `stat` → `start`。 */
const NODE_CMD_LEVEL: Record<string, Redirect> = {
  status:  { command: () => "anet node ls",  note: "看节点在不在跑" },
  state:   { command: () => "anet node ls",  note: "看节点在不在跑" },
  stat:    { command: () => "anet node ls",  note: "看节点在不在跑" },
  ps:      { command: () => "anet node ls",  note: "看节点在不在跑" },
  info:    { command: n => `anet info ${n}`, note: "单个节点的详情" },
};
export const NODE_STATE_CHANGING = ["create", "start", "restart", "resume", "rename", "loop"] as const;

/**
 * 认得就返回要打印的几行；认不得返回 null（调用方再退回 suggestSimilar）。
 * `name` 缺省时用占位符，保证提示总是可以照抄。
 */
function redirectIn(table: Record<string, Redirect>, group: string, sub: unknown, name?: unknown): string[] | null {
  if (typeof sub !== "string") return null;
  const hit = table[sub.trim().toLowerCase()];
  if (!hit) return null;
  const n = typeof name === "string" && name.trim() && !name.startsWith("-") ? name.trim() : "<name>";
  return [
    `"anet ${group} ${sub}" 不存在,但你要的动作是有的:`,
    `  ${hit.command(n)}`,
    `  (${hit.note})`,
  ];
}

export const daemonSubcommandRedirect = (sub: unknown, name?: unknown) => redirectIn(NODE_LEVEL, "daemon", sub, name);
export const projectSubcommandRedirect = (sub: unknown, name?: unknown) => redirectIn(PROJECT_LEVEL, "project", sub, name);
export const nodeSubcommandRedirect = (sub: unknown, name?: unknown) => redirectIn(NODE_CMD_LEVEL, "node", sub, name);
