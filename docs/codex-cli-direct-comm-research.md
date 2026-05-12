# codex CLI 直接通信能力研究

| 字段 | 内容 |
|---|---|
| 状态 | **research-only 完成** — 不动业务码，仅出方案 |
| 提出 | 2026-05-13 |
| 作者 | 通信SDK马 |
| 任务来源 | Vincent telegram 3871 → 通信龙转单 |
| 关联 | [Phase 1 SDK 升级 baseline](sdk-upgrade-2026-05-12-baseline.md) / [SDK-VERSION-DRIFT-MEMO](https://github.com/sleep2agi/agent-network/blob/main/docs/sdk-upgrade-2026-05-12-baseline.md) R39 已分析 `codex --config` inline 注入 |

## 摘要

**TL;DR**：**codex CLI v0.128.0 完全支持 MCP server 注入**（命令行 + TOML config + spawn-as-server）。**anet 当前缺 `codex-code-cli` runtime 来利用这能力**。可用 ~50 行代码在 `agent-network/bin/cli.ts` 加 `codex-code-cli` runtime 类比 `claude-code-cli` 实现，让 codex CLI 直接接 commhub MCP 跟其他 agent 通信。

## 1. codex CLI MCP 注入能力（v0.128.0 实测）

### `codex mcp` 子命令家族

```
codex mcp list           # 列出当前注册 MCP servers
codex mcp get <name>     # 看具体 server 配置
codex mcp add <name> ...  # 注册 MCP server
codex mcp remove <name>  # 卸载
codex mcp login / logout  # OAuth flow (for hosted MCP servers)
```

### `codex mcp add` 两种 transport

**1. Streamable HTTP MCP**（远程，anet commhub 用这条）：

```bash
codex mcp add commhub \
  --url http://127.0.0.1:9200/mcp \
  --bearer-token-env-var COMMHUB_TOKEN
```

**2. Stdio MCP**（本地 spawn 子进程）：

```bash
codex mcp add my-tool -- /usr/local/bin/my-mcp-server --flag value
codex mcp add my-tool --env FOO=bar -- /path/to/bin
```

### `codex --config` inline 注入（不污染磁盘 config.toml）

```bash
codex exec --config 'mcp_servers.commhub.url="http://127.0.0.1:9200/mcp"' \
           --config 'mcp_servers.commhub.bearer_token_env_var="COMMHUB_TOKEN"' \
           "你的 prompt"
```

适合 wrapper 程序按 session 注入（同 R39 给 codex-sdk 提的方案，CLI 直跑版）。

### `codex mcp-server` — codex 作 MCP server

```
codex mcp-server [OPTIONS]  # Start Codex as an MCP server (stdio)
```

让 codex **暴露**为 MCP server 让 Claude Code 或其他 host 调用。**反向能力，本研究不重点**（重点是 codex 作 client）。

### `~/.codex/config.toml` 的 MCP servers TOML 格式

```toml
[mcp_servers.commhub-proxy]
command = "bun"
args = ["/path/to/proxy.ts"]

[mcp_servers.commhub-proxy.env]
COMMHUB_ALIAS = "my-agent"
COMMHUB_URL = "http://127.0.0.1:9200"

# 可选：per-tool approval policy
[mcp_servers.commhub-proxy.tools.get_task]
approval_mode = "approve"

# 或 HTTP transport:
[mcp_servers.commhub]
url = "http://127.0.0.1:9200/mcp"
bearer_token_env_var = "COMMHUB_TOKEN"
```

---

## 2. v0.128 版本 MCP 成熟度

`codex mcp` 子命令家族（list/get/add/remove/login/logout）+ `mcp-server` + `--config` inline + TOML config 全套都在 v0.128。MCP 支持已经**生产级成熟**，不是实验性功能。

OpenAI codex MCP support 已落地多个 minor 版本（具体起始版本未细查，但 v0.128 已 stable）。

---

## 3. anet 现状：**没有 `codex-code-cli` runtime**

### RuntimeName 定义（`agent-network/bin/cli.ts:133`）

```ts
type RuntimeName = \"claude-code-cli\" | \"codex-sdk\" | \"claude-agent-sdk\" | \"http-api\";
```

**4 个 runtime，没 `codex-code-cli`**。

### claude-code-cli runtime 实现（参考模板，`bin/cli.ts:1640-1680`）

```ts
const claudeArgs: string[] = [];
if (profile.flags.dangerouslySkipPermissions) claudeArgs.push(\"--dangerously-skip-permissions\");
for (const ch of profile.channels) {
  if (ch.startsWith(\"server:\")) claudeArgs.push(\"--dangerously-load-development-channels\", ch);
  else if (ch === \"telegram\") claudeArgs.push(\"--channels\", \"plugin:telegram@claude-plugins-official\");
  else claudeArgs.push(\"--channels\", ch);
}
// session 续接 / --session-id / --resume 逻辑
claudeArgs.push(\"-n\", displayName);
const child = spawn(\"claude\", claudeArgs, { env, stdio: \"inherit\", shell: true });
```

anet 把 commhub MCP 注入到 claude CLI 是**通过 `--channels` 加自定义 channel 名 → claude 内部 `.mcp.json` mechanism**（plugin 体系）。

### Vincent 自己已经在尝试（半成品）

Vincent 的 `~/.codex/config.toml` 里有：

```toml
[mcp_servers.commhub-proxy]
command = \"bun\"
args = [\"/home/vansin/agent-orchestra/proxy/commhub-proxy.ts\"]

[mcp_servers.commhub-proxy.env]
COMMHUB_ALIAS = \"codex-硅谷\"
COMMHUB_URL = \"http://127.0.0.1:9200\"
```

但**该 proxy 文件 `agent-orchestra/proxy/commhub-proxy.ts` 不存在**（grep find 返回空）。这是 stale config — Vincent 早期尝试但没完成 / 后续删了。

**结论**：用户侧（Vincent）已经在手动试，但没产品化。anet CLI 不暴露 `codex-code-cli` runtime 让所有用户都能用。

---

## 4. POC 设计：给 anet 加 `codex-code-cli` runtime

### 4.1 RuntimeName 扩展

```diff
- type RuntimeName = \"claude-code-cli\" | \"codex-sdk\" | \"claude-agent-sdk\" | \"http-api\";
+ type RuntimeName = \"claude-code-cli\" | \"codex-code-cli\" | \"codex-sdk\" | \"claude-agent-sdk\" | \"http-api\";
```

### 4.2 normalizeRuntime 加分支

```diff
function normalizeRuntime(profileOrRuntime?: Profile | string): RuntimeName {
  if (typeof profileOrRuntime === \"string\") {
+   if (profileOrRuntime === \"codex-code-cli\" || profileOrRuntime === \"codex-cli\") return \"codex-code-cli\";
    if (profileOrRuntime === \"codex\" || profileOrRuntime === \"codex-sdk\") return \"codex-sdk\";
    // ... rest unchanged
  }
}
```

### 4.3 spawn codex CLI 路径（类比 claude-code-cli）

新增 1640 行附近的 \"spawn claude CLI\" 之后一段 \"spawn codex CLI\"：

```ts
// 新增：spawn codex CLI runtime
if (runtime === \"codex-code-cli\") {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COMMHUB_ALIAS: profile.alias,
    ...(token ? { COMMHUB_TOKEN: token } : {}),
  };
  for (const [k, v] of Object.entries(profile.env)) {
    env[k] = v.replace(/^~/, home);
  }

  const codexArgs: string[] = [\"exec\"];

  // inline 注入 commhub MCP — 不污染 ~/.codex/config.toml
  codexArgs.push(\"--config\", \`mcp_servers.commhub.url=\"\${commhubUrl}/mcp\"\`);
  codexArgs.push(\"--config\", \`mcp_servers.commhub.bearer_token_env_var=\"COMMHUB_TOKEN\"\`);

  // 沙箱 / 危险模式 flag
  if (profile.flags.dangerouslyBypass) {
    codexArgs.push(\"--dangerously-bypass-approvals-and-sandbox\");
  }

  // 隔离 host 用户 codex config（per R8 SaaS 沙箱化建议）
  codexArgs.push(\"--ignore-user-config\", \"--ignore-rules\");

  // session 续接（codex resume）
  if (profile.session) {
    codexArgs.push(\"resume\", profile.session);
  }

  const child = spawn(\"codex\", codexArgs, { env, stdio: \"inherit\", shell: true });
  // ... pid file / exit handler 同 claude 路径
}
```

### 4.4 anet setup 加 codex-code-cli 选项

```diff
  const runtimeSelections = await checkbox<RuntimeName>({
    message: \"你需要哪些 runtime？\",
    choices: [
      { name: \`claude-code-cli — Claude Code CLI\${...}\`, value: \"claude-code-cli\" },
+     { name: \`codex-code-cli — Codex CLI (实验性) \${isInstalled(versions.codex) ? \"（已就绪 ✅）\" : \"（需安装 codex CLI）\"}\`, value: \"codex-code-cli\" },
      { name: \`claude-agent-sdk — Claude Agent SDK\`, value: \"claude-agent-sdk\" },
      { name: \`codex-sdk — Codex SDK\`, value: \"codex-sdk\" },
    ],
  });
```

### 4.5 minimal POC 命令

用户体验：

```bash
# 安装 codex CLI（必备）
npm install -g @openai/codex

# 用 anet setup 配置 codex-code-cli runtime
anet setup
# 选 codex-code-cli

anet node create my-codex --runtime codex-code-cli
anet node start my-codex

# 节点启动后 codex CLI 自动接 commhub MCP
# 直接在 codex TUI 内可用 commhub tools:
#   send_task / get_inbox / get_all_status / etc
# Codex 跟其他 agent 直接通信 ✅
```

### 4.6 实施量级估算

- `bin/cli.ts` 改动：~50-80 行
- 新 spawn 分支 + RuntimeName + normalizeRuntime + setup UI
- 不动 agent-node / commhub-server
- 风险：低（独立新 runtime，不影响现有 4 个）

---

## 5. 跟 claude-code-cli runtime 对照

| 维度 | claude-code-cli | codex-code-cli（提议） |
|---|---|---|
| Binary | `claude` (npm @anthropic-ai/claude-code) | `codex` (npm @openai/codex) |
| MCP 注入机制 | `--channels` flag + claude plugin 体系 | `--config 'mcp_servers.X.url=Y'` 或 `codex mcp add` |
| Session 续接 | `--session-id` / `--resume` (uuid) | `codex resume <id>` (codex session UUID) |
| 沙箱 | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |
| host config 隔离 | claude CLI 自身管理 | `--ignore-user-config` + `--ignore-rules` |
| Telegram channel | `--channels plugin:telegram@...` | codex 暂无 channel 体系（仅 MCP 接入）|

---

## 6. Roadmap / 建议

### 优先级

**Medium-high**：
1. codex CLI 用户基数大（Vincent 已经在用），加 anet 接入入口能让所有 anet 用户都用上
2. 跟 claude-code-cli 对称（用户从 \"我的 claude/codex 订阅\" 来选 runtime 更自然）
3. 不需要重构现有架构，独立加分支

**实施时机**：
- 单独 RFC（候选 RFC-006）+ 单独 PR
- 不阻塞 SDK 升级 Phase 3 / RFC-003 telemetry / SaaS Skills mode 等其他议题
- 等 Vincent 排期

### 不建议优先做的子工作

- ❌ 不要先做 commhub-proxy.ts bridge（Vincent stale config 暗示的方向）：HTTP MCP transport（commhub-server 直接支持）比 stdio proxy 更简单稳健
- ❌ 不要等 OpenAI 加更多功能（v0.128 MCP support 已足够）

### 风险点

1. **codex 升级节奏**：codex CLI 0.128 → 0.130 12 minor 我们已验证 SDK 冻结，但 CLI 二进制可能 break flag。`codex --config` flag 出现于 0.x 哪个版本？需要 verify minimum codex CLI version。
2. **codex session 续接** semantics 跟 claude 不同（codex 是 thread.id，claude 是 session UUID）。POC 实施时需对齐
3. **commhub auth**：`--bearer-token-env-var COMMHUB_TOKEN` 假设 commhub 接受 Bearer，本研究没验证 commhub-server `WebStandardStreamableHTTPServerTransport` 是否要求特定 header 格式。Phase 实施时需 sanity check

---

## 7. 跟 SDK 升级 Phase 3 + RFC-003 的关系

| 议题 | 跟本研究关系 |
|---|---|
| SDK 升级 Phase 3 codex-sdk 0.118→0.130 | 不冲突（不同维度：CLI vs SDK）|
| RFC-003 节点遥测层 | 共享 — codex-code-cli runtime 也会享受 RFC-003 progress events |
| SaaS skills mode | 不影响（SaaS 主要用 SDK runtime，CLI 是 dev/user 体验维度）|
| Vincent 个人 codex-硅谷 config | 本研究可作为产品化路径 — Vincent 不用再维护私人 proxy |

---

## 8. 输出建议

按 telegram 3871 \"research-only 不动业务码\" 守住：

- ✅ 本 doc 落地 `docs/codex-cli-direct-comm-research.md` 后 push main
- ❌ 不在本 round 改 `bin/cli.ts` 加 codex-code-cli runtime
- ❌ 不发 npm
- ✅ 等 Vincent / 通信龙 review + 决策：
  - **A. 加 codex-code-cli runtime**（独立 RFC-006 + 实施 PR）
  - **B. 不加，让用户自己配 codex MCP**（保留现状）
  - **C. 先文档化教用户怎么自配 codex CLI + commhub**（轻量妥协方案）

---

## 状态变更

- 2026-05-13 codex CLI MCP 直接通信能力研究完成（通信SDK马）。等 Vincent / 通信龙 review + 决策路径 A/B/C。
