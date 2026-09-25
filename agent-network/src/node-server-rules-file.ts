// app#225 follow-up —— claude-code 会话节点答规则文件门铃。
//
// node-server.ts 是 claude-code 会话唯一长期存活的自有进程(channel MCP server),
// agent-node 那条链路(runtime/rules-file.ts)它够不着。这里把「门铃 → 拉 → 读/写
// CLAUDE.md → ack」接到同一份逐字节复制的逻辑上(./rules-file.ts,parity 测试钉着)。
//
// 🔴 安全边界与 agent-node 相同:runtime 固定传 "claude"(⇒ 文件名 CLAUDE.md),
//    目录固定是本进程 cwd(= 上报给 hub 的 project_dir);hub 请求里没有路径字段,
//    这里也不读任何路径。
import { processRulesFileRequests } from "./rules-file";
import { fileEnvStore } from "./node-env";

export const CLAUDE_CODE_RULES_RUNTIME = "claude";

export interface RulesDoorbellDeps {
  callCommHub: (method: string, params: Record<string, unknown>) => Promise<any>;
  workDir: string;
  log: (msg: string) => void;
  /** 技能的用户级根目录(~/.claude/skills)取自这里;缺省 os.homedir()。测试注入临时目录。 */
  home?: string;
  /**
   * 节点环境变量(node-env.ts):`anet node start` 起的 claude-code 会话,它的 config.json
   * (.anet/nodes/<id>/config.json)。启动器在拉起 claude 之前把 env 块注入 claude 的环境,
   * 本进程(claude 的 stdio 子进程)继承同一份 —— 所以 in_effect 反映 claude 进程看到的值。
   * 🔴 claude-code 没有 exit-75 监督进程,restart_node 拉不起它 ⇒ restart 恒为 "manual":
   *    改完要在节点所在机器上 `anet node stop` + `anet node start`。
   * 缺省(不是 anet 起的会话、找不到配置)= 不答 env_*,也不上报 env_capable。
   */
  envConfigPath?: string;
}

/** SSE 事件分派:是 rules_file 门铃就处理并返回 true;其它事件原样返回 false。 */
export async function handleRulesFileEvent(event: { type?: unknown } | null | undefined, deps: RulesDoorbellDeps): Promise<boolean> {
  if (!event || event.type !== "rules_file") return false;
  deps.log(`[rules-file] doorbell received`);
  await drainRulesFileRequests(deps, "doorbell");
  return true;
}

/** 连上 / 重连后补拉一次:断线期间桌面端可能已发起请求(hub 侧 60s 内仍 pending)。 */
export async function drainRulesFileRequests(deps: RulesDoorbellDeps, why: string): Promise<number> {
  try {
    return await processRulesFileRequests({
      callCommHub: deps.callCommHub,
      runtime: CLAUDE_CODE_RULES_RUNTIME,
      workDir: deps.workDir,
      home: deps.home,
      log: deps.log,
      warn: deps.log,
      ...(deps.envConfigPath ? {
        env: {
          store: fileEnvStore(deps.envConfigPath),
          restart: "manual" as const,
          processEnv: process.env,
          home: deps.home ?? process.env.HOME,
        },
      } : {}),
    });
  } catch (e: any) {
    deps.log(`[rules-file] ${why} handler failed: ${e?.message || e}`);
    return 0;
  }
}
