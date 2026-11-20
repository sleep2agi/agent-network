// Antigravity CLI（agy）的回合执行：复用 grok 的 ACP 回合实现，只换启动参数与模型策略。
//
// 为什么复用而不是复制：ACP 的 initialize / session/new|load / 事件归约 / 容量重试已经在
// grok-build-acp/runtime.ts 里跑过真机；复制一份会变成第二份协议实现（本仓有过镜像漂移的前车之鉴）。
// 差异点只有两个：
//   · 子进程是 `agy acp`（grok 是 `grok agent stdio`，并且带 -m）；
//   · agy 的 `session/set_model` 语义没验证过 —— 不读回、不 fail-closed，按 argv 记 modelSource。
import { runGrokAcpTurn, type GrokAcpTurnOptions, type GrokAcpTurnResult } from "../grok-build-acp/runtime";
import { agyBinary } from "./readiness";
import { AGY_ACP_ARGV } from "./session";

export type AgyTurnOptions = Omit<GrokAcpTurnOptions, "argv" | "enforceModelReadback"> & {
  /** 测试/多版本并行用；默认 AGY_BIN 或 PATH 里的 agy。 */
  binary?: string;
};

export function runAgyAcpTurn(opts: AgyTurnOptions): Promise<GrokAcpTurnResult> {
  return runGrokAcpTurn({
    ...opts,
    binary: opts.binary ?? agyBinary(),
    argv: [...AGY_ACP_ARGV],
    enforceModelReadback: false,
  });
}
