# @sleep2agi/agent-node 2.5.0-preview.173

Since `.172`: 把「不要反复确认自己」那一节补全 —— 同一族里还有两个工具，四项相加占全部调用 **84.9%**。

## Why

生产实测（2026-11-01，近 6h，`node_tool_calls`，总 23,273 次）：

```text
mcp:org_whoami      6,943  29.8%
mcp:get_all_status  6,141  26.4%
mcp:list_tasks      4,480  19.2%
mcp:get_task        2,193   9.4%
⇒ 四项合计 19,757 = 84.9%
```

它们回答的都是同一个问题：「现在有没有新东西」。而 Hub 已经用**推送**回答过了。

## What changed

`.172` 只写了 whoami / get_all_status；这一版把 `list_tasks` 与 `get_task` 也点出来，
并给出四项合计比例（84.9%）——不带数字时，它只是一条意见。

## Verification

`poll-discipline-guidance.test.ts` 9 pass（新增 1 例）：
断言文案里同时出现 `list_tasks`、`get_task`、`84.9%`。
witness：删掉新增那两行 ⇒ 该例红；复原 ⇒ 9 pass。

## What it does not do

- 不改 Hub 行为；不动任何数据。
- 生效仍需节点升级。
- 「Hub 推给你的」这一点若在某些客户端上不成立，本条会误导 —— 所以它和 `.172` 一样，
  属于**需要按判据复测**的改动：单节点 6h 调用 800–1000 ⇒ <100，且接活延迟不破基线。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.173
```

## Upgrade

```bash
anet node upgrade
anet upgrade
```
