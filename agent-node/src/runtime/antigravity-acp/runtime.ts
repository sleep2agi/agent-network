// Antigravity CLI（agy）的回合执行：复用 grok 的 ACP 回合实现，只换启动参数与模型策略。
//
// 为什么复用而不是复制：ACP 的 initialize / session/new|load / 事件归约 / 容量重试已经在
// grok-build-acp/runtime.ts 里跑过真机；复制一份会变成第二份协议实现（本仓有过镜像漂移的前车之鉴）。
// 差异点有三个：
//   · 子进程是 `agy acp`（grok 是 `grok agent stdio`，并且带 -m）；
//   · agy 的 `session/set_model` 语义没验证过 —— 不读回、不 fail-closed，按 argv 记 modelSource；
//   · authenticate 选哪个方式：grok 内置的两条规则（xai.api_key / cached_token）只认识
//     grok 自己的 method id，agy advertise 的是 oauth-personal / oauth-business /
//     gemini-api-key / agent-platform，一个都不在那张表里——复用时漏了这点，真机上
//     admin 已经 `agy acp --login` 登录过（`agy models` 能正常列出模型）仍然每次报
//     "no supported non-interactive auth method"。优先级：oauth-personal（最常见的
//     人类直接登录场景）> oauth-business > agent-platform；不选 gemini-api-key——
//     那个要配套传 key，我们目前没有接这条，选了也只会在另一处失败，不如一开始
//     不选，让真正可用的方式先试。
import { runGrokAcpTurn, type GrokAcpTurnOptions, type GrokAcpTurnResult } from "../grok-build-acp/runtime";
import { agyBinary } from "./readiness";
import { AGY_ACP_ARGV } from "./session";

/** 导出供测试直接断言，不用拼 initialize 响应去跑真实握手。 */
export const AGY_AUTH_METHOD_PREFERENCE = ["oauth-personal", "oauth-business", "agent-platform"] as const;

export type AgyTurnOptions = Omit<GrokAcpTurnOptions, "argv" | "enforceModelReadback"> & {
  /** 测试/多版本并行用；默认 AGY_BIN 或 PATH 里的 agy。 */
  binary?: string;
};

export function runAgyAcpTurn(opts: AgyTurnOptions): Promise<GrokAcpTurnResult> {
  return runGrokAcpTurn({
    ...opts,
    binary: opts.binary ?? agyBinary(),
    argv: [...AGY_ACP_ARGV],
    // 2026-11-20：切模型是真的（负责人真机验证），但 agy 不发 model 事件，只能以
    // session/set_model 调用结果为准；不能再用「不读回、按 argv 记」那套。
    trustSetModelResult: true,
    // 真机实测（2026-11-20）：agy 的 ACP server 是 Go 写的，initialize 的
    // protocolVersion 字段类型是 int，Grok 默认发的字符串 "1" 在这里会被
    // Go 的 JSON 反序列化拒绝（-32602 unmarshal error）。agy 要数字。
    protocolVersion: 1,
    authMethodPreference: opts.authMethodPreference ?? AGY_AUTH_METHOD_PREFERENCE,
  });
}
