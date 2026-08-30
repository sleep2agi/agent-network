# @sleep2agi/agent-network 2.3.0-preview.69 — release notes

一条 CLI 修复：**`anet node stop` 不再对「已经停掉的节点」误报失败。**

- **回收无监听者的陈旧 socket 路径名**（PR #1526，#1422 的一格）。
  症状：grok 共存节点 stop 之后偶发
  `STOP_TIMEOUT: authoritative local resources survived …` + 非零退出，
  而**节点其实已经停了**。

  根因不是「拆得慢」：CLI 给整棵树的宽限是 **5s**（`reapOwnedGeneration`：SIGTERM → 5s → SIGKILL → 3s），
  而 agent-node 侧 Leader 拆卸链最坏 **8s**（每段默认 2000ms × 4）。越线即 SIGKILL ⇒
  删 socket 的 `removeUnchangedStaleSocket` **永不执行** ⇒ 留下**孤儿路径名**；
  CLI 随后在自己的 10s 窗口里**等一个它刚杀掉的清扫者**。所以放宽窗口原理上无效。

  修法：属主**已证死**之后，CLI 自己做一次**带守卫**的 unlink——
  核文件身份 → 查 `/proc/net/unix` **无监听者** → unlink；
  **读不到 `/proc/net/unix` 时 fail-closed 不删**；
  **只回收按 `profile.node_id` 重算出的规范路径**（被写坏的 profile 带不进别处的 socket）。
  **有监听者时照旧判红**，门的强度没有下降。

🔴 **这不是「test225 偶红修好了」**：同一条被掐断的清理链上还有别的痕迹（`.grok` 等
project sandbox placeholder、`stateFiles`、`nativeLeaderLockBinding` …）。红可能从
`node stop failed for <X>` 变成 `retained … .grok`。**真正的病是预算错配，在 #1522 跟踪。**

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.69 @sleep2agi/agent-node@2.5.0-preview.54
anet hub start
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.69
anet hub restart
curl -fsS http://127.0.0.1:9200/health
```

🔴 别只看进程起来了 —— `/health` 返回才证明它在响应。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1526 | #1422（一格，不 close） | 属主已证死后回收无监听者的陈旧 socket 路径名 |

pin 链：`PINNED_SERVER_VERSION` 仍为 `0.9.0-preview.43`（server 本轮无改动）、
`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.54`。
