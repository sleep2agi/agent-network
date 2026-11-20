// Antigravity CLI（agy）的 ACP 会话骨架（负责人 2026-11-20：正常 ACP runtime）。
//
// 复用 grok-build-acp 的 JSON-RPC stdio 客户端（同一个 ACP 协议），只把启动 argv 换成 `agy acp`。
// 这一层先只做「能握手、能建会话」，事件归约/工具审批等按 grok 那套逐步接。
//
// 注意：ACP 的 session/new 需要已登录；未登录时 initialize 仍然成功、session/new 会报认证错误，
// 所以调用方先跑 readiness + `agy models` 判登录态，再进这里。
import { GrokAcpClient } from "../grok-build-acp/client";
import { agyBinary } from "./readiness";

export const AGY_ACP_ARGV = ["acp"] as const;

export interface AgyInitializeResult {
  protocolVersion?: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: Record<string, unknown>;
  authMethods?: Array<{ id?: string; name?: string }>;
}

export interface AgySession {
  client: GrokAcpClient;
  init: AgyInitializeResult;
  close(): Promise<void>;
}

/** 起 `agy acp` 并完成 initialize 握手。调用方负责 close()。 */
export async function openAgyAcpSession(opts: { cwd?: string; env?: NodeJS.ProcessEnv; binary?: string } = {}): Promise<AgySession> {
  const client = new GrokAcpClient();
  client.start({ ...opts, binary: opts.binary ?? agyBinary(), argv: [...AGY_ACP_ARGV] });
  try {
    const init = await client.request<AgyInitializeResult>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    }, 20_000);
    return { client, init, close: () => client.close() };
  } catch (error) {
    void client.close();
    throw error;
  }
}
