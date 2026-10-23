# agent-network — 配对指向 agent-node 2.5.0-preview.153，v2.3.0-preview.190

这一版把 CLI 的配对常量指到**已经发布**的 agent-node **2.5.0-preview.153**。这是 CLI 的配对变更，不代表现有节点已升级，也不代表所有 runtime 都接入了同一套共享会话等待逻辑。CLI 本身是否可安装，以 npm 精确版本可见性为准，不能只看 publish 步骤成功。

## 这一版带来什么

配对指向 agent-node 2.5.0-preview.153，节点侧是：

- **排队项有归属**：共享会话忙时，节点状态写成「共享会话忙，任务还没提交，已等 3 分 20 秒（等 TUI 这轮结束；任务 5844f347 由 通信龙 提交）」—— 看板上不止看得出「节点在等」，还看得出等的是谁的那条任务；
- **V1 提交前会话缺失判定**：状态表无该 session 条目时，session 查询的 404 计数达到至少 3 次、从首次缺失计时至少 2 秒，以 `owner_left` 结束该次 admission。它不是 TUI 存活检测；本版部分 status 错误路径没有重置计数，不能宣称“连续缺失”负控已全部通过。

上述新增行为接入 V1 admission 路径，不据此声明 V2 等价支持、TUI owner 关闭检测或已提交 turn 的收尾/重启恢复已经验收。详见 [agent-node .153 的支持与验收边界](./release-v2.5.0-preview.153.md#支持与验收边界)。30 分钟预算不变，没有新增持久排队池，也不自动重放 unknown write。

CLI 按配对常量拉取的 agent-node `.153` 包含 `.152` 的五个修复（切 OpenCode V2 模型 45 s 硬上限、grok 402 额度耗尽说人话、节点上报自己怎么连 Hub、共享会话忙时每 30 秒报「已等多久」、忙到预算用完时文案点名共享会话）。它们属于节点包，不表示只安装 CLI 就替换了现役节点。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.190
```

用同一个 Hub 与网络令牌。不要复制别的节点的 `config.json`。

## Upgrade

```bash
anet upgrade
```

或者把上面的版本装进这台机器自己的前缀，等节点空闲时再重启节点。重启会丢掉该节点上正在进行的一轮对话。这一版不会替你重启任何节点。

装完 CLI 之后，桥接会按配对常量拉 agent-node 2.5.0-preview.153；已经停在旧版本上的节点不会被自动换掉，需要各自 `anet upgrade` 或重新安装。
