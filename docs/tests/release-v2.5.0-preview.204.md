# agent-node 2.5.0-preview.204

Since `.203`: fork 到新目录的克隆一律写 daemon 自己的 Hub 地址。

## Why

`.201` 对挂共享 serve 的 OpenCode 源沿用源节点的 Hub 地址（vdev 上是 `http://…:9300`），理由是
共享 serve 要直连 Hub。实测不是：共享 serve 连的是节点进程里的 127.0.0.1 MCP 代理，转发 Hub 的
是 daemon 拉起的节点进程，带着 daemon 的代理环境，`:9300` 经代理 407，daemon 的 https 地址可达。
vdev 2026-11-11：TMA客户端欧8号由 daemon 拉起、写 https 地址 ⇒ 就绪并回复连通性测试。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.236 @sleep2agi/agent-node@2.5.0-preview.204
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-network `2.3.0-preview.236` 精确配对。

## What it does not do

- 不改已有节点的配置，不重启已运行的节点；只影响 daemon 处理 clone_node
