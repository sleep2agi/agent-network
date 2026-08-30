# agent-node 2.5.0-preview.57

`.56` 之后有 3 个提交改到 `agent-node/`，都落在 `files: ["dist","README.md"]` 覆盖范围内。

| 提交 | PR | 内容 |
|---|---|---|
| `3746b362` | #1609 | **#1548 主修复** —— liveness 不再无条件要求 `leader.sock` |
| `b747ee53` | #1608 | attach `hello` 带上当前 status 快照 |
| `e489e115` | #1590 | 修掉两处不存在的版本号引用 |

## 这一版修的是什么

grok **1.0.5 是 leaderless build** —— 按设计就不创建 `leader.sock`（能力表里 `autoLeader: false`，
macOS 与 Linux 都是）。而 liveness 的 `usable` 无条件要求 `leaderPresent`：

```js
usable = childAlive && tuiReady && attachPresent && leaderPresent && attachNamed && leaderNamed
```

⇒ 这类节点上 `usable` **结构性恒假**，心跳上报的 `idle` 每 3 分钟被改写成 `blocked`，**永远**。

生产实测：被标成 `blocked` 的节点仍然成功 `injected network task` → `processTask returned(failed=false)`
→ 回复送达。而全名册的负控是 **非 grok 节点 blocked = 0/114**。

修法（#1609）：

```js
const leaderOk = autoLeader ? (leaderPresent && leaderNamed) : !leaderPresent;
```

**两个方向都 fail-closed**，与启动路径的 `settleLeader()` 逐条对齐 —— `autoLeader:false` 上
socket 若出现反而不 usable（启动路径就是这么抛的，这里不比它松）。
`autoLeader` 取自 `settleLeader()` 用的同一个 `grokBuildAutoLeader`，**不产生第二份判据**
（#1548 的成因就是两份判据不一致）。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.57
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.57
# 🔴 liveness 在**长驻进程内**算 —— 换包对已经在跑的节点没有任何影响,必须重启:
anet daemon restart <daemon>        # 需要 anet ≥ 2.3.0-preview.74
# 早于 .74 的 anet 用两步:
anet node stop <name> && anet node start <name>
```

## 验收：修完之后那一格才开始携带信息

修复前 `blocked` 对所有 leaderless 节点是恒定的，**不携带任何信息** ——
既不能说明节点坏了，也不能说明没坏。升级并重启之后：

- 仍显示 `blocked` ⇒ **这是第一次有信息量的 blocked**，去查 `childAlive` / `tuiReady` / `attach`；
- 转为 `idle` ⇒ 之前那次是假阳性。

## 已知的待办（本 PR 不夹带）

`agent-node/src/runtime/config-apply.ts` 与 `agent-network/src/daemon-capability-display.ts`
的注释里写着「agent-node 已发布的最高 preview 是 `2.5.0-preview.56`」。
`.57` 发布后这句会变成假话。**发版 PR 保持最小，不在这里夹带源码改动** —— 单独一条跟。

## 发布方式

走 GitHub Actions（`release-gate (v0)`）。不在本机 publish，对外只从 main 出。
`latest` 保持 `2.5.0-preview.34` 不动 —— 升 latest 需要 owner ACK。
