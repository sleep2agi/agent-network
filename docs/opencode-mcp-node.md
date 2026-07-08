# opencode 以 MCP 接入 agent-network（作为一个节点）

> 2026-07-08 · 已在隔离环境**实测跑通**（opencode-ai 1.17.13 + commhub preview.14），不是猜的。

## 一句话

opencode 支持「远程 MCP server」。把 hub 的 `/mcp` 端点配进 opencode，opencode 就拿到网络的通信工具，能**报状态上线、发任务、查在线、翻 inbox**——即以一个节点身份接进网络。

## 关键区分：出站 vs 入站

| 能力 | 走哪条路 | opencode 纯 MCP 能不能 |
|------|---------|----------------------|
| **出站**：报状态 / 发任务 / 发消息 / 查在线 / 翻 inbox | hub `/mcp`（MCP tools/call，streamable-http） | ✅ 直接能，已实测 |
| **入站实时**：网络派任务主动推给它 | **另一条 SSE 推流**（hub `createSSEStream`/`pushEvent`） | ⚠️ 不能自动收 |

**为什么入站不行**：派工是 hub 通过独立 SSE 长连接**推**给 agent 的，不走 MCP 工具响应。而 opencode 是**回合制**——你不 prompt 它它不动，它不会自己订那条 SSE、也不会「来消息自动醒来响应」。所以纯 MCP 接入 = **能主动往网络说话 + 主动翻自己 inbox**，但不会像常驻 agent 那样自动接派来的活。

要它当**全自动常驻 agent**（派工就自动响应），得用 `agent-node` 那层驱动（订 SSE→来消息重新 prompt opencode→报状态→断线重连）——就是 RFC-029 的 opencode 第 5 runtime。

## 实测配置

**版本注意**：用**新版 opencode-ai（1.x，`$schema: opencode.ai/config.json`）**。本机 `~/.opencode` 那个 0.0.55 是**旧 Go 版**，配置格式不一样，别用。

### 1) 拿一个 node token（ntok）
向 hub 注册一个用户/节点，拿到 `network_token`（ntok_...）：
```bash
curl -sX POST http://<hub>/api/auth/register -H 'content-type: application/json' \
  -d '{"username":"opencode-node","password":"...","email":"..","display_name":"OpenCode"}'
# 返回里取 network_token（ntok_...）+ network_id
```

### 2) opencode.jsonc 加远程 MCP（项目根目录或 ~/.config/opencode/）
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode/deepseek-v4-flash-free",   // 换成你要的模型
  "mcp": {
    "commhub": {
      "type": "remote",
      "url": "http://<hub>:9200/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer ntok_你的token" }
    }
  }
}
```

### 3) 跑
```bash
opencode run "调用 commhub 的 report_status 上线，再 get_all_status 看谁在线"
# 或交互模式 opencode，让它用这些工具
```

## 实测证据（隔离 hub，非生产）

- opencode 启动加载 commhub MCP，模型调 `commhub_get_all_status` → 返回 `{"ok":true,"sessions":[...],"summary":[...]}`；**hub 日志实收** `hub → get_all_status`。
- 调 `commhub_report_status`（**必须带 `resume_id`**，稳定重连 id）→ `{"ok":true,"resume_id":"...","alias":"...","inbox_count":0}`；hub 日志 `<alias> → report_status: idle`。
- 权威确认：hub `/api/status` 里 **该 opencode 节点出现在 sessions 里 = 已上线**。
- ✅ opencode 的远程 MCP 客户端**直接吃 hub 的 streamable-http**，不用加桥（mcp-remote 之类）。

## 网络暴露给 opencode 的通信工具

`send_task` · `send_message` · `get_all_status` · `report_status`（带 resume_id）· `inbox`

## 结论 / 选型

- **轻量（MCP-only，本文）**：opencode 能上线、能往网络推任务/消息、能主动翻 inbox。适合「人驱动的 opencode 顺手接网络」或「只需往网络汇报/派活」的场景。配置就行，已验证。
- **全自动常驻节点**：走 `agent-node` 的 opencode runtime（RFC-029，代码已合 main），它补上 SSE 入站 + 自动重 prompt + 状态/重连循环。这条就是 P4「opencode 活体」，差真 vendor key 端到端烧一遍。

参考：opencode MCP 官方文档 https://opencode.ai/docs/mcp-servers/
