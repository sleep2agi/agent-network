// #1770 —— 共存 TUI 里模型能调的 CommHub 工具来自 `.anet/node-server.js`(outbound-only),
// 那个进程不知道运行时正替谁跑哪条任务。运行时在注入网络任务时写下这个标记,
// 回合结束(完成 / 放弃)时删掉;node-server 据此把模型对发起方的 send_task/send_message
// 改写成该任务的进度上报,发起方就不会收到同一句话三遍。
//
// 文件放在 `<projectCwd>/.anet/` —— 和 node-server 的 `.env` 同目录、同 0600 权限;
// 路径通过 mcp 配置的 env `ANET_ACTIVE_NETWORK_TASK_FILE` 显式交给 node-server,
// 不让它按 cwd 猜(credentialDir 布局下 .env 不在项目目录里)。
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ACTIVE_NETWORK_TASK_FILE = ".active-network-task.json";

export interface ActiveNetworkTaskMarker {
  taskId: string;
  from: string;
  startedAt: number;
}

export function activeNetworkTaskMarkerPath(projectCwd: string): string {
  return join(projectCwd, ".anet", ACTIVE_NETWORK_TASK_FILE);
}

/** 原子写(tmp + rename),0600;目录不存在就建(0700)。 */
export function writeActiveNetworkTaskMarker(path: string, marker: ActiveNetworkTaskMarker): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ taskId: marker.taskId, from: marker.from, startedAt: marker.startedAt }), { mode: 0o600 });
  renameSync(tmp, path);
}

/** 不存在也算成功——清理必须幂等,回合结束会从多条路径各清一次。 */
export function clearActiveNetworkTaskMarker(path: string): void {
  rmSync(path, { force: true });
}
