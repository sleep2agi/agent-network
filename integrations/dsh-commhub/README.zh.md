# @sleep2agi/dsh-commhub（预览）

[English](README.md) | 中文

一个 [DSH（DeepSeek Harness）](https://www.npmjs.com/package/@deepseek-ai/dsh) 插件，让 DSH agent 成为 Agent Network（CommHub）hub 上的一个节点。

- 通过 hub 的 SSE 门铃（`/events/<alias>`）收任务，另有 60 秒兜底轮询。
- 每个任务跑一轮 DSH agent，然后只回一次 `replied` 或 `failed`（不会静默丢）。本地一个小账本保证断线重连、进程重启后也不会重复回件。
- 给 agent 三个工具：`commhub_send_task`、`commhub_send_message`、`commhub_get_all_status`。对方离线时报告为「已排队」，不是失败。
- 用 `report_status` 心跳（`agent: "dsh"`），卸载时上报 `offline`。

## 使用

1. 在 hub 上为这个 alias 生成节点 token（`anet node create` 或 `POST /api/auth/node-token`）。
2. 把 bundle 装进 DSH profile（DSH `0.1.5-rc.2`；DSH 插件 API 在 rc 之间仍会变，所以 peer 依赖钉死版本）：

   ```bash
   dsh plugin --profile web add ./integrations/dsh-commhub
   ```

3. 用环境变量启动 DSH。**token 只从环境变量或 `0600` 文件读取**——写进 DSH patch 文件会被插件拒绝。

   ```bash
   export ANET_HUB=http://127.0.0.1:9200
   export ANET_ALIAS=my-dsh-node
   export ANET_NODE_TOKEN_FILE=~/.dsh-commhub/my-dsh-node.token   # chmod 600
   # 可选：ANET_NETWORK_ID、DSH_COMMHUB_LEDGER
   dsh web
   ```

patch 文件可选配置项（`hub`、`alias`、`networkId`、`tokenFile`、`ledgerPath`、`heartbeatMs`、`pollMs`、`turnTimeoutMs`）见 `src/config.mjs`。

## 行为说明

- 一轮失败会回 `failed` 并带上 DSH 的错误原文（例如缺模型凭据），发件方能看到原因。
- hub 拒收回件时，答案留在账本里，下一次拉取时重发，不会重跑这一轮。
- 插件进程在一轮中途死掉，下次启动时对该任务回 `failed` 并提示「请重发」，而不是悄悄重跑。
- 超过 hub 1 万字上限的回件会截断并附说明。
- 本版对「消息」类（非任务）收件只确认，不交给 agent。

## 测试

```bash
cd integrations/dsh-commhub && npm test   # node --test，进程内假 hub，不需要装 DSH
```
