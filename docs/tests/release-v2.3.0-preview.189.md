# agent-network — 配对指向 agent-node 2.5.0-preview.152，v2.3.0-preview.189

这一版把 CLI 的配对常量指到**已经发布**的 agent-node **2.5.0-preview.152**。装上这一版 CLI 之后，Codex / OpenCode 桥接会拉那一版 agent-node —— 那五个修复因此真正到达节点。

## 这一版带来什么

配对指向 agent-node 2.5.0-preview.152，节点侧是五个修复：

- 切换 OpenCode V2 模型有 45 秒硬上限：换成本机没有的模型不再把节点卡死；
- grok 账号额度耗尽（402）说人话，不再甩一串 JSON；
- 节点报出自己是怎么连 Hub 的（loopback / https / plain）；
- 共享会话忙时，每 30 秒报一次「已等多久」；
- 共享会话忙到预算用完时，文案点名「共享会话被 TUI 的一轮占着（不是节点卡死）」。

另外带上一处单元域的修复（#2848）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.189
```

用同一个 Hub 与网络令牌。不要复制别的节点的 `config.json`。

## Upgrade

```bash
anet upgrade
```

或者把上面的版本装进这台机器自己的前缀，等节点空闲时再重启节点。重启会丢掉该节点上正在进行的一轮对话。这一版不会替你重启任何节点。

装完 CLI 之后，桥接会按配对常量拉 agent-node 2.5.0-preview.152；已经停在旧版本上的节点不会被自动换掉，需要各自 `anet upgrade` 或重新安装。
