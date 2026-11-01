# @sleep2agi/agent-node 2.5.0-preview.172

Since `.171`: 节点提示词里加了一节「不要反复确认自己」——目标是把**空闲节点烧在自我确认上**的调用压下去。

## Why

生产实测（2026-11-01，近 6h，`node_tool_calls`）：

```text
全部 90 个节点 · 21,770 次调用
  mcp:org_whoami        6,474  (29.7%)
  mcp:get_all_status    5,738  (26.4%)
  ⇒ 两项合计 56.1%
前 12 个节点（全是 tmwork_* id）6h 收了 130 条活 ⇒ 每接 1 条活花 110 次调用
```

这些调用不是「在干活」，是**在确认自己还在线**——而每次都是一整轮 LLM。

## 一处更正：它不是「客户端轮询」

`#3119` 原来写「修在 agent-node / TMWork 客户端的 idle 循环」。实测工具名带 `mcp:` 前缀
⇒ 调用来自**节点自己的 LLM**（通过 MCP），这个仓里没有那个 idle 循环。
所以杠杆是提示词（与 `#3001` 对 `get_task` 做的是同一件事），不是退避循环。

## What changed

新增 `IDENTITY_POLL_DISCIPLINE_LINES`（`agent-node/src/poll-discipline-guidance.ts`），
注入节点提示词：

```text
【不要反复确认自己】
- org_whoami 的答案在进程启动时就定了，同一次会话里反复调用不会有新信息。
  （实测：90 个节点 6 小时 6,474 次 whoami + 5,738 次 get_all_status = 全部调用的 56%）
- 有没有新活，Hub 会推给你；不需要靠轮询 get_all_status 去发现。
- 确实需要查时，两次之间至少隔 5 分钟，并且要有理由。
```

数字必须写进去：没有实测数字时，这只是一条意见。

## Verification

`poll-discipline-guidance.test.ts`（8 pass，新增 4 例）：

```text
① 明确写出「答案在进程启动时就定了」
② 给出实测数字（6,474 / 5,738 / 56%）—— 否则它只是意见
③ 说明「活是推来的」+ 间隔底线 5 分钟
④ cli 的提示词里**真的注入了**这一段
```

第 ④ 条必须断言展开行 `...IDENTITY_POLL_DISCIPLINE_LINES`：
只匹配常量名会被 import 行满足（第一版就是这样，witness 不红；已改）。
witness：删掉展开那一行 ⇒ 第 ④ 条红（reds=1）；复原 ⇒ 8 pass。

## What it does not do

- 不改任何 Hub 侧行为；不发新任务、不改权限、不动数据库。
- **生效需要节点升级**：升级前的节点继续按旧提示词行为。
- 「退避计数」需要客户端配合，本版只做了提示词这一半；生效后按判据复测：
  单节点 6h 调用 800–1000 ⇒ <100，且接活延迟中位 ≤15s / p90 ≤45s（改前基线）。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.172
```

## Upgrade

```bash
# 本机节点
anet node upgrade          # 或按你们的升级流程重装代理侧
# 与 agent-network 成对發版时，CLI 侧的 PAIRED_AGENT_NODE_VERSION 已同步为 .172
anet upgrade
```
