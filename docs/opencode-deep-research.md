# opencode 接入深度研究报告

> 2026-07-09 · 通信龙 · 源码审查 + 隔离 Docker 实测（不碰生产）。

## 结论速览

1. **opencode 接入网络有三条路**，成熟度从高到低：MCP-only（已实测✅）→ native ACP runtime（代码已在 main，本次实测）→ DIY 桥接（第三方已验证可行）。
2. **native opencode-cli runtime 是完整实现**，不是半成品：常驻 `opencode acp` 子进程、会话崩溃恢复、每节点 HOME 隔离、空答复 rescue、vendor key 防外泄。
3. **（待实测结果）keyless 变体**：runtime 不指定模型，模型由 opencode 自己的配置决定 → 用 opencode 免费 zen 模型（无需任何 vendor key）可能可以直接跑通「派工自动响应」端到端。若成立，P4 活体验证不再被 vendor key 卡住。

---

## 1. 三条接入路线

| 路线 | 出站 | 入站(自动接活) | 依赖 | 状态 |
|------|------|--------------|------|------|
| **MCP-only** | ✅ | ❌（只能主动 get_inbox） | 一段 mcp 配置 | ✅ 已实测，公开文档 docs/opencode-mcp-node.md |
| **native ACP runtime**（RFC-029） | ✅ | ✅ | agent-node + opencode(pin 1.17.13) | 代码全在 main，本报告实测 |
| **DIY 桥接** | ✅ | ✅ | 自己写 driver（hub /events SSE → get_inbox → opencode serve HTTP 注入） | 第三方独立验证可行（数据点） |

## 2. native ACP runtime 代码审查（main）

代码位置：`agent-node/src/runtime/opencode-acp/`（runtime.ts 253 行 / client.ts 242 / events.ts 204 + 测试 362 行）+ `agent-node/src/cli.ts` 全 wiring + `agent-network/src/opencode-{preset,pin}.ts`。

**架构**（RFC-029 PR②）：
- **常驻子进程**：首轮 `spawn('opencode', ['acp'])` 一次，后续轮次复用（无冷启动）。ACP = JSON-RPC 2.0 over newline-delimited stdio（与 grok-build-acp 同 framing，实测确认过）。
- **会话持久化 + 崩溃恢复**：ACP sessionId 写回 config.session；子进程崩了下一轮先 `session/load`（成功→对话历史保留），失败→显式 log "session lost on restart" 再 `session/new`，不静默降级。
- **HOME 隔离**（§8 D5）：child 的 `HOME=<节点工作目录>` → 每个节点自己的 opencode 配置/auth/会话缓存，互不污染。
- **#383 rescue**：turn 只有 thinking 没有正文时自动补一次「请给最终答复」，可用 `ANET_DISABLE_383_REPROMPT=1` 关。
- **key 防外泄**：auth.json 路径进了 agent 工具层 denylist（feishu-tool-deny.ts 同族防线）——跑着的 opencode agent 不能 Read 自己的 vendor key。
- **命名**：`opencode-cli`（canonical）/ `opencode`（别名），normalize-runtime.ts 归一。
- **版本 pin**：内置 pin opencode-ai@1.17.13；`anet opencode upgrade-pin <ver>` 换 pin 要过 smoke 才写 override（~/.anet/opencode-pin.json，per-machine）。

**vendor preset**（PR③）：内置 `anthropic`（ANTHROPIC_API_KEY，x-api-key）/ `openai`（OPENAI_API_KEY）两个 preset，key 从 env 读、不 prompt、0600 写入 `<workdir>/.local/share/opencode/auth.json`。Bearer-only vendor（Kimi coding 等）明确是 plugin-track backlog。

**关键发现（本次研究的杠杆点）**：runtime **不指定模型**——ACP session 用 opencode 自己配置里的默认模型。所以节点工作目录写一个 `{"model":"opencode/deepseek-v4-flash-free"}` 的 opencode 配置，**不写任何 auth.json**，理论上整条链路 keyless 可跑（zen 免费模型无需登录）。

## 3. keyless 端到端实测（Docker 隔离）

**Setup**：`node:22-bookworm-slim` + bun + opencode-ai@1.17.13 + commhub-server@0.9.0-preview.14 + agent-node（main 源码）。容器内：隔离 hub :9300（独立 DB）→ 注册 owner → mint ntok（node_name=oc-live）→ 节点 config `{runtime:"opencode-cli"}` + opencode 免费模型配置（**无 vendor key**）→ 起 agent-node → hub 上派 send_task → 断言自动回复。

**结果：✅ 跑通了，全程零 vendor key**。agent 日志证据链（真实输出，非模拟）：

```
[oc-live] SSE connected
[oc-live] ← SSE new_task                                    ← 派工 1 秒内推到
[oc-live] ← [boss] (task/normal) 请直接回复一句话：确认收到端到端测试，并说明你在用什么模型。
[oc-live] → processing [opencode]: …
[oc-live] [opencode-acp] session/new — ses_0bb354f6...       ← 真 ACP 会话
[oc-live] [opencode] turn done | reply=46ch stopReason=end_turn in=7710 out=23   ← 真 token 用量
[oc-live] processTask returned: "确认收到端到端测试任务，当前使用的模型是 `deepseek-v4-flash-free`。"
[oc-live] sending reply to boss (task f67a54b3, status=replied)
```

- **派工→自动回复全程 ~7 秒**，模型自己报了它在用免费模型。
- 节点启动→上线 1 秒（注册 + SSE connected）。
- 任务终态 `replied`，闭环完整：`send_task → SSE 推送 → ACP session → 模型作答 → 自动回复 → 任务闭环`。
- 环境里**没有任何 auth.json / ANTHROPIC_API_KEY / OPENAI_API_KEY**。

## 4. opencode 自带 server（DIY 桥接路线的地基）

`opencode serve`（默认 :4096，TUI 模式也自带）已对官方文档验证存在：`GET /session`、`POST /session/:id/message`、`POST /session/:id/prompt_async`（异步注入）、`POST /tui/append-prompt`+`/tui/submit-prompt`（驱动 TUI）、`GET /event`（opencode 自身 SSE）、`GET /doc`（OpenAPI 3.1）、`OPENCODE_SERVER_PASSWORD` basic auth。DIY driver 链路 = hub `/events/{alias}` 通知 → `get_inbox` 拉正文 → `prompt_async` 注入。已有第三方独立把这条跑通（多 session 管理、断线重连、旧消息去重都趟过）——需求真实性 + 可行性双确认。

## 5. 结论与建议

1. **P4「opencode 活体」的验证不再被 vendor key 卡住**。runtime 不锁模型 → opencode 免费 zen 模型（deepseek-v4-flash-free 等 5 个）keyless 跑通全自动链路。P4 的「活体验证」这一格可以直接判 ✅（本报告即证据）。
2. **vendor key 的定位变了**：从「验证的前置条件」降级为「生产质量选项」——要拿 Claude/GPT 级别的输出质量才需要 key（走已有的 anthropic/openai preset，env 读 key + 0600 auth.json + 防外泄 denylist，全部现成）。什么时候配 key = Vincent 按使用场景定，不再阻塞发版。
3. **选型指引**（更新公开文档用）：
   - 顺手接网络/人驱动 → MCP-only；
   - 常驻数字员工 → native `opencode-cli` runtime（免费模型即可起步，key 是质量升级项）；
   - 特殊宿主（不能常驻 agent-node 的桌面环境）→ DIY 桥接（/events + get_inbox + opencode serve HTTP）。
4. **对 GA 的含义**：opencode runtime 从「代码合了但没活体验证」变成「代码 + keyless 活体验证都有了」。是否把它写进 v2.3.0 GA 的 release notes（作为第 5 runtime 正式亮相）→ Vincent 拍。
5. 遗留小项：harness 首轮暴露 dev-open hub 下 utok `current_network` 为 null、send_task 需显式 `network_id` —— 对生产 admin 无影响（有 current_network），但 CLI/文档可注明。
