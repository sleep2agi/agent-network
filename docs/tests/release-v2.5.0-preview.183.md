# agent-node 2.5.0-preview.183

Since `.182`: **节点上报 OpenCode V2 的 agent 列表与当前会话 agent**，给客户端的 Build/agent 控件提供真实数据源。

## Why

客户端参考 UI 里有一个 Build/agent 下拉，但此前**没有任何数据源**：Hub 上没有字段，节点也不读。
要么不做，要么只能编一个假的 `build` 选项 —— 后者被明确禁止。

## What changed

```text
runtime/opencode-v2-catalog.ts
  · readOpenCodeAgents()        GET /api/agent  → 公开 agent id 列表
  · readOpenCodeSessionAgent()  GET /api/session/<绑定 ses_>  → session.agent
    （与 catalog 相同的护栏：仅 loopback、ASCII 目录、2MB/2万行、只保留公开标识；
      空数组合法；非法/缺失一律 undefined，绝不猜默认值）

cli.ts
  · config_snapshot 增加 opencode_agents / opencode_agents_seen_at / opencode_agent_current
  · 读失败沿用上一次成功的列表，不会把已有值抹成空
```

Hub 侧（同一轮已上线）：`report_status` 接收这三个字段，并在 `GET /api/nodes` 投影出来
（`[]` = 确实没有 agent；`null` = 该节点还没上报）。

## 现场验证（不是夹具）

对一台真实的 OpenCode V2 节点读取：

```text
agents  = ["build","general","explore","compaction","title","summary","plan"]
current = {"agent":"build","sessionId":"ses_e9e6b72…"}
oses_fake → undefined（非法 id 不被当成会话）
```

注意：`GET /api/agent` 必须带 `x-opencode-directory` 头，否则服务会返回合法的空列表 ——
这是最初误判「没有 agent」的原因。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.183
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.183
```

重启节点后开始上报；客户端只有在字段非空时才显示 Build 控件，为空/缺失时完全不显示。

## What it does not do

- 不做切换：`PATCH /api/session/<id> {"agent":…}` 虽返回 204，但**未验证真实状态变更**，
  客户端保持只读，切换要等 Hub 中继与读回验证完成
- 不猜测默认 agent，不用列表首项冒充当前值
- 不动模型目录（`opencode_catalog`）的既有口径
