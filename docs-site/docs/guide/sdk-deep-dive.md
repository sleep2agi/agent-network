# SDK Deep-dive：claude-agent-sdk vs codex-sdk

> 给"想自己接新 SDK"或者"想看懂 anet 怎么 wrap SDK"的 contributor。
> 只是想用？看 [节点 Runtime](/guide/runtimes)。

anet 内置多个 Runtime，其中**恰好两个是 SDK adapter**——`claude-agent-sdk` 和 `codex-sdk`——本页只对比这两个。其余都走 spawn 子进程路线，不在本页 SDK adapter 对比范围内：`claude-code-cli` spawn 本机 `claude` 二进制、`grok-build-acp` spawn 本机 `grok` ACP server、`opencode-cli`(preview) spawn 本机 `opencode` CLI、`codex-app-server`(preview) 桥接一个 spawn 出来的 codex app-server。（渠道可用性——正式版 4 种 / 预览版 6 种——见 [runtimes canonical 表](/guide/runtimes#runtime-对比-canonical-表)。）

- `claude-agent-sdk` — `@anthropic-ai/claude-agent-sdk` 官方 SDK，在 [`@sleep2agi/agent-node` 的 regular `dependencies`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/package.json) 里（不是打进 dist；build flag `--external`，npm 安装时作为 sub-dep 自动拉）
- `codex-sdk` — `@openai/codex-sdk` 官方 SDK，列为 **`optionalDependencies`**（npm 7+ 默认会拉，若没拉用户 `npm install -g @openai/codex-sdk` + `@openai/codex` 二进制全局）

两家 SDK 接入语义、能力边界、session 处理、tool 注册、streaming、token 计费、错误处理差别都不小。anet 的 wrapper 用 `processWithClaude()` / `processWithCodex()` 两个分支 + 一个统一的 `think()` 调度器抹平这些差异。本文系统梳理这 11 个维度，并给出"想加 gemini-cli / qwen-code 等新 runtime 应该怎么照葫芦画瓢"的指引。

::: tip 阅读姿势
本文 `agent-node/src/cli.ts:NNN` 行号引用对照 GitHub `main` 校准。agent-node cli.ts 改动频繁，如果你看到行号有偏，去 GitHub 最新 main 对位即可，逻辑分块名（`processWithClaude` / `processWithCodex` / `writebackSession` / `think`）保持稳定。
:::

---

## 11 维度对比表

| 维度 | `claude-agent-sdk` | `codex-sdk` |
|---|---|---|
| **package / 版本** | `@anthropic-ai/claude-agent-sdk` ^0.2.140（regular dep；以 [agent-node/package.json](https://github.com/sleep2agi/agent-network/blob/main/agent-node/package.json) 为准） | `@openai/codex-sdk` ^0.133.0（`optionalDependencies`；同上） |
| **API entry** | `query({ prompt, options })` → `AsyncGenerator<SDKMessage>` | `new Codex({...}).startThread(opts)` / `.resumeThread(id, opts)` → `Thread`；`Thread.run()` / `Thread.runStreamed()` |
| **Session 语义** | `SDKSystemMessage{subtype:'init'}.session_id` 第一帧拿到；resume 用 `Options.resume` 或 `Options.continue`；落盘 `~/.claude/projects/<cwd>/<uuid>.jsonl` | `Thread.id` 首次 turn 启动后才有；resume 用 `codex.resumeThread(id, opts)`；落盘 `~/.codex/sessions/` |
| **Tool 注册** | `tools: string[]` 内置 + `mcpServers: Record<string, McpServerConfig>` 多协议（stdio / http / sse）；可定义 subagent | 工具集**不可剥离**（Codex CLI 内置 Read/Write/Edit/Bash/Grep/Glob/WebSearch 全套）；MCP 通过 Codex CLI 全局 `config.toml` 注入 |
| **Streaming** | `for await (const m of query(...))` —— 边走边推 system/assistant/user/result/hook/status/... 多种 typed message | `for await (const ev of thread.runStreamed(...).events)` —— ThreadEvent：thread.started / turn.started / item.started / item.updated / item.completed / turn.completed / turn.failed / error |
| **Token 计费 / 预算** | `SDKResultMessage` 携带 `usage.input_tokens / output_tokens`、`total_cost_usd`、`num_turns`；`maxTurns` 硬卡 | `TurnCompletedEvent.usage{input_tokens, cached_input_tokens, output_tokens}`；**无** `num_turns`（一次 `runStreamed` 算一 turn）；**无**官方 cost 字段，要自己拿价表算 |
| **错误处理 + 重试** | 抛 `AbortError`（取消）或普通 Error；`result.subtype` ≠ `"success"` 时携带 `error` 字段 | `TurnFailedEvent{error}` 或 `ThreadErrorEvent{message}`；thread 进入坏状态后**整个 thread 重建**（anet wrapper 走 catch 分支重 `startThread` + 单 `run`） |
| **多 turn 行为 + history 限制** | SDK 自己管 conversation history；`Options.maxTurns` 上限；超出走 `result.subtype="error_max_turns"` | Thread 持久化 history 到 `~/.codex/sessions/`；用 `model_auto_compact_token_limit`（anet 设 200000）让 Codex CLI 自动压缩；无 turns 上限概念 |
| **BASE_URL / 等价机制** | `ANTHROPIC_BASE_URL` env（claude-agent-sdk 内部读）+ `ANTHROPIC_AUTH_TOKEN`，可路由到 MiniMax / DeepSeek / GLM / Kimi / 书生 等 Anthropic 兼容端 | `Codex({baseUrl, apiKey})` 构造参数 + `OPENAI_API_KEY` env；理论上可指 Codex 兼容的 provider，但 anet 当前没暴露入口（保留 OpenAI 直连或 `codex login` 走 ChatGPT 订阅） |
| **settingSources / 项目隔离** | `Options.settingSources: SettingSource[]` —— `['user','project','local']` 选哪些层；anet 强制 `[]` 完全隔离宿主机 `~/.claude/` | `CodexOptions.env: Record<string,string>` —— 一旦设了就**不继承** `process.env`；`CodexOptions.config` 等价 `codex --config key=value` 覆盖；anet 现阶段没强隔离（继承 `process.env`） |
| **breaking change cadence** | minor 频繁（0.x），Anthropic 主推 SDK 路线，API 变动期相对快 | 0.x 还在迭代，`ThreadEvent` schema 偶有新 item type，`Codex` 构造签名相对稳定；CLI binary 自身按 `@openai/codex` 节奏升级 |
| **anet wrapper 关键代码位置** | `agent-node/src/cli.ts` `processWithClaude()` 入口约 L388，主循环 L598，session 写回 L603 → [`writebackSession()`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) L217 | `agent-node/src/cli.ts` `processWithCodex()` 入口约 L669，streaming 循环 L714，session 写回 L736 |

---

## 各 SDK 接入注意事项

### claude-agent-sdk

**强项**
- 内置 tool 集合 + MCP 注册都是**结构化字段**，wrapper 想加 commhub MCP 直接 push 到 `options.mcpServers`（cli.ts L513-520）即可
- streaming 是 typed `AsyncGenerator<SDKMessage>`，`for await` 解构清晰
- `SDKResultMessage.total_cost_usd` 内置，cost telemetry 不用自己算
- 完全可禁宿主机 `~/.claude/` 影响（`settingSources: []`）—— 这是 anet 多租户多节点共存的关键

**坑**
- **Linux glibc binary 问题**：SDK 默认装 musl 变体（`@anthropic-ai/claude-agent-sdk-linux-x64-musl`），但 Debian/Ubuntu/RHEL 是 glibc，会报 `Claude Code native binary not found`。anet 在 [cli.ts L396-417](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) 做了 on-the-fly `npm install --no-save @anthropic-ai/claude-agent-sdk-linux-x64`（glibc 包）兜底。
- **root 用户禁用 dangerouslySkipPermissions**：Claude Code 安全策略，root 启动会拒绝 skip-permissions flag，每个 tool call 都卡在人工审批。wrapper 在 [cli.ts L438](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) 早探早返回，提示用非 root 用户或切 `codex-sdk` runtime。
- **MCP type 字段必须 `http` / `sse` / `stdio`**：SDK schema 严格校验，老版本 CLI 接受的 `type: "url"` 在 SDK 里直接 reject（cli.ts L514-516 注释里有踩坑记录）。
- **maxTurns 默认值**：SDK 没默认，anet 强制 `MAX_TURNS=50`（cli.ts L167），原来默认 5 太低，一个 commhub MCP call 就 5 轮没了。

**session 写回机制**

```ts
// cli.ts
for await (const message of query({ prompt, options })) {
  const m = message as any;
  if (m.type === "system" && m.subtype === "init") {
    claudeSessionId = m.session_id;                    // 拿 session id
    writebackSession(m.session_id);                    // 写 config.json
  }
  // ...
}
```

下次 `processWithClaude()` 走到，因为 `claudeSessionId` 还在 module-level 变量里，直接 `options.resume = claudeSessionId`（L582）→ Anthropic 服务端续上同一 session。`writebackSession()`（L217-228）把 id 落到 `.anet/nodes/<alias>/config.json` 的 `session` 字段，进程重启也能续。

### codex-sdk

**强项**
- Thread 抽象更清晰：`thread.run(input)` 返回 `Turn{items, finalResponse, usage}`，单 turn 进出最直觉
- `runStreamed` 的 ThreadEvent schema 用了 discriminated union，TypeScript 解构非常顺
- 工具集"开箱即用"——不需要在 anet wrapper 里维护 allowlist（虽然这也意味着没法剥离）
- `Codex({config: {model_auto_compact_token_limit: 200000}})` 让 long-running thread 自动压缩历史，不用 wrapper 手动 truncate

**坑**
- **要 spawn 全局 `codex` 二进制**：`@openai/codex` 走 `optionalDependencies`（不强制安装），用户必须 `npm install -g @openai/codex` 才能跑；找不到时 wrapper 抛 `@openai/codex-sdk not installed` 明确报错（cli.ts L684）。
- **PATH 注入**：wrapper 早在 [cli.ts L670-677](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) `which codex` 后把目录前置到 `process.env.PATH`，避免子进程 spawn 时找不到。
- **Thread 坏掉后整体重建**：单 turn 报错走 catch 分支重 `codex.startThread()` + `thread.run()`（cli.ts L741-750），意味着原 thread 的 history 在错误后就**断了**。
- **Token 计费要自己算**：`usage` 只给 token 数没给美金。如果要做预算控制，得维护一张 model→price 表。当前 anet **没**实现 codex 侧的 `maxBudgetUsd` 强制。
- **gpt-5.6-sol 当前是 default**（[#697](https://github.com/sleep2agi/agent-network/issues/697)）：默认值已集中管理，create、wake、retry、stdio 与 picker 共用同一口径。MiniMax 等第三方 codex provider 接入计划已记入 RFC 但还没落。

**session 写回机制**

```ts
// cli.ts
const { events } = await codexThread.runStreamed(input);
for await (const ev of events) {
  if (ev.type === "turn.completed") usage = ev.usage;
  // ...
}
if (codexThread?.id) writebackSession(codexThread.id);   // 写 config.json
```

注意：**Thread.id 在第一个 turn 启动之前是 `null`**。所以 wrapper 是 turn 完成后才写回，不像 claude-agent-sdk 那样在 `system/init` 帧拿到。下次进程启动，从 `config.json` 读 `session` 字段，走 `codex.resumeThread(SESSION_ID, opts)`（cli.ts L698）续。

---

## anet wrapper 怎么收敛差异

`agent-node/src/cli.ts` 里这套架构是关键的"两套 SDK 一套调度":

```
                   inbox / SSE / Telegram 进 task
                              ↓
                          think()  ← cli.ts
                              ↓
                  ┌───────────┴───────────┐
                  ↓                       ↓
            processWithClaude        processWithCodex
              (cli.ts)             (cli.ts)
                  ↓                       ↓
              SDK query()         thread.runStreamed()
                  ↓                       ↓
            writebackSession(session_id) ← 统一 cli.ts
                  ↓
                config.json 持久化
                  ↓
            sendReply 回 commhub
```

收敛的几个关键点：

1. **统一调度**：`think()` 是 `Promise` 队列（cli.ts L762-780），保证同一节点同一时刻只跑一个 LLM 调用，避免并发把 commhub MCP / 文件系统打乱。
2. **统一 session 写回**：两个 SDK 各自拿 session/thread id 后都调 [`writebackSession()`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) 落 `.anet/nodes/<alias>/config.json` 同一字段 `session`。RUNTIME 切换时这字段语义不同（claude 是 jsonl UUID，codex 是 thread id），但写入/读取代码完全共用。
3. **统一 task 上下文注入**：`think()` 启动前把 `taskId` 写进 `process.env.CURRENT_TASK_ID`（L768-769），两套 SDK 的 prompt 模板都引这个 env 让 LLM 在 `send_task` 时挂 `parent_task_id`，把回复链路串回上游。
4. **统一错误降级**：`processTask()`（cli.ts L782-829）抓 `text` 后用一个 regex（L803）扫常见 API 错误关键词（`"may not have access"`、`"model not found"`、`"API error"` 等），把"SDK 没抛但内容是错误"也标 failed → Dashboard 显示真实失败而不是假装成功。
5. **统一 commhub MCP 注入**：claude-agent-sdk 走 `options.mcpServers["commhub"] = { type:"http", url, headers }`（cli.ts L513-520）；codex-sdk 走 Codex CLI 的全局 `~/.codex/config.toml`（用户事先配，anet wrapper 不动）。**这是当前最不对称的一处**——RFC issue 已记，未来想统一到"wrapper 注入"。

---

## 加新 Runtime：以 gemini-cli / qwen-code 为例

如果上游 SDK 提供：
- TypeScript 类型 + ESM entry
- 一个能拿到 session/thread id 的 API
- 一个 streaming 接口（AsyncGenerator 或 EventEmitter）

加新 runtime 大致是 5 步，照葫芦画瓢 `processWithCodex()` 那个分支：

### Step 1：声明 runtime 名 + map

```ts
// cli.ts 附近
const RUNTIME_MAP: Record<string, string> = {
  "claude-agent-sdk": "claude", /* ... */
  "codex-sdk": "codex",
  "gemini-cli": "gemini",    // ← 新增
};
const RUNTIME = (RUNTIME_MAP[rawRuntime] || "claude") as "claude" | "codex" | "http" | "gemini";
```

### Step 2：实现 processWithGemini()

参考 `processWithCodex()`（cli.ts L669-692）骨架：

```ts
let geminiSession: any = null;

async function processWithGemini(task: string, from: string): Promise<string> {
  let GeminiSDK: any;
  try { ({ Gemini: GeminiSDK } = await import("@google/gemini-sdk")); }
  catch { throw new Error("@google/gemini-sdk not installed"); }

  if (!geminiSession) {
    const sdk = new GeminiSDK({ apiKey: process.env.GEMINI_API_KEY });
    geminiSession = SESSION_ID
      ? sdk.resumeSession(SESSION_ID, { model: MODEL })
      : sdk.startSession({ model: MODEL });
  }

  const t0 = Date.now();
  const stream = await geminiSession.runStreamed(task);
  let finalText = "";
  for await (const ev of stream.events) {
    if (ev.type === "message.completed") finalText = ev.text || "";
    // 解析其他 event 类型，按需 log/debug
  }
  if (geminiSession?.id) writebackSession(geminiSession.id);
  log(`[gemini] done | ${Date.now() - t0}ms`);
  return finalText || "（无回复）";
}
```

### Step 3：think() 调度分支

```ts
// cli.ts 附近
if (RUNTIME === "gemini") return await processWithGemini(task, from);
```

### Step 4：optionalDependency 声明

`agent-node/package.json` 用 `optionalDependencies` 声明新 SDK（参考 `@openai/codex-sdk` 的写法），避免 npm install 时强拉。

### Step 5：写文档

- 把新 runtime 加到 `docs-site/docs/guide/runtimes.md`（ZH+EN）— 给用户的 how-to
- 把本文 11 维度对比表加一列 — 给 contributor 的差异参考

::: tip 关于 commhub MCP 注入
新 runtime 第一版可以**先不注入 commhub MCP**，让节点只能"被派单"不能"主动派单"。等基础流程跑通了再补 MCP 注入（参照 claude-agent-sdk 的 mcpServers 字段 / codex-sdk 的 `~/.codex/config.toml`）。
:::

---

## 延伸阅读

- [节点 Runtime](/guide/runtimes) — 用户视角的 how-to + cheat sheet
- [Agent Node 配置](/guide/agent-node) — 完整 `config.json` 字段表
- [多模型配置](/guide/multi-model) — 各家国产模型的 ANTHROPIC_BASE_URL 实测端点
- [GitHub: agent-node/src/cli.ts](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) — 本文所有行号引用的源文件
