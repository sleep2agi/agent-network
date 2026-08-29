# @sleep2agi/agent-node 2.5.0-preview.50 — release notes

一条修复，安全相关。

- **删除节点后本地密钥残留**（PR #1478，修 issue #1474 finding-1）。daemon 的 workdir 根此前
  **硬编码 `homedir()`**，而节点实际的工作目录由 `workDir` 决定。当两者不同（cwd ≠ home）时，
  delete 去 home 底下找那个目录、找不到、于是**什么都没搬走** —— 节点配置连同其中的凭据
  留在真实的 workdir 里。现在根从 `workDir` 派生，delete 搬的是节点真正所在的那个目录。

🔴 **升级之后请自查一次**：本版只修「以后不再残留」。**之前**在 cwd ≠ home 的机器上删过的节点，
残留目录仍在原处，需要手工确认：

```bash
ls -la <你的 workDir>/.anet/nodes/     # 已删节点的目录若还在，里面可能有凭据
```

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.65 @sleep2agi/agent-node@2.5.0-preview.50
anet node create
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.50
cd ~/anodes && anet project restart
```

跑着的节点要重启才会拿到新 agent-node（#117）。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1478 | #1474 finding-1 | daemon workdir 根从 `workDir` 派生，消除删后密钥残留 |

**未包含**：issue #1474 的 **finding-2（pgid）** 尚未合入 main，走 `2.5.0-preview.51` fast-follow。
（注意 #1474 finding-2 与 #1469 finding-2 是两码事 —— 后者是 network_id，已在 agent-network `2.3.0-preview.65` 里。）
