# Vendor Adapters（厂商适配层）

> ⚠ **从 v0.9.1 起新增**（agent-node v2.3.9-preview.0+，hotfix [#130](https://github.com/sleep2agi/agent-network/issues/130) 引入）

::: warning ⏳ Interim workaround，非永久方案
**本 adapter 是 interim 补丁，不是 anet 的 vendor-specific lock-in 路线**。Vincent（2026-05-16 telegram 5021）已联系 InternLM 团队推上游修复 —— 等 intern-s2-preview endpoint 默认 emit 标准 Anthropic `tool_use` content blocks 后，这一层 adapter 就**可以下线**。

加这层是为了**立即 unblock** 用户跑 intern + 多 Agent 协作（v0.9.0 promote 前 intern tool calling 完全卡死），不是 anet 愿意长期承担「贴近某家厂商行为」这种维护成本。Upstream coordination 进度见 [§5 Future polish — Upstream coordination status](#future-polish未完成-gap)。
:::

agent-node 的 `claude-agent-sdk` runtime 是 Anthropic Messages API 客户端，**理论上**任何 Anthropic 兼容 endpoint（书生 / DeepSeek / GLM / Kimi / MiniMax / OpenRouter / 自部署 lmdeploy 等）都能跑。但**实际上**各厂商的 RLHF 微调路径不一样，同样的 Anthropic 协议 payload 在不同厂商端会有**行为分歧**：

- MiniMax / Anthropic 官方：tool 调用 out-of-the-box 干净，`stop_reason: "tool_use"`，content blocks 正确
- 书生 intern-s2-preview：接受 `tools` 参数但在 `tool_choice: "auto"` 下默认走「Thinking Process」自由文本，**不发** `tool_use` content blocks；强制 `tool_choice: {type:"tool",name:...}` 又被拒（`-20077 不支持的 tool_choice 值`）

为不让用户被「同样的 prompt 跑 MiniMax 工作，跑书生就废」搞晕，**作为 interim 补丁** agent-node 引入 **vendor adapters**：根据 `ANTHROPIC_BASE_URL` 检测 vendor，prepend 一段定制 system-prompt bias 强制把 RLHF 行为掰回 Anthropic 标准。理想终态：上游厂商 RLHF 修了 → adapter 退役。

---

## 当前 adapters

### intern（书生 InternLM）

**触发条件**：`ANTHROPIC_BASE_URL` 命中 regex `/intern-ai\.org\.cn|chat\.intern-ai/i`（[agent-node/src/cli.ts processWithClaude](https://github.com/sleep2agi/agent-network/commit/4cd0024)）

**注入内容**：在用户 system prompt 之**前** prepend 一段短 bias，要求 model 直接发 `tool_use` content blocks 跳过 verbose thinking process。

**效果对照**（直 curl 验证，详见 [research report](https://github.com/sleep2agi/agent-network/blob/main/docs/research/intern-tool-calling-investigation.md)）：

| 维度 | 无 adapter（agent-node ≤ 2.3.8）| 有 adapter（v2.3.9-preview.0+）|
|---|---|---|
| `stop_reason` | `max_tokens`（自由文本撞顶被截）| `tool_use`（干净停止）|
| `output_tokens` | 1024（拉满）| 122（精炼）|
| `content[1]` | 没有 tool_use block | `{type:"tool_use", name:"commhub_send_task", input:{...}}` ✅ |
| multi-agent 协作 | 经常派不出活，hub 收不到 `send_task` | 派活闭环 |

**Generalises**：detection regex 同时匹配 `intern-ai.org.cn` 和 `chat.intern-ai` 子域，未来 intern-* 系列 endpoint 新增不需要改代码。

---

## ⚠ 副作用（必读）

vendor adapter 是**修复 RLHF 偏差的最小可行方案**，不是免费的。已知 5 项 user-visible 副作用：

### 1. 失去 intern Thinking Process 透明度

bias 让 model **skip thinking 阶段**直接发 tool_use —— intern-s2-preview 一大特色（链式推理可见性）被压平。Debug 时看不到 model 决策推理。

**Migration hint**：想看 thinking 用 `anet node start <alias> --prompt "你的 system prompt"` 自带 system prompt —— **替换** default bias，model 退回到原始 RLHF 行为。

### 2. Detection fragility — URL regex 只匹配 chat.intern-ai.org.cn 系列

regex `/intern-ai\.org\.cn|chat\.intern-ai/i` 是简单字符串匹配，三个边界场景不触发 bias：

- 自部署 lmdeploy + InternLM2.5（base URL = `http://your-server:23333` 之类）
- intern 改用代理（`https://your-proxy.com/intern`）
- 用 aggregator（OpenRouter / 自建 gateway）路由到 intern 模型

这些场景下 bias **不会启动**，tool calling 还是会卡。

**Migration hint**：自部署 / proxy 场景需要手动 `--prompt` 把 bias 内容复制进来。bias 实际内容见 [agent-node 源码 commit 4cd0024](https://github.com/sleep2agi/agent-network/commit/4cd0024)（~10 行）。

### 3. Silent injection — bias 默默 prepend 到 system prompt

bias 是**隐式注入**，用户改 system prompt 时不知道有这层。

**典型 debug 困惑**："我 prompt 写 X，model 表现像 Y，搞不懂为啥不听话" —— 因为实际跑的是 `<bias> + <你写的 X>`。

**Migration hint**：当前 `anet info <alias>` 已 print `tools:` + `flags:` 行（[#101 banner 配套](https://github.com/sleep2agi/agent-network/issues/101)）。未来 polish gap follow-up 计划加 `bias_active: true/false` 行让 bias 状态显式。

### 4. Tool calling 风格强制 — bias "MUST emit tool_use"

bias 的核心指令是「**必须**发 tool_use」。对**多 Agent 协作**（agent 之间互派活）是净正面；对**单 agent 报告生成**（要求 model 写 markdown 总结）就是干扰 —— model 过度倾向调工具而不是输出文本。

**典型 use case 偏移**：你想让 intern agent 写一份周报，但 bias 让它疯狂尝试调 `Read` / `WebFetch` 而不是直接写文本。

**Migration hint**：单 agent 报告任务用 `anet node start <alias> --prompt "你只输出报告，不要调工具"` 自带 system prompt 关闭 default bias。

### 5. Tokens 减输出 = 减 explainability

跟 #1 同根：intern 默认 1024 tokens 撞顶（verbose 推理）→ bias 后 122 tokens clean stop。tool 链干净是好事，但用户看不到 model **为什么**这么决策。

**Migration hint**：未来计划加 verbose 模式（preview gap），日志里 dump model 完整 raw response。当前需要 model thinking 可见性的场景同 #1，用 `--prompt` 退回原始 RLHF。

---

## Opt-out：用 `--prompt` 自带 system prompt

```bash
# 关闭 intern adapter default bias（替换为你自己的 system prompt）
anet node start my-intern-agent --prompt "你是一个谨慎的代码 reviewer，仅在用户明确要求时调工具。"
```

注意：`--prompt` 是**替换**不是**追加** —— vendor adapter bias 不会再被 prepend。如果你既想要 bias 又想加自己的指令，目前需要手动 copy bias 内容到 `--prompt` 里再拼自己的。

也可以在 `.anet/nodes/<alias>/config.json` 的 `prompt` 字段持久化（agent-node `loadProfile` 读取）。

---

## Future polish（未完成 gap）

跟 [#130 工程马 code trace report](https://github.com/sleep2agi/agent-network/blob/main/docs/research/intern-tool-calling-code-trace.md) 列出的 follow-up polish 一致：

- **P1** `anet info <alias>` print `bias_active: true/false` —— 让 silent injection 显式
- **P1** `--no-vendor-bias` flag —— 不替换 system prompt 单纯关掉 bias
- **P2** verbose 模式（`--log-level debug` chain？）—— dump model raw response 含 thinking process
- **P2** 自部署 / proxy 检测 fallback —— detection 不止 URL regex（model 名称 / 启动 banner 探测？）

### Upstream coordination status

| 厂商 | 状态 | 跟进通道 |
|---|---|---|
| InternLM 书生 | 🟡 Vincent 2026-05-16 已联系 intern 团队推上游 fix（让 `tool_choice:auto` 默认 emit 标准 Anthropic `tool_use` content blocks） | 通过 Vincent 私下渠道 |

**Adapter 退役条件**（任一满足即可去掉 vendor adapter 层）：
- intern endpoint 升级后 curl A/B 跑 `tool_choice:auto` 直接 emit `tool_use` block（不需要 system-prompt bias）
- 或：上游同意把 prompt-bias 内嵌到 endpoint server-side，client 端 transparent

**Tracking**：跟进任何 intern team 反馈（新版本 release notes / API change notice）后，在本节加 timeline；adapter 移除会在 changelog 单独发条目，**保留向后兼容**（旧 anet 版本仍带 bias 也能跑，新版可去掉）。

---

## References

- Hotfix commit: [`4cd0024 fix(#130): intern-s2-preview tool calling via system-prompt bias`](https://github.com/sleep2agi/agent-network/commit/4cd0024)
- Issue: [#130 intern tool-calling broken on Anthropic protocol](https://github.com/sleep2agi/agent-network/issues/130)
- SDK 团队 直 curl A/B research（191 行）: [`docs/research/intern-tool-calling-investigation.md`](https://github.com/sleep2agi/agent-network/blob/main/docs/research/intern-tool-calling-investigation.md)
- 工程团队 3-layer code trace（183 行）: [`docs/research/intern-tool-calling-code-trace.md`](https://github.com/sleep2agi/agent-network/blob/main/docs/research/intern-tool-calling-code-trace.md)
- 上下文：[CHANGELOG v0.9.0 Recovery & Observability](/changelog#v0-9-0-recovery-observability) + [Security `工具权限`](/concepts/security#工具权限默认-claude-code-preset-user-responsibility)
