# @sleep2agi/agent-node 2.5.0-preview.181

Since `.180`: **opencode 运行时也上报 token 用量** —— 但按**增量**报，且 cache 单列。

## Why

`.180` 只接了 claude / codex（它们的 result 里直接给单轮数字）。opencode 不一样：
它的会话接口给的是**累计值**，实测（通信欧）：

```text
tokens: { input: 39,692,280 · output: 13,389,092 · reasoning: 4,173,919
          cache: { read: 15,289,721,547 · write: 0 } }
cost:   $523.98
```

两个坑，直报会把报表彻底搞错：

```text
① 累计值每轮报一次 ⇒ 把历史总量重复几十次
② cache.read 是 input+output 的 289 倍 ⇒ 混算后「谁用得多」变成「谁用得久」
```

## What changed

- `v2-session.ts` 新增 `usageSnapshot()`：读 `/api/session/<id>` 的 `tokens`（会话累计值）。
  `runtime.ts` 的类型与转发一并补上（这个字面量曾漏转发过 `selectedModel`，同样的坑）。
- `cli.ts` 新增 `reportOpencodeUsageDelta()`：
  ```text
  首轮只**对齐**不报（重启后不重复记历史）
  之后报差值（input / output / cache.read 各自独立）
  计数器变小（会话被重置/换了）= 重新对齐，不报负数
  三者都为 0 就不发
  ```
- 复用现有的 30 秒会话轮询顺带读用量（同一轮询里多一次读，不新增定时器）。
- `reportTokenUsage()` 增加 `cacheReadTokens`，透传 `cache_read_tokens`。

## Verification

```text
agent-node/src/report-token-usage.test.ts  6 pass（新增 2 例）
  · 「首轮只对齐」分支存在；对负数不报；cache 单列传出
  · 接线：pollOpencodeSessionModel 里真的调了 usageSnapshot + reportOpencodeUsageDelta
witness：删掉首轮对齐那行 ⇒ 只有第一例红
bun build 通过
```

## What it does not do

- 不报 `reasoning`（与 output 有重叠口径，先不引入第二个"总数"）。
- 重启后第一次轮询的那一段增量丢失（宁可少记，不重复记）。
- 仍只覆盖 claude / codex / opencode 三种运行时；grok 未接。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.181
```

## Upgrade

```bash
anet node restart <name>
```
