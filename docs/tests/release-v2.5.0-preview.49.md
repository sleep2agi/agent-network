# @sleep2agi/agent-node 2.5.0-preview.49 — release notes

这一版四条，集中在 **daemon 的 stop/delete 生命周期** 和 **codex-app-server 的回复完整性**。

- **#1448 f1 门铃补偿的 agent-node 侧**（PR #1450）。与 hub 侧成对：重连后按
  pending-unacked 取回窗口期内错过的 stop/start/delete 指令。
- **#1451 opencode 共存 `parseMessageReply`**（PR #1452）。
- **stop 未命中 childrenMap 时也收敛**（PR #1453），与 #1286 的 delete 侧对称补齐。
  此前 delete 修好了、stop 没有，同一张内存表未命中在两条路径上行为不一致。
- **codex-app-server：一个 turn 发多条 agent message 时保住最终答案**（PR #1457，#1449 f1+f2）。
  side-thread adapter 对每条 `agentMessage` 无条件赋值，而 delta 往同一缓冲追加，
  于是**最后到达的那条**成为回复。带工具调用的 turn 会发不止一条（前言 → 答案），
  顺序一旦不是「前言在前」，答案就被过程文本盖掉。现在与主 bridge 一致，按
  `phase === "final_answer"` 过滤；`phase` 缺失/为 null 时仍按最终答案处理，
  避免终态变空串被上层读成失败。
  同 PR 还修了 **owned app-server 启动失败留下孤儿子进程**（#1449 f2）：spawn 之后
  `waitWs` / `connect` / `bootstrap` 任一抛出都不会 kill 自己拥有的子进程，
  supervisor 每重试失败一次就攒一个占端口的僵尸。

🔴 **受影响面说明**：#1449 f1 在 **side-thread / BTW** 那条线上，不是普通网络任务回复 ——
主任务路径（`codex-app-server-bridge.ts`）早就按 `phase` 过滤，前言进不了最终回复。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.64 @sleep2agi/agent-node@2.5.0-preview.49
anet node create
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.49
cd ~/anodes && anet project restart
```

跑着的节点要重启才会拿到新 agent-node（#117）。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1450 | #1448 f1 | 门铃 SSE 重连补偿（agent-node 侧） |
| #1452 | #1451 | opencode 共存 `parseMessageReply` |
| #1453 | #1286 同族 | stop 未命中 childrenMap 时收敛（与 delete 侧对称） |
| #1457 | #1449 f1+f2 | 多条 agentMessage 时保住最终答案；启动失败不留孤儿子进程 |

包含：#1464（#1448 findings 4-6：F4 daemon 校验防静默假 stopped / F5 ntok 按 token_id 精撤 / F6 start replay cmdline 复验）—— 切版时(#1468 bump)已合入 main，产物含之。`npm pack` 实测确认 F5 `child_token_id`、F4 校验代码在 tarball 内。
