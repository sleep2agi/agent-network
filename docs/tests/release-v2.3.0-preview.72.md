# @sleep2agi/agent-network 2.3.0-preview.72

## 内容：两处会让人**看错状态**的修复

| PR | 修的是什么 |
|---|---|
| #1575 | **非 claude-agent-sdk 节点上拒绝配置飞书通道** —— 飞书回合的工具拒绝层（RFC-020 §13 Layer B）只实现为 claude-agent-sdk 的 `PreToolUse` hook，在 codex/opencode 上**一次都不会触发**。此前通道配得上、看起来正常，而密钥路径工具 / 抽密钥的 Bash / 飞书回合上的 commhub 横向 `send_task` **全部放行**。 |
| #1577 | **`anet status` 不再把「卡住/出错」显示成「在干活」** —— 分类器把 `blocked` / `error` 折进 `working`，运维看到的「N working」里可能有卡住的。而 `blocked` 是一个**没有出口**的状态（只有 `report_completion` 能拉回 idle）。 |

**两者是同一个形状**：一件"需要人看一眼"的事，被渲染成了"一切正常"。

## Install

新装（首次使用）：

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.72
anet --version
```

## Upgrade

已经装过的：

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.72
anet --version        # 应显示 2.3.0-preview.72
anet status           # 现在会多一格 "N needs attention"（如果有 blocked/error 的话）
```

验收按 SOP §2.5 四步（第 ④ 步不能省 —— tar 列得出文件不等于它跑得对）：

```bash
npm view @sleep2agi/agent-network dist-tags.preview           # 2.3.0-preview.72
npm view @sleep2agi/agent-network@2.3.0-preview.72 exports    # 含 ./daemon-capability-display
# ③ npm pack + tar -tzf 列出该文件
# ④ 解包后 import 跑一次
```

🔴 **部署 anet.sh 必须在发包与验收之后**（SOP §2.6 的顺序）。这个 bump 一合入，
main 上的上手指南就指向 `.72` —— 而它此刻还不存在。

## 发布方式

`release-gate (v0)` workflow_dispatch，`package=agent-network`、
`version=2.3.0-preview.72`、`publish=true`。**只发 preview**；
promote 到 latest 需要 owner ACK，本次**不做**。
