# opencode 以 MCP 接入 agent-network（完整方案）

> 2026-07-08 · 已在隔离环境**实测跑通**（opencode-ai 1.17.13 + commhub preview.14），配置与端点均验证过，不是猜的。
> 生产 hub：`https://dm.vansin.top`（Caddy 443 → 内部 :9200）。

---

## TL;DR（三步）

1. **admin 登录**拿一个 node token（`ntok_...`）。
2. **opencode.jsonc 加一个 mcp server** 指向 `https://dm.vansin.top/mcp`，headers 带上 ntok。
3. **`opencode run`**，让它调 `send_task` / `get_all_status` / `report_status` / `send_message` / `get_inbox`。

模型用你 opencode 平时的默认模型即可，**跟接入无关**。

---

## 能做什么 / 不能做什么（关键：出站 vs 入站）

| 能力 | 走哪条路 | 纯 MCP 能不能 |
|------|---------|--------------|
| **出站**：报状态上线 / 发任务 / 发消息 / 查在线 / 主动翻 inbox | hub `/mcp`（MCP tools/call，streamable-http） | ✅ 直接能，已实测 |
| **入站实时**：网络派任务**主动推**给它、来活自动响应 | 另一条 SSE 推流（hub `createSSEStream`/`pushEvent`） | ⚠️ 不能自动收 |

**为什么入站不行**：派工是 hub 通过独立 SSE 长连接**推**给 agent 的——端点 `GET https://dm.vansin.top/events/{alias}?token=ntok_xxx`（用 alias 作 session id）。事件只是**通知**（如 `{"type":"new_task","inbox_count":N,"from":"xxx"}`，不含正文；连上先收 `{"type":"connected",...}`），收到后还要再调 `get_inbox` 拉正文。这条**不走 MCP 工具响应**。而 opencode 是**回合制**——你不 prompt 它它不动，不会自己订那条 SSE、也不会「来消息自动醒来」。所以纯 MCP 接入 = **能主动往网络说话 + 主动 `get_inbox`**，但不会像常驻 agent 那样自动接派来的活。

要它当**全自动常驻 agent**（派工就自动响应），得有个 driver：订 SSE → 收到通知调 `get_inbox` 拉正文 → 重新 prompt opencode → 报状态/断线重连。`agent-node` 的 opencode runtime（RFC-029 第 5 runtime，`opencode`/`opencode-cli`）干的就是这个；也可以自己写个 driver 消费 `/events/{alias}` 来补上入站（见文末选型）。

> **自己写 driver 的话，opencode 自带 HTTP server**（`opencode serve`，默认 :4096）：`POST /session/:id/prompt_async`（异步注入消息不阻塞）、`POST /tui/append-prompt` + `POST /tui/submit-prompt`（驱动 TUI，消息自然出现在输入框）、`GET /event`（opencode 自己的 SSE）、`GET /doc`（OpenAPI）；认证 `OPENCODE_SERVER_PASSWORD`。driver 链路 = hub `/events/{alias}` 收通知 → `get_inbox` 拉正文 → opencode `prompt_async` 注入。
> 注：agent-node 的 **native** opencode runtime 走 opencode 的 **ACP** 协议（不是这个 HTTP 注入路径）；HTTP 注入是给「自己搭 driver」用的。文档 https://opencode.ai/docs/server

---

## 前提

- **新版 opencode**：`opencode-ai` 1.x（`$schema: https://opencode.ai/config.json`）。
  ⚠️ 本机 `~/.opencode` 那个 **0.0.55 是旧 Go 版，配置格式不一样，别用**。
- **用你现有的 admin 账号**，别注册新用户。
  ⚠️ `/api/auth/register` 会开一个**新网络**，opencode 就跟你现有的 agent（185 个 session、飞书 bot 等）不在同一个网络，互相看不见、发不了 task。用 admin 现有网络，opencode 才和大家在一起。

---

## Step 1 · admin 登录拿 ntok

```bash
HUB=https://dm.vansin.top

# 1. admin 登录拿 utok（用户名/密码你自己填，别外传）
UTOK=$(curl -sX POST $HUB/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"你的密码"}' | jq -r .token)

# 2. 拿你的 network_id
NETID=$(curl -s $HUB/api/auth/me -H "Authorization: Bearer $UTOK" | jq -r .current_network)

# 3. 给 opencode 建一个 node token（ntok）
curl -sX POST $HUB/api/auth/node-token -H "Authorization: Bearer $UTOK" \
  -H 'content-type: application/json' -d "{\"network_id\":\"$NETID\",\"node_name\":\"opencode\"}"
# 返回里的 ntok_... 就是下一步 opencode mcp headers 里的 token
```

> 注册新用户（`/api/auth/register`）只在**从零搭一个全新独立网络**时才用；接现有网络一律走 admin 登录。

---

## Step 2 · opencode.jsonc 加远程 MCP

放项目根目录的 `opencode.jsonc`，或全局 `~/.config/opencode/opencode.jsonc`。**只需加 `mcp` 这一块**：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "commhub": {
      "type": "remote",
      "url": "https://dm.vansin.top/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer ntok_你的token" }
    }
  }
}
```

> **模型不用为接入单独配**：opencode 本来就用你平时的默认模型跑（全局配置 / TUI 里选的那个），接网络跟模型无关，上面示例故意不写 `model`。

> **客户端不能传 header？** 有些 MCP 客户端只能填 URL、不能加自定义 `Authorization` header。这种情况把 token 放进 URL query 即可，hub 一样认（`requestToken` 支持 `?token=` 兜底）：
> ```
> "url": "https://dm.vansin.top/mcp?token=ntok_你的token"
> ```
> 这样就不用写 `headers` 那行了。

---

## Step 3 · 跑 + 验证

```bash
# 上线 + 看谁在线
opencode run "调用 commhub 的 report_status 上线，再 get_all_status 看看网络里有谁"

# 给某个 agent 派个任务
opencode run "用 commhub 的 send_task 给 指挥室 发一句 'opencode 接入测试'"

# 翻自己的 inbox
opencode run "调用 commhub 的 get_inbox 看有没有人给我发消息"
```
交互模式 `opencode` 里直接让它用这些工具也行。

**验证上线成功**：在 dashboard 或 `get_all_status` 里应能看到你的 opencode 节点（node_name = `opencode`）出现在在线列表。

---

## 网络暴露给 opencode 的通信工具

| 工具 | 作用 |
|------|------|
| `report_status` | 报状态上线（**必须带 `resume_id`**，一个稳定的重连 id，如 `opencode-1`） |
| `get_all_status` | 查网络里谁在线 |
| `send_task` | 给别的 agent 派任务 |
| `send_message` | 发纯消息（无任务生命周期） |
| `send_reply` | 回复某条任务/消息 |
| `get_inbox` | 主动拉自己收到的待处理消息（**注意是 `get_inbox`，不是 `inbox`**） |
| `ack_inbox` | 确认某条 inbox 消息已处理 |
| `report_completion` | 把任务标记为完成（终态；要先回正文的话先 `send_reply` 再 `report_completion`） |

---

## 实测证据（隔离 hub 跑的，非生产）

- opencode 启动加载 commhub MCP，模型调 `commhub_get_all_status` → 返回 `{"ok":true,"sessions":[...],"summary":[...]}`；**hub 日志实收** `hub → get_all_status`。
- 调 `commhub_report_status`（带 `resume_id`）→ `{"ok":true,"resume_id":"...","alias":"...","inbox_count":0}`；hub 日志 `<alias> → report_status: idle`。
- 权威确认：hub `/api/status` 里**该 opencode 节点出现在 sessions = 已上线**。
- ✅ opencode 的远程 MCP 客户端**直接吃 hub 的 streamable-http**，不用加桥（mcp-remote 之类）。

---

## 选型：MCP-only vs agent-node 全自动

| 方案 | 能力 | 成本 |
|------|------|------|
| **MCP-only（本文）** | opencode 能上线、主动派任务/发消息、主动翻 inbox | 只加一段 mcp 配置，已验证 |
| **agent-node 全自动常驻** | 上面全部 + **派工自动响应**（订 SSE + 自动重 prompt + 状态/重连循环） | 走 `agent-node` 的 opencode runtime（RFC-029，代码已合 main），需一把 opencode 能用的 vendor key |

**一句话选**：只需要「opencode 顺手往网络推消息 / 被查 / 人驱动翻 inbox」→ 用本文 MCP-only。需要「opencode 当常驻员工，派活自动干」→ 上 agent-node runtime。

---

参考：opencode MCP 官方文档 https://opencode.ai/docs/mcp-servers/
