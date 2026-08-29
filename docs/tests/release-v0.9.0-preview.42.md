# @sleep2agi/commhub-server 0.9.0-preview.42 — release notes

一条修复，但它影响的是**节点能不能起来**，所以建议尽快升。

- **`report_status` 接受 `host.ip = null`**（PR #1498）。此前 `host` 遥测里
  `ip` 只写了 `.optional()` 没写 `.nullable()`，而 agent-node 的
  `HostTelemetry` 类型本来就声明 `ip: string | null` ——
  `firstNonInternalIPv4()` 在**没有非回环 IPv4 的机器**上返回 `null`。
  于是那台机器上的 agent-node 一启动就收到

  ```
  MCP error -32602: Invalid input: expected string, received null at host.ip
  ```

  而 agent-node 的启动注册是顶层 `await register()` 且没有 catch ——
  **整个节点进程当场退出，与 runtime 无关**（claude / codex / grok / opencode 一样）。

🔴 **触发条件不是"在容器里"，是「这台机器没有非回环 IPv4」**：断网的笔记本、
只有 loopback 的 CI runner、`--network none` 的容器都算。有正常 IPv4 的机器不受影响。

🔴 **为什么修在 hub 侧**：只改发送方（agent-node 在 null 时不发这个 key）也能让新版本
不崩，但**现网已经装好的 agent-node 正是受影响的那些**，它们不会因此被修好。
改 hub 一侧，**已部署的节点不需要升级就恢复**。
（发送方的额外硬化在 agent-node `2.5.0-preview.52`，两者互补：一个救现在，一个防将来。）

同一个对象里四个数值字段本来就是 `.nullable().optional()`，两个字符串字段是唯一的例外
—— 正确写法一直在隔壁那一行。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.67 @sleep2agi/agent-node@2.5.0-preview.52
anet hub start
```

hub 自己由 `anet` 按 `PINNED_SERVER_VERSION` 拉起（本版 `0.9.0-preview.42`），
通常不需要单独装 `@sleep2agi/commhub-server@0.9.0-preview.42`。

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.67
anet hub restart
curl -fsS http://127.0.0.1:9200/health
```

🔴 别只看进程起来了 —— `/health` 返回才证明它在响应。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1498 | #1225 诊断产物 | `report_status` 的 `host.hostname` / `host.ip` 改为 `.nullable()` |

端到端证据（同一个容器、同一条命令，只差这一处改动）：修前 `❌ … within 30s` exit=1，
修后 `✅ 共存节点就绪` exit=0。
