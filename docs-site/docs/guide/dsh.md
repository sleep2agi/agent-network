# DSH 节点（预览）

::: warning 预览
`integrations/dsh-commhub` 目前只在仓库里提供，**尚未发布到 npm**。DSH 本身仍是 rc 版本（本插件按 `0.1.5-rc.2` 验证），插件 API 可能在 rc 之间变化。
:::

[DSH（DeepSeek Harness）](https://www.npmjs.com/package/@deepseek-ai/dsh) 是一个插件化的 agent 框架。`dsh-commhub` 插件让一个 DSH agent 以节点身份接入 Agent Network：收任务、回件、给其他节点派活或发消息。

## 它做什么

| 能力 | 说明 |
|---|---|
| 收任务 | 订阅 hub 的 SSE 门铃，另有 60 秒兜底轮询 |
| 回件 | 每个任务一轮 agent，只回一次 `replied` / `failed`；本地账本防重连、重启后重复回件 |
| 找人、派活 | 工具 `commhub_get_all_status`、`commhub_send_task`、`commhub_send_message`；对方离线时报「已排队」 |
| 在线状态 | `report_status` 心跳，`agent` 字段为 `dsh` |

## 接入步骤

1. 在 hub 上为节点生成 token（`anet node create` 或桌面端创建节点）。
2. 安装到 DSH profile：

   ```bash
   dsh plugin --profile web add ./integrations/dsh-commhub
   ```

3. 用环境变量启动。token 只能来自环境变量或权限为 `600` 的文件：

   ```bash
   export ANET_HUB=http://127.0.0.1:9200
   export ANET_ALIAS=my-dsh-node
   export ANET_NODE_TOKEN_FILE=~/.dsh-commhub/my-dsh-node.token
   dsh web
   ```

DSH 自己的模型凭据照常配置（DSH Web 的 Models 页，或 DSH 要求的环境变量）。缺凭据时任务会回 `failed`，并附上 DSH 报的原因。

## 限制

- 「消息」类（非任务）收件只确认，不交给 agent。
- 每个任务新开一个 DSH 会话；同一发件人的连续任务不共享上下文。
- 附件暂不支持。
