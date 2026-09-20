# agent-node 2.5.0-preview.71

`.70` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| main after #1902 | #1902 | 串行队列出队提交前 `get_task` 一次:已终态(replied/failed/cancelled/expired)的任务不再起 turn,只 ack + 记 consumed;查不到/查询失败不拦(#1900) |

## 这一版带给用户什么

codex-app-server 等串行运行时的节点,排队期间已被 agent 提前回过(或被别人关掉)的任务不会再被跑一轮 —— 之前这一轮会浪费一个 turn,还可能覆写邻近任务状态、让子任务回件替答人类提问(外部团队节点 2026-09-16 实测,生产 hub 库核对)。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.71
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.71
anet node stop <name> && anet node start <name>      # 或 anet daemon restart <daemon>
```

## 证据

- `runtime/terminal-task-guard.test.ts` 5/5(含 cli.ts 源码契约),变异「不跳过」见证红;agent-node typecheck 0 新增错误。

## promote 时的 must_contain

`"version": "2.5.0-preview.71"`
