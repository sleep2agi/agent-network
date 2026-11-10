# @sleep2agi/agent-node 2.5.0-preview.180

Since `.179`: 每轮结束后把 token 用量报给 Hub（`report_token_usage`）。配套 Hub `0.9.0-preview.271`。

## Why

admin 2026-11-05「要对节点进行 Token 审计了，能看到节点消耗了多少 Token」。

Hub 侧 `.271` 已经把记账表与读取接口做好，但**表是空的** —— 因为用量只在运行时手里：
`claude` 的 result message 与 `codex` 的 turn outcome 都带 `input_tokens` / `output_tokens`，
而节点此前只把它们写进日志。

## What changed

- 新增 `reportTokenUsage(model, input, output, {turns, costUsd})`：
  调 `callCommHub("report_token_usage", …)`，**不 await**（记账是旁路），
  失败只 `debug()` 一行 —— 报不上不能让回合失败或心跳变红。
  只在真拿到数字时发；`0` 照发（「这一轮没消耗」与「没上报」不是一回事）。
- 两处调用点：
  ```text
  claude  轮末 result message 之后（带 turns 与 total_cost_usd，本来就在 message 里）
  codex   turn outcome 之后（codex 没给 turns/cost 就不填）
  ```
- 只报计数：调用点附近没有 prompt / content / message_id / credential（测试钉住）。

## Verification

```text
agent-node/src/report-token-usage.test.ts  4 pass
  · 上报函数存在、失败被吞、且**没有 await**（记账不该让回合等待）
  · claude 与 codex 两条路径都接了（只接一条 = 另一种运行时永远没数据）
  · claude 路径带 turns / costUsd
  · 只报计数：附近不出现 prompt / content / message_id / credential
witness A：删掉 codex 那一条 ⇒ 只有「两条路径都接了」红
witness B：去掉 .catch ⇒ 只有「失败被吞掉」红
bun build 通过
```

## What it does not do

- **opencode 运行时还没有用量**（它的会话接口没暴露 token 计数；要另找来源）——
  所以本期覆盖率是 claude + codex，不是"全部运行时"。
- 不做本地聚合：一轮一条上报，Hub 按小时桶累加。
- 不报 prompt 内容、不报消息 id —— 这是设计边界，不是遗漏。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.180
```

## Upgrade

```bash
anet node restart <name>
```
