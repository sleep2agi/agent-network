# agent-node 2.5.0-preview.184

Since `.183`: **在真机上打通 OpenCode V2 的 agent（Build）热切换，并把它作为能力位上报**。

## Why

`.183` 只上报了 agent 列表与当前值。切换此前被判定为「做不到」，原因是测错了端点：

```text
PATCH /api/session/{id} {"agent":"plan"}  -> 204，但 GET 回读不变
  （该端点只接受 title/metadata/permissions，additionalProperties:false ⇒ agent 被静默丢掉）

POST  /api/session/{id}/agent {"agent":"plan"} -> 204，GET 回读 agent="plan"  ✅
```

⇒ **204 不是证据**；判定必须「schema 接受 + 回读一致」。

## What changed

```text
runtime/opencode-copresence/v2-session.ts
  · selectedSessionAgent()  读绑定会话的 agent（scope 校验，读不到 undefined）
  · selectSessionAgent()    POST /agent 后**回读校验**，不一致返回 unknown 而不是成功
                            scope/并发直接拒绝；409 ⇒ busy

runtime/opencode-copresence/agent-config-apply.ts（新）
  · applyAgentConfig(): 只走 live session；null 拒绝（服务端没有「清除 agent」）；
    **不回退重启**（重启会重开旧 agent，看起来成功实则没变）

runtime/config-apply.ts
  · ConfigPatch.agent（hot-only，不得与 flags/channels 同补丁）

cli.ts
  · agent 补丁走独立 hot 分支（与 modelVariant 同形），ack applied/rejected/timeout
  · config_snapshot 增加 opencode_agent_config_capable（只有真能切的进程才置 true）
```

Hub 侧（同一轮已合并）：`update_node_config` 接受 `agent` 但**要求**该能力位，缺则 `agent_unsupported`；
`GET /api/nodes/:id/config` 投影 `agent` / `agents` / 能力位。

## 现场验证（真机，非夹具）

```text
POST /api/session/<ses_>/agent {"agent":"general"} -> 204
GET  /api/session/<ses_>                           -> agent == "general"
```

单测：`agent-config-apply` 7/7（含「同一 agent 不重复写」「null 拒绝」「写失败不得报成功」）、
`config-apply` 114/114。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.184
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.184
```

⚠️ 与 `agent-network` 是**精确配对**：CLI 的配对常量必须先指到 `.184`（随 `2.3.0-preview.218` 发布），
否则 `anet node start` 会拒绝启动。顺序：先 node，再 CLI，再重启节点。

## What it does not do

- 不猜测默认 agent；读不到就是未知
- 不做「清除 agent」——服务端没有该操作
- 不改变模型/思考档位（`modelVariant`）的既有口径
