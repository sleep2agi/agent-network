# agent-node 2.5.0-preview.72

`.71` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| ab245d4c | #1912 | opencode-cli 共存:网络任务的回件所有权改按 parent 链验证(经 compaction/summary 续写消息可回溯到提交的 messageId 即接受;链上出现人类 TUI 的 user 消息才拒);拒绝时不再把错误文本当答案回件——回答原文以 `[unverified-owner]` 段附在错误件里并写节点日志,状态仍为 failed(#1910) |

## 这一版带给用户什么

opencode 共存节点跑长回合(带工具调用、触发上下文压缩)时,不再出现「活干完了、回件却是一句 `OpenCode reply was not owned by the submitted network message`、真正的答案被丢掉」(外部团队节点 2026-09-17 一手样本:起跑 05:57:59Z / 推送完成 06:01:44Z / 抛错 06:01:58Z)。仍被拒的场合(人类在 TUI 抢了回合),派单方也能在错误件里看到模型实际回了什么。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.72
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.72
anet node stop <name> && anet node start <name> --copresence   # opencode 共存节点要重启才加载
```

## 证据

- `runtime/opencode-copresence/reply-ownership.test.ts` 11/11(直连、一层/两层 summary、人类插入、缺 parent、死链、环、启发式);`runtime.test.ts` 新增 `FAKE_COMPACT_MID_TURN`(接受且回文完整)、`FAKE_RACE_HUMAN` 断言拒绝时带 `unverifiedReplyText`;44/44 共存套件 + 20/20 相邻套件;typecheck 棘轮基线 81/81;test520 变异锚 `evidence?.onConsumed?.();` 仍恰一处。

## promote 时的 must_contain

`"version": "2.5.0-preview.72"`
