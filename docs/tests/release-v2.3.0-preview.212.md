# @sleep2agi/agent-network 2.3.0-preview.212

Since `.211`: 配对常量跟到 `agent-node@2.5.0-preview.179`。

## Why

`.179` 加的是**诊断**：在打开共存运行时之前无条件打印对账判据的三格输入
（`model` / `marker` / `generation`，外加 `resume` 与 `decide`）。

起因是生产里一个矛盾：`.178` 的 `armModelReconcile` 已让 marker 清空（发现漂移成立），
但下一次启动仍走「保留会话模型」分支；而在壳里用同一份函数、同一个文件跑，
`shouldReconcile` 却是 `true`。

启动器只跑配对常量钉住的那一版 ⇒ 不发这一版，`.179` 装在机器上也不会被用。

## What changed

```text
PAIRED_AGENT_NODE_VERSION: 2.5.0-preview.178 -> 2.5.0-preview.179
上手指南的 version-claim: .211 -> .212（gate 4 要求与发布同提交）
```

## Verification

```text
安装后 anet --version 应读回：✓ agent-node v2.5.0-preview.179
节点重启后日志应出现一行： [opencode] reconcile inputs model=… marker=… generation=… resume=… decide=…
```

## What it does not do

- 不修复对账；只让“为什么判成 false”有答案。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.212
```

## Upgrade

```bash
anet node restart <name>
```
