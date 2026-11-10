# agent-node 2.5.0-preview.201

Since `.200`: fork 到新目录对 OpenCode 共享 serve 节点可用（vdev 真机实测修复）。

## Why

`.200` 把 TMA客户端欧6号 fork 到新目录后，新节点第一轮就 `outcome=failed`：
- 克隆没带 `opencodeSharedServerUrl` / `opencodeSharedServerPasswordFile`，自己起了私有 serve，私有 serve 里没有 provider 密钥；
- 克隆写的是 daemon 的 Hub 地址（https），共享 serve 要直连这个地址加载 CommHub MCP，在 vdev 上不经代理连不上 https。

现在克隆会带上共享 serve 的地址和密码文件**路径**（不是密码本身）。源节点地址与 daemon 相同，或等于收编时证明过的 `proven_hub` 时，沿用源节点的 Hub 地址。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.233 @sleep2agi/agent-node@2.5.0-preview.201
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-network `2.3.0-preview.233` 精确配对。

## What it does not do

- 不改已有节点的配置，不重启已运行的节点；只影响 daemon 处理 clone_node
