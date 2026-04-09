/**
 * @sleep2agi/agent-node
 *
 * AI Agent 节点 — 一行命令加入 CommHub 网络
 * 通信层: @sleep2agi/agent-network (CommHub SDK)
 * AI 层: @anthropic-ai/claude-agent-sdk
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { CommHub } from "@sleep2agi/agent-network";
import type { InboxMessage } from "@sleep2agi/agent-network";

export type { InboxMessage };

export type Runtime = "claude" | "codex" | "agent-sdk";

export interface AgentNodeConfig {
  alias: string;
  hub: string;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  systemPrompt?: string;
  token?: string;
  heartbeatInterval?: number;
  runtime?: Runtime;
  /** 任务处理前钩子。返回 string 跳过 AI，返回 void 走默认处理 */
  onTask?: (msg: InboxMessage) => Promise<string | void>;
  /** 任务处理后钩子 */
  onResult?: (msg: InboxMessage, result: string) => Promise<void>;
  log?: (msg: string) => void;
}

export class AgentNode {
  private config: Required<Pick<AgentNodeConfig, "alias" | "hub" | "model" | "tools" | "maxTurns" | "heartbeatInterval" | "runtime">> & AgentNodeConfig;
  private hub: CommHub;
  private running = false;
  private sessionId?: string;
  private log: (msg: string) => void;

  constructor(config: AgentNodeConfig) {
    this.config = {
      model: "claude-sonnet-4-6",
      tools: [],
      maxTurns: 5,
      heartbeatInterval: 3 * 60 * 1000,
      runtime: "claude",
      ...config,
    };
    this.hub = new CommHub({
      url: config.hub,
      alias: config.alias,
      token: config.token,
      agent: "agent-node",
      heartbeatInterval: this.config.heartbeatInterval,
      autoConnect: false,
    });
    this.log = config.log || ((m: string) =>
      console.log(`[${new Date().toTimeString().slice(0, 8)}] [${config.alias}] ${m}`)
    );
  }

  private async processTask(msg: InboxMessage): Promise<string> {
    if (this.config.onTask) {
      const override = await this.config.onTask(msg);
      if (typeof override === "string") return override;
    }

    if (this.config.runtime === "codex") {  // agent-sdk 走 claude 路径
      // TODO: Codex runtime 支持
      return `[codex runtime 暂未实现] 收到: ${msg.content.slice(0, 100)}`;
    }

    // Claude runtime (默认)
    const prompt = `你是 ${this.config.alias}，收到来自 ${msg.from_session} 的任务：\n\n${msg.content}\n\n执行完后简要汇报结果。`;

    const options: any = {
      model: this.config.model,
      tools: this.config.tools?.length ? this.config.tools : [],
      maxTurns: this.config.maxTurns,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // 显式传 env 确保子进程继承所有环境变量（含 ANTHROPIC_BASE_URL 等）
      env: process.env,
      cwd: process.cwd(),
      // 捕获 stderr 用于 debug
      stderr: (data: string) => { if (data.trim()) this.log(`[stderr] ${data.trim().slice(0, 200)}`); },
    };

    if (this.config.systemPrompt) options.systemPrompt = this.config.systemPrompt;
    if (this.sessionId) options.resume = this.sessionId;

    let result = "";
    try {
      for await (const m of query({ prompt, options })) {
        if ((m as any).type === "system" && (m as any).subtype === "init") {
          this.sessionId = (m as any).session_id;
        }
        if ((m as any).type === "result") {
          result = (m as any).subtype === "success"
            ? (m as any).result
            : `错误: ${(m as any).result || (m as any).error}`;
        }
      }
    } catch (e: any) {
      result = `SDK 错误: ${e.message}`;
      this.log(`错误: ${e.message}`);
    }

    if (this.config.onResult) {
      await this.config.onResult(msg, result);
    }

    return result;
  }

  async start() {
    this.running = true;
    this.log(`启动 | Hub: ${this.config.hub} | Model: ${this.config.model} | Runtime: ${this.config.runtime}`);

    // 连接 CommHub（注册 + SSE + 心跳）
    await this.hub.connect();
    this.log("已连接 CommHub");

    // 监听任务
    this.hub.on("task", async (msg: InboxMessage) => {
      const from = msg.from_session || "hub";
      this.log(`← [${from}] ${msg.content?.slice(0, 60)}`);

      await this.hub.status("working", { task: msg.content?.slice(0, 50) });
      const result = await this.processTask(msg);
      this.log(`→ [${from}] ${result?.slice(0, 60)}`);

      await this.hub.send(from, `[${this.config.alias}] ${result?.slice(0, 2000)}`);
      await this.hub.status("idle");
    });

    // 优雅退出
    const shutdown = async () => {
      this.log("退出...");
      this.running = false;
      await this.hub.disconnect();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // 保持进程运行
    await new Promise(() => {});
  }

  async stop() {
    this.running = false;
    await this.hub.disconnect();
    this.log("已停止");
  }
}

export default AgentNode;
