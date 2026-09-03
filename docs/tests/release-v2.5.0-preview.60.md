# agent-node 2.5.0-preview.60

`.59` 之后改到 `agent-node/` 的只有一个提交,但它是 #1770 的一半,另一半在 agent-network 2.3.0-preview.77 的 node-server 里;**两边都升到位这条修复才生效**。

| 提交 | PR | 内容 |
|---|---|---|
| `093c0d06` | #1778 | **#1770** —— 共存运行时注入网络任务时写 `<cwd>/.anet/.active-network-task.json`(`{taskId, from, startedAt}`,0600),网络回合完成/放弃时删;路径经 mcp env `ANET_ACTIVE_NETWORK_TASK_FILE` 交给 node-server |

## 这一版带给用户什么

共存节点(grok TUI)里模型自己对任务发起方再发一遍 send_message / high send_task,发起方同一句话收三次(09-02 晚 TMWork苹果打包狗 实测)。这一版让运行时把「当前替谁跑哪条任务」写成标记;配合 agent-network `.77` 的 node-server,那两条重复出站会被改写成不推送的进度上报。只升 agent-node 不升 anet:标记会写,但没人读,行为与 `.59` 相同(无害)。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.60
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.60
npm i -g @sleep2agi/agent-network@2.3.0-preview.77   # #1770 的另一半
anet daemon restart <daemon>        # 或 anet node stop <name> && anet node start <name>
```

## 证据

- `active-network-task-marker.test.ts` 4 条、`runtime.test.ts` +1(注入时标记存在且字段正确,turn_ended 后消失;变异去掉清除 → 红)。

## promote 时的 must_contain

`ANET_ACTIVE_NETWORK_TASK_FILE`(无正则元字符;`.59` 产物 0 命中——发布前用闸 4 原样命令再验一次)。
