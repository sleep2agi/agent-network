# @sleep2agi/agent-network 2.3.0-preview.67 — release notes

一条面向用户的改动：**`--copresence` 启动失败时，终于说得清是哪一步、去哪儿看。**

- **OpenCode 共存启动失败的诊断**（PR #1500，#1225 验收 2）。此前失败只有一行

  ```
  [anet] ❌ OpenCode copresence server did not produce its attach launcher within 30s.
  ```

  真死因谁都拿不到，因为两条取证路径同时是空的：CLI 用 `tmux capture-pane` 取现场，
  而等待循环的退出条件之一**就是**「bridge 会话已经没了」—— 会话一没，capture 必然是空；
  agent-node 的日志文件里也没有（崩溃走 stderr）。

  现在：bridge 的输出**落盘**到 `<node>/logs/copresence-bridge.log`（落盘的东西不随
  tmux 会话消失），失败输出**区分「bridge 已经退出」和「bridge 还在跑」**（两者排查方向
  完全不同），并带上落盘日志尾巴、完整日志路径、节点日志目录。两边都没输出时明说
  「没有留下任何输出」，不留空白让人读成"没异常"。

  实测：那条 `expected string, received null at host.ip`（即 `0.9.0-preview.42` 修的那个
  P bug）现在直接打在终端上，而当初定位它花掉了一整个复现容器。

- pin 链同步：`PINNED_SERVER_VERSION` → `0.9.0-preview.42`、
  `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.52`。

**仅仓库侧、不在这个 npm 包里**（`files: ["dist"]`，说明白免得被读成产品改动）：
#1501 / #1507 文档引用清理、#1503 新增 `--copresence` 端到端 CI 套件、#1505 孤儿基线收缩。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.67 @sleep2agi/agent-node@2.5.0-preview.52
anet hub start
anet node create
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.67
anet hub restart
curl -fsS http://127.0.0.1:9200/health
```

本版把 `PINNED_SERVER_VERSION` 升到 `0.9.0-preview.42`，`anet hub restart` 会拉起新版 hub
（含 `host.ip` 那个 P bug 的修复 —— 没有非回环 IPv4 的机器上节点此前起不来）。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1500 | #1225 验收 2 | `--copresence` 失败诊断：bridge 输出落盘 + 指认哪一步 + 日志路径 |
| — | — | pin 链：`PINNED_SERVER_VERSION` → `.42`、`PAIRED_AGENT_NODE_VERSION` → `.52` |
