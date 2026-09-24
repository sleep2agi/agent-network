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

export const CLAUDE_CODE_RULES_RUNTIME = "claude";

export interface RulesDoorbellDeps {
  callCommHub: (method: string, params: Record<string, unknown>) => Promise<any>;
  workDir: string;
  log: (msg: string) => void;
  /** 技能的用户级根目录(~/.claude/skills)取自这里;缺省 os.homedir()。测试注入临时目录。 */
  home?: string;
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
    });
  } catch (e: any) {
    deps.log(`[rules-file] ${why} handler failed: ${e?.message || e}`);
    return 0;
  }
}
