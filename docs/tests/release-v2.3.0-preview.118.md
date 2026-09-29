# `@sleep2agi/agent-network@2.3.0-preview.118`

`.117` 之后 `agent-network/` 进 tarball（`files: ["dist"]`）的改动：

| 提交 | PR | 内容 |
|---|---|---|
| 13d4f1c7 | #2058 | `anet daemon start` 的提示多一句：daemon 也管得到它自己带工作目录建出、登记在 `.anet/child-workdirs.json` 里的节点 |
| 1ade6d42 | #2073 | claude-code 通道里的 `rules-file.ts` 副本（与 agent-node 字节一致）认得 `logs_tail`，但通道进程不注入处理器，收到就应答 failed，也从不上报 `logs_capable` |
| 1ccb6099 | #2094 | claude-code 通道收到 `new_reply` 也会取收件箱（以前直接丢掉这个事件），并每 60 秒兜底轮询一次收件箱（`ANET_CHANNEL_INBOX_POLL_MS`，`0` 关闭）；取收件箱是单飞的，SSE 唤醒和轮询不会把同一条注入两次。轮询取到东西时日志打 `inbox poll: delivered=N` |

另外 `PAIRED_AGENT_NODE_VERSION` 指向 `agent-node@2.5.0-preview.91`（节点运行日志 #2073 + 建节点指定工作目录 #2058），`PAIRED_AGENT_NETWORK_VERSION` 随之指向 `.118`。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.118
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.118 @sleep2agi/agent-node@2.5.0-preview.91
```

🔴 **两个包要一起升**（`.118 ↔ .91`）。

## promote 时的 must_contain

`"version": "2.3.0-preview.118"`
