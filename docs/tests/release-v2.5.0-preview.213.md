# agent-node 2.5.0-preview.213

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.247** 精确配对。

## Why

**`#4821` 的 daemon 侧接线**：把 Hub 上排队的「列会话」请求拉下来，读本地 OpenCode V2，回填。

```text
· pull_session_requests → 读 `GET /api/session`（原始页）→ ack_session_request
· 读失败 ack ok=false / opencode_unreachable —— 不把「读不到」装成空列表
· 同一 key 可重入去重；15 秒兜底轮询（幂等、unref，不挡进程退出）
· 只在节点有共享 OpenCode server 配置（opencodeSharedServerUrl / PasswordFile）时启用；
  没有就整个不做 —— 不猜默认 server
```

这是「App 里新建节点时选已有 Session」的节点侧前置；App UI 不在本版。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.213 @sleep2agi/agent-network@2.3.0-preview.247
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

## 未覆盖

```text
· 真机端到端（Hub .290 + 节点 .213 → 请求 → 回填 → App 拿到投影结果）未跑
· 投影在 Hub 侧做一次；节点只负责「取一页原始数据」
```
