# 更新日志

::: info 版本号体系说明
本日志按时间倒序排列，**版本号经历过一次重新规划**：
- **2026-05 起**：采用 v0.6 → v0.7 → v0.8 → v0.9 → v0.10 → v0.11 渐进发布，`v0.X.Y` 格式对齐 `commhub-server` 的 `0.X.Y` semver 风格
- **2026-04 之前**：曾使用 `v1.0.0-preview.N` / `v2.1` 等过度承诺型版本号，已废弃
- **当前 stable**：npm `latest` tag（按 [版本号体系](/guide/versioning) 查 npm latest 即为权威）；v0.8.1 是 Apache 2.0 OSS 首发版本
- **当前 preview**：v0.11-preview2（见下方第一条；通过 npm `@preview` tag 发布；尚未 promote 到 `@latest`）
- 旧版历史保留作 git blame 完整性，详见下方 v1.0.0-preview / v2.1 / v0.x 段落
:::

## v0.11-preview2 — **`/loop` 全 runtime 通 + 安全批 + RFC-024 hub config-apply foundation**（2026-06-28）🟡 preview

**版本同步**（npm `@preview` tag, 三包齐发）：
- `@sleep2agi/agent-network@2.3.0-preview.1` ← bumped (CLI: 加 `anet node loop` 子命令)
- `@sleep2agi/agent-node@2.5.0-preview.1` ← bumped (runtime: /loop 全 runtime 通)
- `@sleep2agi/commhub-server@0.9.0-preview.1` ← bumped (hub: 安全批 + RFC-024 PR A)

`PINNED_SERVER_VERSION` 同步到 `0.9.0-preview.1`，`anet hub start` 自动 lazy-fetch 匹配 hub 二进制。

### 🌟 Highlights

#### `/loop` 现在所有 runtime 都能跑

preview2 之前 `/loop` 自调度只在 `claude-code-cli` runtime 工作；agent-node 驱动的 runtime（`claude-agent-sdk` / `codex-sdk` / `grok-build-acp`）会**静默跳过** goal tick。preview2 拿掉那个 runtime-bucket skip，每个 runtime 都能把 `/loop` 任务端到端跑完。

加：**新 `anet node loop` CLI**，从节点外管理 goals — set / list / cancel 一个节点正在跑的 `/loop` jobs，不用进交互 session。

```bash
anet node loop my-codex "监控 PR #271 进展" --every 5m
anet node loop researcher "扫一遍 twitter 上 grok 的最新进展" --every 30m
anet node loop daily-bot "发布今日早报" --every 2h
```

完整用法 + 触发机制见 [Agent Node — 循环任务](/guide/agent-node#循环任务-loop-调度器)（ZH + EN parity）。

### 🔒 安全批

公网 hub 多用户 / 多 network 部署的 4 个 cross-tenant / data-integrity gap 修了：

- **cross-tenant 写防护带**（[#287](https://github.com/sleep2agi/agent-network/issues/287)，RFC-024 PR A）：4 个新 MCP tool（`update_node_config` / `get_config_update` / `ack_config_update` / `restart_node`）每个写操作都 gate `node.network_id == caller.effectiveNetId`，对齐 [#275](https://github.com/sleep2agi/agent-network/issues/275) 模式。`report_status` upsert 不再让节点 row 跨 network 漂移。SQL 层信任根用 `upsertNodeWithSec1Guard` helper 保护 + 5 个 real-driver regression + 6 个 inline-mirror 回归
- **`retention sweep` + incremental VACUUM**（[#282](https://github.com/sleep2agi/agent-network/issues/282)）：hub 后台周期性 sweep 旧 task / inbox row，`agent_telemetry` index 拆开防 READ write-amp。多租户部署 CPU 更稳
- **read-path stale-marker 修**（[#283](https://github.com/sleep2agi/agent-network/issues/283)）：sessions stale-mark 从 read path 挪到单一后台 sweeper，`/api/status` 不再 write-amp
- **password KDF 强化**（[#285](https://github.com/sleep2agi/agent-network/issues/285)）：scrypt 参数升 verified-modern, 向后兼容（老 hash 仍可 verify, 新 hash 用强参数）

### Engineering hardening

- **`superviseChild()` 共用 helper**（[#284](https://github.com/sleep2agi/agent-network/issues/284)）：`connectFeishu` + `connectSSE` 的 supervisor 逻辑（while-loop 重生 + jittered backoff + stable-uptime reset + shutdown gate + abandon-after-timeout）抽到一个 helper。同期加 2 个 connectSSE 改进：±25% jitter 防 hub 重启 thundering-herd / backoff 不在裸 HTTP 200 重置 (只认 SSE `"connected"` 事件)，修热 ~1s 重连循环
- **RFC-024 hub config-apply foundation**（[#287](https://github.com/sleep2agi/agent-network/issues/287)）：4 MCP tool + schema (`nodes.config_revision` / `nodes.config_snapshot` / `node_config_updates` table) 在 preview2 落地。Dashboard 改配置真生效是消费侧 (PR B + PR C)，跟在 preview2.x / preview3 后续 land

### 不在 preview2 里

- RFC-024 PR B（agent-node config-apply runtime + W1 supervisor）— 独立 [PR #290](https://github.com/sleep2agi/agent-network/pull/290)，依赖 PR A (在 preview2 里)。排 preview2.x / preview3
- Dashboard 改配置真生效 end-to-end — PR C 是 sleep2agi/agent-network-dashboard 里 1 行 const swap，PR B merge 后跟进

### 安装 / 升级

**Clean install (新用户)**：
```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.1
npm install -g @sleep2agi/agent-node@2.5.0-preview.1
npm install -g @sleep2agi/commhub-server@0.9.0-preview.1
```

**升级 (现有用户跟 preview channel)**：
```bash
anet upgrade --channel preview
```

升级后重启正在跑的节点接新版：
```bash
anet node stop <alias>
anet node start <alias>
```

详细 upgrade 流程 + 跨版本迁移 → [升级指南](/guide/upgrade)。

---

## v0.10.13 — **grok-build-acp `session/prompt` 300s timeout 卡死修复（P0 hotfix）**（2026-06-08）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-node@2.4.9` ← bumped（[#210](https://github.com/sleep2agi/agent-network/issues/210) / #204 runtime — ACP `handleServerRequest` 非整数错误码 coerce 修复）
- `@sleep2agi/agent-network@2.2.10` ← unchanged
- `@sleep2agi/commhub-server@0.8.4` ← unchanged（PINNED）

### 🌟 Highlights

#### `grok-build-acp` 节点 hang 至 `session/prompt timed out after 300000ms` 根因 + 修复

**症状**：`grok-build-acp` runtime 节点接到第二个 task 后 hang ≈5 min，最终 agent-node 报 `grok ACP request 'session/prompt' timed out after 300000ms` —— ai-insight 用户 `A站Grok`（grok 0.2.29 alpha）2026-06-07 19:53:09 抓到的精确日志：

```text
ERROR failed to parse incoming message: invalid type: string 'ENOENT',
expected i32 at line 1 column 48.
Raw: {'jsonrpc':'2.0','id':5,
      'error':{'code':'ENOENT',
               'message':'ENOENT: no such file or directory, open ...'}}
```

**根因**：ACP server-request 响应（比如 `read_file` 失败）携带 JS-native 字符串错误码 `'ENOENT'`，但 Grok agent 端 protocol 要求 `code` 字段必须 i32 整数。旧 agent-node 直传 → Grok agent 解析失败 → 进入未定义状态 → hang 直到 client-side 300 s 超时。

**修复**（commit [`4818776`](https://github.com/sleep2agi/agent-network/commit/4818776)）：`client.ts:handleServerRequest` 加 `Number.isInteger(rawCode)` 守卫。非整数 code → coerce 成 `-32000`（JSON-RPC 标准 reserved range），原 code 字符串保留到 `data.originalCode` 不丢信息。

**新增回归测试**：+2 cases，bun test 89/89 pass。

**实战验证**（维护者本机，2026-06-07 19:50–19:55）：
- 同型 `read_file` 失败重试：立返结构化 `code: -32000` + `data.originalCode: "ENOENT"`
- grok turn 继续不 hang，任务正常 done/failed（47 s 完成，不到 300 s 超时门）
- ai-insight `A站Grok` 节点全局装 `2.4.9-preview.0` 后 UAT 通过

### 🐛 Bugs Fixed

- [#210](https://github.com/sleep2agi/agent-network/issues/210) / #204 runtime — `grok-build-acp` ACP server-request 响应携带非整数错误码（如 `ENOENT`）致 Grok agent 解析失败 hang 至 300 s timeout

### 📦 Install（全新安装）

```bash
npm i -g @sleep2agi/agent-network@latest @sleep2agi/agent-node@latest
# 验证版本
anet --version          # agent-network v2.2.10（未变）
agent-node --version    # agent-node v2.4.9 ⬆
```

`anet hub start` 自动拉取 `commhub-server@0.8.4`（PINNED, 未变）。

### 🔄 Upgrade（老用户升级）

**最窄路径**（推荐 — 仅此 hotfix 必需）：

```bash
npm i -g @sleep2agi/agent-node@2.4.9
# 重启所有 grok-build-acp 节点
cd <your-anet-workdir>
anet node stop <grok-node-alias> && anet node start <grok-node-alias>
```

**全包升级**（一并刷 README / metadata）：

```bash
anet upgrade
```

⚠️ Node 版本：agent-node 兼容 Node ≥ 18；本 hotfix 在 Node 20.20 / 24.16 双跑 Docker smoke 通过。

详细排错入口见 [troubleshooting → grok-build-acp 节点任务挂死](/troubleshooting#grok-build-acp-节点任务挂死-session-prompt-timed-out-after-300000ms-json-rpc-error-32603)。

### 🙏 Credits

bug 复现 + root cause + UAT：本机活体抓 19:53:09 日志 + Vincent `A站Grok` 47 s pilot；fix 实现：commit `4818776` + 2 回归测试；release ops：Method B 两阶段 + Install/Upgrade 分块 release notes。

**Full Changelog**: <https://github.com/sleep2agi/agent-network/compare/v0.10.12...v0.10.13>

---

## v0.10.12 — **Grok-build runtime 场景化能力 + 0.2.8 alpha 回归验证**（2026-05-30）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-node@2.4.8` ← bumped（场景化文档 + 0.2.8 alpha 回归基线 tag）
- `@sleep2agi/agent-network@2.2.10` ← unchanged
- `@sleep2agi/commhub-server@0.8.4` ← unchanged

### 主要内容

- **视频生成场景（0 改动可用）**：给 Grok 节点发送带图片 URL 的任务，后端自动路由到 `grok-imagine-video` 模型，产出 mp4。anet 端零代码改动，已用 ffmpeg 第一帧视觉验证。详见 [research/grok-video-gen-capability-probe.md](https://github.com/sleep2agi/agent-network/blob/main/docs/research/grok-video-gen-capability-probe.md)（含 Erratum）+ [scenarios/video-gen-marketing.md](https://github.com/sleep2agi/agent-network/blob/main/docs/scenarios/video-gen-marketing.md)。
- **基础 X 搜索（开箱即用）**：按 keyword / handle 找 X URL + 标题 + 摘要 —— LLM 自动用 `web_search` + `allowed_domains=["x.com"]` 命中，无需预置。
- **实时 X 高级搜索（需工作区预置）**：实时推流 + 帖子 faves/retweets/replies metadata + `since:` / `min_faves:` 高级语法 —— 需用户预置 twitterapi.io API key + fetcher 脚本，LLM 用 `run_terminal_command` 调。详见 [scenarios/x-search-informant.md](https://github.com/sleep2agi/agent-network/blob/main/docs/scenarios/x-search-informant.md)。
- **0.2.8 alpha 回归验证**：87/87 bun 单元测试通过，#201 委派识别 + #204 `.mcp.json` 隔离修复在 Grok 0.2.8 alpha 上确认无回归。详见 [tests/p-grok-028-regression-verify/report.md](https://github.com/sleep2agi/agent-network/blob/main/docs/tests/p-grok-028-regression-verify/report.md)。
- **RFC-021 §12 / §13**：ACP 能力档案补充 Path D（工作区预置 + 终端兜底）+ XSearch ACP 暴露实测（XSearch 后端工具在 0.1.219 → 0.2.12 alpha 一致不通过 ACP 暴露，属结构性，长期解在 xAI 上游 PR #1302）。

### 📦 Install / 🔄 Upgrade

升级无破坏性，0.2.8 alpha 回归已过，可安全升级：

```bash
anet upgrade
```

或手动单包：`npm i -g @sleep2agi/agent-node@2.4.8`

**Full Changelog**: <https://github.com/sleep2agi/agent-network/compare/v0.10.11...v0.10.12>

---

## v0.10.11 — **#204 grok-build-acp 节点身份隔离 + #194 commhub broadcast 归属 hotfix**（2026-05-28）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.10` ← bumped（`anet hub stop` / `anet hub status` 子命令 [#200](https://github.com/sleep2agi/agent-network/issues/200) + `anet hub start` stderr inherit [#199](https://github.com/sleep2agi/agent-network/issues/199) 静默挂修 + PINNED commhub-server `0.8.3` → `0.8.4`）
- `@sleep2agi/agent-node@2.4.7` ← bumped（[#204](https://github.com/sleep2agi/agent-network/issues/204) grok-build-acp per-node `.anet/nodes/<alias>/runtime-cwd/` 隔离 + [#201](https://github.com/sleep2agi/agent-network/issues/201) Grok delegate parser 3-layer broaden）
- `@sleep2agi/commhub-server@0.8.4` ← bumped（[#194](https://github.com/sleep2agi/agent-network/issues/194) broadcast `channel_meta_json` sender 归属 hotfix —— `from_session` 注入不再覆盖真实 LLM agent alias）
- `@sleep2agi/agent-network-dashboard@0.5.6` ← unchanged

### 🌟 Highlights

#### [#204](https://github.com/sleep2agi/agent-network/issues/204) — grok-build-acp per-node isolated cwd

**问题**：`grok-build-acp` runtime 节点共享 `.mcp.json` 发现路径，导致 stale `.mcp.json` identity pollution —— 一个节点的工作目录里如果存在旧的 `.mcp.json`，新启的 grok 节点会被误认成那个旧节点的身份。

**修复**：每个节点 fork 独立 cwd（`.anet/nodes/<alias>/runtime-cwd/`），与发现路径解耦，彻底解决 stale `.mcp.json` 干扰。

**E2E 验证**：在真节点跑通跨节点 dispatch —— channel sender attribution 正确归属到发送节点 alias，证实 LLM 层 attribution 链路无污染。

#### [#194](https://github.com/sleep2agi/agent-network/issues/194) — commhub broadcast 发送者归属 hotfix

**问题**：跨节点 broadcast 时 `channel_meta_json` 的 sender 字段经过 `from_session` 注入路径，导致 real LLM agent 名字被覆盖。

**修复**：commhub-server `0.8.4` 修正 from-name 注入逻辑，保留真实 sender alias。

### 🐛 Bugs Fixed

- [#199](https://github.com/sleep2agi/agent-network/issues/199) — `anet hub start` 静默挂修：`spawn` 的 `stdio` 从 `"pipe"` 改为 `"inherit"`，commhub-server bunx fetch 失败时立即可见错误
- [#200](https://github.com/sleep2agi/agent-network/issues/200) — `anet hub stop` / `anet hub status` 子命令补全：之前用户需手动 `lsof + kill`；现在 `anet hub stop [--port <p>]`（SIGTERM → 3s grace → SIGKILL）+ `anet hub status`（PID + port + `/health` version）
- [#201](https://github.com/sleep2agi/agent-network/issues/201) — Grok runtime 拒绝 delegate：explicit delegation parser 3-layer wrapper broaden + prompt softening 全 case 覆盖

### 📦 Install（全新安装）

```bash
npm i -g @sleep2agi/agent-network@latest
# 验证版本
anet -v  # 应显示 v2.2.10
```

`anet hub start` 会自动拉取 `commhub-server@0.8.4` (PINNED) + 首次 node 启动会自动拉取 `agent-node@2.4.7`。

### 🔄 Upgrade（老用户升级）

```bash
anet upgrade
# 或手动
npm i -g @sleep2agi/agent-network@latest
```

`anet upgrade` 会同步 agent-network + agent-node + commhub-server 到最新 latest 版。

### 🙏 Credits

Shipped by 团队 Agent Network — 设计 + lead review / agent-node `#204` fix / agent-network release ops + `commhub-server` promote / 测试 + 文档 全程协作完成. 个人贡献明细见 [v0.10.11 GitHub release page](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.11). LLM E2E attribution 由真节点跨 hub dispatch 验证.

**Full Changelog**: <https://github.com/sleep2agi/agent-network/compare/v0.10.10...v0.10.11>

---

## v0.10.10 — **小米 MiMo 5 模型完整支持 + envRef wizard-to-start 自动衔接**（2026-05-27）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.9` ← bumped（envRef Option A 自动 source + `anet -v` 显示完整 prerelease 后缀 + Grok delegation parser broaden）
- `@sleep2agi/agent-node@2.4.6` ← bumped（envRef Option A 实施 + Grok 节点延续 stabilization）
- `@sleep2agi/commhub-server@0.8.3` ← unchanged
- `@sleep2agi/agent-network-dashboard` ← unchanged

### P0 — 小米 MiMo Vendor Preset 完整

- 新增 `mimo-v2.5-tts-voicedesign`，凑齐官方 5 个模型
- `anet node create` 选 `claude-agent-sdk` runtime → 「小米 MiMo」vendor → 5 模型任选：`mimo-v2.5-pro`（默认）/ `mimo-v2.5` / `mimo-v2-pro` / `mimo-v2-omni` / `mimo-v2.5-tts-voicedesign`
- endpoint `https://token-plan-cn.xiaomimimo.com/anthropic` 完整对接 Anthropic Messages 协议
- 📌 注：`voicedesign` 是 TTS 语音设计模型，Anthropic Messages 文本请求 vendor 大概率不支持；文本对话请用前 4 个模型

### P0 — envRef wizard-to-start 自动衔接（[#193](https://github.com/sleep2agi/agent-network/issues/193)）

**痛点**：`anet node create` 完后同 shell 立即 `anet node start` 报 FATAL `env var not set`，必须手动 `export ANTHROPIC_AUTH_TOKEN_N_<id>=...`。

**现在的行为**：

- wizard create 时 API key 自动写入 `.anet/nodes/<alias>/.env`（mode 0600，自动加入 `.anet/.gitignore`）
- `anet node start` 启动前自动 source 该 `.env`，无需手动 export
- 跨机部署仍支持（wizard 仍 print 一次 export 命令，可手动 copy 到另一台机）
- Debug 日志只输出 `loaded N key(s) from .anet/nodes/<alias>/.env`，**不 echo key 值**
- 向后兼容：已有 `ANTHROPIC_AUTH_TOKEN_N_*` shell export 继续 work；老节点 plain `config.json` 模式继续 work

适用所有 `claude-agent-sdk` 类型节点（MiMo / MiniMax / 书生 / GLM / 任意 Anthropic Messages 兼容 vendor）。

### Bug fixes

- **[#192](https://github.com/sleep2agi/agent-network/issues/192)** `anet -v` 不显示完整 prerelease 后缀已修，现显示 `v2.2.9` 完整版本号（含 `-preview.N` 后缀 when applicable）
- **[#189](https://github.com/sleep2agi/agent-network/issues/189) Grok runtime** `grok-build-acp` 全面稳定化：explicit delegation parser broaden 覆盖含「你和 X 沟通一下…」「send_task X 一下…」等无标点尾随 body 句式，跨节点 delegation 路由可靠

### Known Issues

`agent-network` 内部 `npx` fallback 仍 pin `@sleep2agi/agent-node@preview` 标签 —— 未来 preview 推进可能让 latest 用户拉到不稳版本。本 release 不存在 regression（preview 2.4.6-preview.2 内容接近 latest 2.4.6），但需后续 RFC 处理（follow-up tracking 待 issue 开；**与同号 [RFC-021 ACP capability profile expansion](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-021-acp-capability-profile-expansion.md) 为 X-search unlock 主题不同**）。

---

## v0.10.9 — **Dashboard 图片发送 + CommHub 附件元数据 + codex-sdk 图片输入**（2026-05-25）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.7` ← bumped（PINNED server 切到 `@sleep2agi/commhub-server@0.8.3`）
- `@sleep2agi/agent-node@2.4.3` ← bumped（codex-sdk runtime 读取结构化图片附件）
- `@sleep2agi/commhub-server@0.8.3` ← bumped（`meta_json` 持久化 + MCP/REST 附件元数据）
- `@sleep2agi/agent-network-dashboard@0.5.4` ← bumped（TaskChatPanel 图片上传/粘贴发送）

### P0 — Dashboard 指挥链路支持发送图片

Vincent catch：Dashboard 聊天里已经能上传/预览图片，但任务发送到 agent 后只剩文字路径，codex-sdk runtime 没有拿到图片输入。结果是移动端/网页指挥时无法把截图、设计稿、报错图直接交给团队处理。

**Implementation**：
- Dashboard `TaskChatPanel` 上传/粘贴图片后发送结构化 `attachments`，同时保留文本中的本地路径和预览 URL 作为兼容 fallback。
- Hub `send_task` / REST `/api/task` 接收 `meta.attachments`，写入 `inbox.meta_json` 与 `tasks.meta_json`；`get_inbox` 返回解析后的 `meta`。
- agent-node 从 `meta.attachments` 中抽取本机可读图片路径，传给 codex-sdk/studio 的 image input。
- 修复 Telegram 图片通道参数顺序，避免 channel image 参数被误放到 `contextFrom`。

### Rollout + Smoke

- 本机 CommHub 已升级并重启到 `0.8.3` 源码状态。
- Dashboard 已升级并重启，`dm.vansin.me:3000` 对应的图片发送链路走结构化附件。
- 27 个 host codex-sdk agent-node 进程已按新版代码滚动重启。
- P0 smoke：向 `通信测试牛` 发送 `/tmp/anet-image-smoke.png`，节点日志显示 `+1 image(s)` / `→ processing [codex] +1 image(s)`，回执 `图片通道OK`。

### Known Limits

- Dashboard 上传的图片当前以同机文件路径交给 hub/agent，最适合 hub 与 agent 共享本机文件系统的部署；跨机器对象存储分发留后续版本。
- 已运行的旧容器镜像不会自动获得本次代码，需要重新安装/重启到 latest。
- 本 release 解决“图片能送到 agent runtime”；图片消息的富媒体历史展示、移动端 IM 化体验仍留在 dashboard 后续 issue 中推进。

详见 [v0.10.9 tag](https://github.com/sleep2agi/agent-network/tree/v0.10.9)。

---

## v0.10.8 — **Dashboard Servers 面板 UI 文案修 + TopoGraph density tier polish**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.6` *(无变化，v0.10.7)*
- `@sleep2agi/agent-node@2.4.2` *(无变化)*
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.3` ← bumped（UI copy + Playwright attrs + polish fold-in）

### Fix — [#157](https://github.com/sleep2agi/agent-network/issues/157) Dashboard Servers 面板 UI 文案修正（Root cause #1）

Vincent 实测 catch（附 dashboard 截图）：Servers 面板对每台 hub 显示 `agent rollup pending hub ≥ 0.8.2-preview` / `disk metric pending hub ≥ 0.8.2-preview`，但生产 hub 已经全部 ≥ 0.8.2，**文案过时且误导**，让 Vincent 一度以为版本控制台数据完全错误。

**Root cause #1（本 patch）**：ServersDrawer UI 早期为 0.8.2 升级 window 而埋的占位文字。0.8.2 早已上线，但占位文字未删，对 ≥ 0.8.2 hub 仍显示 "pending"，误导用户认为 hub 数据缺失。

**Implementation**（`app/components/ServersDrawer.tsx`）：

```diff
- <div ...>agent rollup pending hub ≥ 0.8.2-preview</div>
- <div ...>disk metric pending hub ≥ 0.8.2-preview</div>
+ <div ... data-server-agents-missing="true">agent rollup not reported by hub</div>
+ <div ... data-server-disk-missing="true">disk metric not reported by hub</div>
```

文案精准反映"该 hub 此刻未上报"语义，不再 imply 版本不够。新增 `data-server-agents-missing` / `data-server-disk-missing` Playwright 钩子供下一轮 e2e 验证 hub-side telemetry coverage。

::: info Root cause #2 + #3 已定位但 defer
- **#2**（v0.10.9 候选）：同 hostname 多实例时 dedupe 缺失，可能 double-count 服务器 —— Dashboard 团队修复方案已就位，待 v0.10.9 ship
- **#3**（v0.11.0 候选）：`status=offline` 与 telemetry 报告 mismatch（telemetry 仍上报但 SSE last_seen 超时）—— 系统级 status 协调
:::

### Polish fold-in — TopoGraph density tier（纯 additive）

Dashboard 团队 commit [`3f73810`](https://github.com/sleep2agi/agent-network-dashboard/commit/3f73810) （0.5.3-preview.16）—— Canvas state attr `data-topo-fleet-density-tier` ∈ `{empty, sparse, normal, dense, very-dense}` 暴露第 12 个 observable testing surface。Tier 边界（sparse 1-3 / normal 4-15 / dense 16-30 / very-dense 31+）跟 dense-layout collapse gate 对齐。**纯 additive，无 UX 改变**，配 numeric counts 提供 e2e selector 完整 canvas state snapshot 能力。

### Quality gates + lessons

- **Source-grep verify**：`grep -rh "not reported by hub"` 命中 + 旧文案只在 JSDoc 注释 ✅
- **Docker preview 实测**：`docker run --rm node:24-slim sh -c "npm install -g @sleep2agi/agent-network-dashboard@0.5.3-preview.15 && grep..."` ✅
- **JSX 文案 verify 走 source level**：在 `app/components/ServersDrawer.tsx` source 验，不依赖 `.next/server` bundled output
- **v0.10.x patch density 单日 8 patch** 验证 audit-first cadence 可持续

### 发布统计 — v0.10.8

- **18 累计 `@latest` publish**（v0.9.0 → v0.10.8）：0 split-brain / 0 rollback / 0 retry
- **2026-05-17 当日 v0.10.x**：v0.10.1-8 = **8 ships in ~11 hours**（audit-first cadence）
- Vincent catch + Vincent [#158 LOCKED directive](https://github.com/sleep2agi/agent-network/issues/158) 同 cycle 闭环

详见 [release v0.10.8](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.8)。

---

## v0.10.7 — **codex-sdk batch path yolo flags parity**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.6` ← bumped（codex-sdk batch path yolo parity）
- `@sleep2agi/agent-node@2.4.2` *(无变化)*
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.2` *(无变化)*

### Fix — [#156](https://github.com/sleep2agi/agent-network/issues/156) codex-sdk batch path yolo flags parity

Vincent catch："fast 也要开新一下默认 / codex 默认 fast 啊"。

**Pre-fix vs Post-fix matrix**：

| Path | Pre-fix | Post-fix |
|---|---|---|
| `anet node create --runtime codex-sdk` | ✅ 4/4 yolo flags（[#149](https://github.com/sleep2agi/agent-network/issues/149) v0.10.3 ship） | ✅ 4/4 yolo flags（不变）|
| `anet create --batch --runtime codex-sdk` | ❌ **仅 1/4**（`dangerouslySkipPermissions` baseline only） | ✅ 4/4 yolo flags（跟 single-node 对齐） |
| `anet [...] --runtime codex-sdk --no-yolo` | （无此 flag） | ✅ 1/4 baseline（opt-out for CI/scripted）|

**Implementation** — clean helper extraction at `bin/cli.ts:125-131`：

```ts
function codexSdkYoloFlags(noYolo?: boolean): Record<string, string | boolean> {
  if (noYolo) return {};
  return {
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
    skipGitRepoCheck: true,
  };
}
```

Source-of-truth helper：single-node path（`cli.ts:1146`）+ batch path（`cli.ts:6223`）都 call 同一个，**阻断 v0.10.6 1/4-vs-4/4 drift**。`dangerouslySkipPermissions: true` 是 baseline，在每个 call site 单独 set，1+3=4 yolo total。

### 用户影响

- **batch + codex-sdk 用户**：之前 batch wizard 出的 codex agents 在 tool approval popup / sandbox / git check 处 block，失去 yolo autonomous 状态 → 现在 4/4 flags 全 set，autonomous 行为跟 single-node 一致
- **single-node 用户**：不受影响（path 不变）
- **CI / scripted 用户**：新 `--no-yolo` flag 提供 explicit safe-mode opt-out
- **非 codex-sdk runtime**（claude / sdk）：完全不变（helper gated on `runtime === "codex-sdk"`）

### Quality gates + lessons

- **Source-grep verify**：`grep -n` 对 `bin/cli.ts` HEAD 5 sites 全 PASS（helper + 2 call sites + wiring + field）
- **Docker container smoke**：Cell A `anet login` setup failed（test infra blocker, not a fix bug）→ Gate 2 source-grep evidence accepted as substitute per v0.10.6 precedent
- **Docker smoke 用 curl 直调 API 拿 token**（本次新增）—— Docker smoke entry script 用 `curl` direct API call `/api/auth/register` + `/api/auth/login` 写 token，**不要** interactive `anet login`（在 non-TTY container 容易 stall，hub login 调用阻塞）

### 发布统计 — v0.10.7

- **17 累计 `@latest` publish**（v0.9.0 → v0.10.7）：0 split-brain / 0 rollback / 0 retry
- **2026-05-17 当日 v0.10.x**：v0.10.1-7 = **7 ships in ~10 hours**（audit-first cadence）
- **10 项用户反馈全闭环**：包括 v0.10.7 #156

详见 [release v0.10.7](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.7)。

---

## v0.10.6 — **`anet upgrade` Option B detached spawn + `anet create --batch` wizard silent-exit 修**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.5` ← bumped（CLI upgrade + wizard fixes）
- `@sleep2agi/agent-node@2.4.2` *(无变化，v0.10.3)*
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.2` *(无变化，v0.10.4)*

::: warning Chicken-and-egg 升级注 — 仅本次需手装 1 次
v0.10.4 的 [#151 Option A](https://github.com/sleep2agi/agent-network/issues/151) 只改了 verbiage（`anet upgrade` 显示 "⚠️ NEEDS MANUAL UPGRADE"），**chicken-and-egg deadlock 没解** —— 你的当前 `2.2.2 / 2.2.3 / 2.2.4` binary 跑 `anet upgrade` 还会沿用旧 "skipped (would replace running CLI)" 行为（这条 frozen 在 npm 上的老逻辑）。

```bash
npm install -g @sleep2agi/agent-network@2.2.5    # 只需一次手装
anet --version                                    # 期望 v2.2.5
```

之后再有新版本（e.g. 2.2.6+），直接跑 `anet upgrade` 就会**自动 detached spawn** 升级，不再手装。
:::

### Fixes

- **[#154](https://github.com/sleep2agi/agent-network/issues/154) `anet upgrade` Option B detached spawn 默认开启**（Vincent catch）：之前用户跑 `anet upgrade` 看到 `anet (self): skipped (would replace the running CLI).` + `[anet] Done.` 以为成功，实际 anet binary 没变（chicken-and-egg deadlock —— Node 进程无法 in-place 替换自己 binary）。`bin/cli.ts:3873-3874` 改成 `spawn(forkScript, [], { stdio: "inherit", detached: true })` + `child.unref()` + 主进程 `process.exit(0)`，detached child 后台跑 `npm install`。新版本一两分钟后生效，无需用户 `--self` flag。
- **[#155](https://github.com/sleep2agi/agent-network/issues/155) `anet create --batch` wizard silent-exit 修**（Vincent catch）：workdir mode `select()` 之后 `process.stdin` 状态变化，readline-based `ask()` helper 在 EOF 立即 return → 整个 wizard 在 `Node prefix` prompt **静默退出**（同 [#137 v0.9.2 preview.5 anet create regression](https://github.com/sleep2agi/agent-network/issues/137) 同根问题，不同代码路径再发）。Fix：post-select prompts 全 migrate 到 `inquirer.input()`，stdin handling 跟前面的 select 保持一致；catch fallback 保留 legacy `ask()` for non-TTY / 无 inquirer 环境。

### Quality gates + lessons

- **Docker smoke gate 永不跳过**（Vincent）—— v0.10.4 紧急 trust path **SUSPENDED**，Docker smoke gate 永不跳。
- **测试节点全在 Docker**（Vincent）—— 红线：测试节点全 Docker，不许 connect 本机 hub。
- **dist 是混淆 bundle、code verify 走 source**（本次新增）—— `dist/bin/cli.js` 是 esbuild bundled + obfuscated（rotating string-table, identifiers mangled, string literals encoded），静态 grep 对 dist 完全失效。Code-path verify 一律 grep `bin/cli.ts` source（HEAD = preview build source）。

### 发布统计 — v0.10.6

- **16 累计 `@latest` publish**（v0.9.0 → v0.10.6）：0 split-brain / 0 rollback / 0 retry
- **2026-05-17 当日 v0.10.x**: v0.10.1 + v0.10.2 + v0.10.3 + v0.10.4 + v0.10.5 + **v0.10.6** = **6 ships in ~9 hours**（audit-first cadence）
- **9 项用户反馈全闭环**：Install/Upgrade 文档分块 + #149 / #150 / #151 / #152 / #153 / #154 / #155 + 安全红线 SOP

详见 [release v0.10.6](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.6)。

---

## v0.10.5 — **`anet create --batch` wizard 双修**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.4` ← bumped（CLI wizard 修）
- `@sleep2agi/agent-node@2.4.2` *(无变化，v0.10.3 ship)*
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.2` *(无变化，v0.10.4 ship)*

### Fixes

- **[#152](https://github.com/sleep2agi/agent-network/issues/152) `anet create --batch` wizard 加 workdir mode 选择**（Vincent push）：`--workdir-mode <shared|separate>` flag 早就 ship（[#55](https://github.com/sleep2agi/agent-network/issues/55)）但 interactive wizard 从来没 prompt → 用户必须知道 flag 名才能改 default `separate`。`createBatchWizardCommand` 加 inquirer select（`separate` 默认 / `shared` 共 cwd），TTY-aware（flag set / non-TTY 都 fallback `separate` + INFO hint）。agent-node / server / dashboard 不动 —— 纯 CLI wizard UX。
- **[#153](https://github.com/sleep2agi/agent-network/issues/153) codex-sdk / claude-code-cli 选完不再误问 `ANTHROPIC_AUTH_TOKEN`**（Vincent push）：runtime-first wizard ([#133](https://github.com/sleep2agi/agent-network/issues/133)) 选 codex-sdk / claude-code-cli 时仍调 `selectVendorAndModel()` → 问 API key（只 claude-agent-sdk 需要）。Wizard 选 codex / claude-code-cli 后 skip API key prompt + print `codex auth login` / `claude auth login` 一行提示。

详见 [release v0.10.5](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.5)。

---

## v0.10.4 — **`anet upgrade` UX 警告 + Dashboard orphan-band 布局**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.3` ← bumped（[#151](https://github.com/sleep2agi/agent-network/issues/151) anet upgrade UX）
- `@sleep2agi/agent-network-dashboard@0.5.2` ← bumped（[#150](https://github.com/sleep2agi/agent-network/issues/150) orphan-band layout）
- `@sleep2agi/agent-node@2.4.2` *(无变化，v0.10.3 ship)*
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*

### Fixes

- **[#151](https://github.com/sleep2agi/agent-network/issues/151) `anet upgrade` self-skip 警告更明确**（Vincent push）：之前 `anet (self) — self-skip` 行没解释 why & how，用户照着 plan 跑完发现自己版本没升。现在加 explicit warning + 引导 `--self` flag。
- **[#150](https://github.com/sleep2agi/agent-network/issues/150) Dashboard 拓扑图 orphan 节点收到 "其他" cluster box**（Vincent push）：之前 orphan 节点（无 prefix 分组）散落画布各处难找；现在收到统一 "其他" cluster box 跟其他 group 一起渲染。

::: warning Vincent 紧急 trust path
v0.10.4 Vincent 紧急 ship 跳过 测试团队 Docker smoke gate（不在生产跑测试的规矩不豁免，但 Vincent lead-scope 决定 trust path）。Docker smoke 仍是 release-gate playbook 标准卡控点，不变。
:::

详见 [release v0.10.4](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.4)。

---

## v0.10.3 — **codex-sdk default model gpt-5.5 + yolo flags 可见**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.2` ← bumped（cli.ts vendor preset）
- `@sleep2agi/agent-node@2.4.2` ← bumped（codex-sdk runtime + flags）
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.1` *(无变化)*

### Fixes

- **[#149](https://github.com/sleep2agi/agent-network/issues/149) codex-sdk 默认模型修 + yolo flags 写进 config**（Vincent catch）：
  - cli.ts codex vendor preset 默认 model placeholder `gpt-5.4` → 真实 `gpt-5.5`
  - codex-sdk runtime 加 `yolo: true` flags（跟 Claude Code preset 的 `dangerouslySkipPermissions` + `teammateMode` 同概念）—— 跳过权限交互弹窗便于 multi-agent batch 跑
  - flags 写进 `config.json` 而非 ephemeral runtime arg，用户能 inspect / 编辑

详见 [release v0.10.3](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.3)。

---

## v0.10.2 — **Hero A disk telemetry + Hero D 拓扑图标签 UX**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.1` *(无变化，PINNED_SERVER_VERSION 仍 `0.8.2`)*
- `@sleep2agi/agent-node@2.4.1` ← `2.4.0`（Hero A disk telemetry additive，commit [`50d25b2`](https://github.com/sleep2agi/agent-network/commit/50d25b2)）
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.1` ← `0.5.0`（Hero D 拓扑图前缀标签 Option C + disk render + 100+ 轮 polish）

### Hero A — agent-node disk telemetry（[#99](https://github.com/sleep2agi/agent-network/issues/99) 守护节点 Phase 2 host metrics 闭环 final 10%）

`agent-node/src/host-telemetry.ts` 新增 `readDiskStats()`（`execFileSync('df', ['-k', '/'])`，+33 lines）：

- **POSIX `-k`** 标准化 KB 输出，Linux + macOS 同一 parse 路径
- **不走 shell pipe**（per recent shell-audit safety review），`execFileSync` direct call
- Windows / 解析失败：**graceful null**（dashboard 渲染 `—` 不误导成 0）
- `HostTelemetry` interface 加 `disk_total_gb` / `disk_used_gb` / `disk_avail_gb`，`getHostTelemetry()` 通过 `toGb()` 同 mem/cpu 同 path 合成
- **Backward compat**：老 server 端 schema silent-drop unknown keys；agent / server 可独立升

接 [RFC-014](https://github.com/sleep2agi/agent-network/issues/99) — `/api/server/:host/health` 响应现在带 disk 三字段 + 24h 分桶 history 也含 `disk_avail_min` / `disk_used_max`；`alert_level` 加 `disk < 1GB critical / < 5GB warn` 触发（[`server/src/index.ts:253-258`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L253)）。

测试团队 Docker Linux smoke 3/3 PASS（disk 299.8 GB total / 216 used / 71.5 avail，alert green，backward compat verified）。

### Hero D — Dashboard 拓扑图前缀标签 UX Option C（dashboard `0.5.1`）

[#147](https://github.com/sleep2agi/agent-network/issues/147)（5/16 ack）+ Option C 落地：

- 拓扑节点前缀标签（[节点 → group 边的 label distinguishability）实装 Option C 设计（Dashboard 团队 design pass）
- disk telemetry hover card 渲染（`disk_total_gb` / `disk_used_gb` / `disk_avail_gb` 三字段对接 [`GET /api/server/:host/health`](/api/rest#get-api-server-host-health) 响应）
- 100+ 轮 typography + corner-radius cascade polish

Dashboard 团队 design pass + 4/4 verify（commit `7de97ee` + screenshot evidence，local ship `f9c83cd`）。

### Closed issues

- [#99](https://github.com/sleep2agi/agent-network/issues/99) 守护节点 Phase 2 close gate met（host metrics 闭环 final 10%，Hero A disk ship）
- [#147](https://github.com/sleep2agi/agent-network/issues/147) Hero D（5/16 ack 后 Option C 落地）

### RFC artifacts preserved（v0.12.0 scope）

本轮 v0.10.2 是 hotfix scope（不含 v0.11.0 系列 RFC ship），3 个 RFC artifact 保留进 v0.12.0 candidate：

- [RFC-013 v5](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-013-rename-hot-reload.md) rename hot-reload（third-pass review 整改完）
- [RFC-014 v2](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-014-daemon-phase2-host-metrics.md) daemon Phase 2 host metrics（v0.10.2 Hero A 已 ship final 10%）
- [RFC-015 v2](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-015-token-usage-telemetry.md) #114 token usage UI（first-pass REVISION 完）

### Upgrade

```bash
anet upgrade                                     # 升 agent-node 2.4.0 → 2.4.1 + dashboard 0.5.0 → 0.5.1
anet project restart                             # 重启项目（拉新 agent-node + dashboard）
```

### Migration / Breaking

- **No breaking changes** —— disk 字段是 additive (`HostTelemetry` interface 扩 3 字段，server schema silent-drop unknown keys backward compat)；agent / server 可独立升级，老 agent 不带字段时 SQL `NULL` → dashboard 渲染 `—` 不误导

发布流程沿用 [v0.9.0 split-brain lessons #126](https://github.com/sleep2agi/agent-network/issues/126) 的两 phase publish SOP。

---

## v0.10.1 — **Hotfix: PINNED_SERVER_VERSION 跟 v0.10.0 ship chain-bump**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.1`
- `@sleep2agi/agent-node@2.4.0` *(无变化)*
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.0` *(无变化)*

### Fix

[`agent-network/bin/cli.ts:61` `PINNED_SERVER_VERSION`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L61) 跨 v0.9.x + v0.10.0 promote 漏 bump，仍 hardcode `0.8.0` —— `anet hub start` 实际 `bunx --bun @sleep2agi/commhub-server@0.8.0` 启服务（[cli.ts:2589](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2589)），跑的是老 server 不是 v0.10.0 ship 的 `0.8.2`。直接影响：

- [#99](https://github.com/sleep2agi/agent-network/issues/99) 守护节点 endpoint family `GET /api/server/:host/health` + `GET /api/server/:host/agents` 在 0.8.0 不存在 → **404**
- [#142](https://github.com/sleep2agi/agent-network/issues/142) server schema align `process_telemetry` 字段在 0.8.0 没接 → 老 schema silent-drop 字段
- dashboard `0.5.0` §3.F server-health ring tint **数据源失败** / §3.E hover card `process_telemetry` 字段全 `null`

v0.10.0 announced functionality regression in **default-path `anet hub start`** workflow（手动 `bunx --bun @sleep2agi/commhub-server@latest` 不受影响）。

修复（commit [`4d24024`](https://github.com/sleep2agi/agent-network/commit/4d24024)）：

```diff
- const PINNED_SERVER_VERSION = "0.8.0";
+ const PINNED_SERVER_VERSION = "0.8.2";
```

### Upgrade

```bash
anet upgrade                                     # 升 agent-network 2.2.0 → 2.2.1
anet project restart                             # 重启项目（拉新 commhub-server）
```

或 fresh install：

```bash
npm install -g @sleep2agi/agent-network@latest
```

### Lessons

- **release-gate playbook 加 case** —— 每次 promote latest 时 `PINNED_*_VERSION`（server pin / dashboard pin / agent-node pin）必跟 chain-bump，否则默认路径仍跑老 ship。跟 [#80 PINNED bump SOP](https://github.com/sleep2agi/agent-network/issues/80) 一致但 Hero 4 release-gate playbook 当时漏覆盖；本 hotfix 后已加 case ([见 lesson memory](https://github.com/sleep2agi/agent-network/blob/main/docs/sop/methodology.md))。

发布流程沿用 [v0.9.0 split-brain lessons #126](https://github.com/sleep2agi/agent-network/issues/126) 的两 phase publish SOP。

---

## v0.10.0 — **Direct Runtime + Observability Foundations**（2026-05-16）✅ stable（Phase 1，3 包 promote）

**版本同步**（npm `latest` tag，Phase 1）：
- `@sleep2agi/agent-network@2.2.0`
- `@sleep2agi/agent-node@2.4.0`
- `@sleep2agi/commhub-server@0.8.2`
- `@sleep2agi/agent-network-dashboard@0.5.0` ✅ Phase 2 ship

::: tip 主题：治本
v0.7 → v0.9.2 累积 11 release、5 P0 chain（[#135-#139](https://github.com/sleep2agi/agent-network/issues/135)）暴露 runtime 架构债。v0.10.0 治本 —— runtime 架构债（codex-sdk wrapper bypass，opt-in）+ observability 基础（守护节点 endpoint + per-agent process telemetry）+ release-gate playbook。为 v0.11.0 多厂商 AI Agent 社会 24/7 直播打地基。详见 [v0.10.0 release tracker #140](https://github.com/sleep2agi/agent-network/issues/140)。
:::

### 5 features

**A. [#141](https://github.com/sleep2agi/agent-network/issues/141) codex app-server stdio direct（opt-in `ANET_CODEX_STDIO_DIRECT=1`）**
之前 codex runtime 走 `@openai/codex-sdk` npm wrapper，wrapper 的 `--mcp-config` HTTP transport bug 是 [#102](https://github.com/sleep2agi/agent-network/issues/102) hang root cause family。v0.10.0 新增直 `spawn('codex', ['app-server'])` + 最小 stdio JSON-RPC client (~155 LOC) 路径，**bypass wrapper 整个绕过这 family bug**，同时拿到完整 67-method v2 protocol surface（thread / turn / item / realtime 等），不再受 codex-sdk breaking change 牵制。**v0.10.0 默认仍是 wrapper 路径**（先收 preview 反馈），显式 `ANET_CODEX_STDIO_DIRECT=1` 开启直 stdio；v0.11.0 计划 default flip。

**B. [#99](https://github.com/sleep2agi/agent-network/issues/99) 守护节点 Phase 1 scaffold（监测 only）**
新增 server-side endpoint family（commit [`e575cc6`](https://github.com/sleep2agi/agent-network/commit/e575cc6)）：
- `GET /api/server/:host/health` — host CPU / mem / disk / process 健康
- `GET /api/server/:host/agents` — agent list per host + telemetry 历史

dashboard 集成留 Phase 2（[#119](https://github.com/sleep2agi/agent-network/issues/119) ServersDrawer 整合）。控制层（kill / restart / redeploy）defer 到 v0.11.0。

**C. [#142](https://github.com/sleep2agi/agent-network/issues/142) Per-agent process telemetry**
agent-node 每次 `commhub_report_status` 心跳带上 `process_telemetry`：`rss` / `cpu_pct` / `uptime_seconds` / `in_flight_count`。零 sysmon 依赖、零特权。commhub-server schema 端对齐（commit [`209cac7`](https://github.com/sleep2agi/agent-network/commit/209cac7)），dashboard 渲染 hover card Phase 2（[#119](https://github.com/sleep2agi/agent-network/issues/119) sibling）。跟 [#119](https://github.com/sleep2agi/agent-network/issues/119) host fields 是 sibling 关系（host step 1 ✅ 之前 ship，agent step 2 本 release ship）。

**D. Dashboard 网络节点前端展示升级（Hero 3 — 8/8 surface complete，dashboard `0.5.0`）**
- §3.A prefix-group fix（Vincent #1 catch）
- §3.B sweep retire（旧 sweep 路径并入 grid）
- §3.C recent-panel hide
- §3.D grid default view
- §3.E hover detail card
- §3.F server-health ring tint（接 #99 endpoint）
- §3.G fullscreen mode
- §3.I canvas brand mark
- *(§3.H 砍 per RFC Q2 review)*

随包附 **19+ 轮 typography + 圆角级联 polish**（4 typography family + corner radius cascade 系统化重整）。dashboard `0.5.0` 已通过 npm `latest` tag promote，跟随 v0.10.0 Phase 2 docs sync 落地。

**E. 发布前轻量级测试 playbook（release-gate Phase 1+2）**
[`docs/tests/release-gate-playbook.md`](https://github.com/sleep2agi/agent-network/blob/main/docs/tests/release-gate-playbook.md) — 测试团队 lead 维护，覆盖 hub / dashboard / login / node lifecycle / runtime smoke / vendor verify 等关键路径。本次 v0.10.0 ship 是首次完整跑通该 playbook 的 release，为后续每次 latest promote 卡 release-gate。

### Breaking changes / Migration

- **`codex` runtime 默认行为不变**：仍走 `@openai/codex-sdk` wrapper；要切直 stdio 必须显式 `ANET_CODEX_STDIO_DIRECT=1`。`ANET_CODEX_LEGACY_SDK=1` 之前 preview chain 的 fallback 命名在 latest 改成 opt-in `ANET_CODEX_STDIO_DIRECT=1` 反向开关，含义更直接。
- **agent-node `commhub_report_status` payload 加 `process_telemetry` 子对象**：commhub-server `0.8.2` schema 已对齐；老 server 版本（≤ `0.8.1`）会忽略未知字段不会 fail。
- **`/api/server/:host/health` + `/api/server/:host/agents` 是新 endpoint**：rate limit / auth 行为跟现有 `/api/servers` 同（admin or self-network member），不破坏现有 client。

### Known follow-ups

- ~~**Phase 2 dashboard `0.5.0` promote**~~ ✅ 已 ship（dashboard `0.5.0` 跟随 v0.10.0 Phase 2 docs sync 落地，8/8 Hero 3 surface complete + 19+ 轮 polish）
- **#102 / #103 hang 关闭凭证**（codex direct stdio 路径回归 #102 hang 场景 verify）—— preview chain 内 Phase 1.5 已规划，待 latest opt-in 路径回归 verify 完成关闭。
- **Sessions NETWORK 列显示 bug**（Vincent catch）—— defer 到 v0.10.x patch 或 v0.11.0。
- **#117 `anet project up` detached tmux follow-up**（macOS bun setRawMode 已 #136 修，但 detached 模式 follow-up 仍欠）—— v0.11.0 配套 control 层一起做。

发布流程沿用 [v0.9.0 split-brain lessons #126](https://github.com/sleep2agi/agent-network/issues/126) 的两 phase publish SOP：先 `--tag preview` 上传 tarball + curl verify HTTP 200，再 `npm dist-tag add @<v> latest`。Phase 1 三包（agent-network / agent-node / commhub-server）clean semver promote 完成；dashboard Phase 2 待 §3.D/F/G ship。

---

## v0.9.2 — **Patch: Auth fast-fail + Fan-out retry + Wizard 重做 + #122 default-tmux 回退**（2026-05-16）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.1.15`
- `@sleep2agi/agent-node@2.3.10`
- `@sleep2agi/commhub-server@0.8.1` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.4.6` *(无变化)*

> 发布流程沿用 [v0.9.0 split-brain lessons (#126)](https://github.com/sleep2agi/agent-network/issues/126) 的两 phase publish SOP（先 `--tag preview` 上传 tarball + curl verify HTTP 200，再 `npm dist-tag add @<v> latest`）避免 `npm publish --tag latest` 直推路径在 CDN 异步窗口内的 split-brain；版本号本身用 clean semver（无 `-preview.N` 后缀，便于 `anet upgrade` 比较 + npm range 选择）。

### 5 P0 fix chain

**1. [#129](https://github.com/sleep2agi/agent-network/issues/129) Vendor API auth 快速失败 + vendor-specific URL hint**（[`9840cf3`](https://github.com/sleep2agi/agent-network/commit/9840cf3)）
起因：intern key 过期时 agent-node 之前默默等 120s 才报「claude-agent-sdk 调用超时」通用错误。现在 `isAuthError(msg)` 启发式正则覆盖 Anthropic 标准（401/403、`invalid_api_key`、`authentication_error`）+ intern A02xx 系列（user_token_expired）+ 通用 OpenAI-compat 401 envelope（`unauthorized` / `expired_token`），命中后**短路 retry loop**（用同一个坏 key 重试只是浪费 backoff window）并按 `ANTHROPIC_BASE_URL` 域名 print **vendor-specific URL hint**（intern → `chat.intern-ai.org.cn`、minimax → `platform.minimaxi.com`、anthropic → `console.anthropic.com`、其他 → generic）。从 v0.9.1 之前的 15min 缩到 **<5s** 拿到具体修复 URL。详见 [troubleshooting → Vendor API auth 失败](/troubleshooting#vendor-api-auth-失败401-invalid_api_key-expired_token-intern-a02xx-user_token_expired)。

**2. [#132 Tier 1](https://github.com/sleep2agi/agent-network/issues/132) Fan-out timeout + retry-with-backoff**（同 commit [`9840cf3`](https://github.com/sleep2agi/agent-network/commit/9840cf3)）
[SDK concurrency investigation Phase 3](https://github.com/sleep2agi/agent-network/blob/main/docs/research/sdk-concurrency-investigation.md)：30-agent papercope fan-out demo 下 intern API per-request latency 拉到 17-37s（10-20× 单 agent 1.57s 基线），老 120s timeout 中途 abort 让 25/30 子 agent 静默 fail。两件事：
- `CLAUDE_TIMEOUT_MS` default 120000 → **300000**（300s，给 intern queue drain 留 buffer）
- 新 `CLAUDE_MAX_RETRIES` env var，default `2`（共 3 attempts）；transient error / timeout backoff `4s, 8s + 0-1s jitter`（jitter 散开 herd retries 防一窝蜂打 vendor queue）；auth-class 错误**不** retry（接 #129 fast-fail）

设 `CLAUDE_MAX_RETRIES=0` 退回 v0.9.1 no-retry 行为。

**3. [#133](https://github.com/sleep2agi/agent-network/issues/133) `anet node create` runtime-first wizard**（[`29fd290`](https://github.com/sleep2agi/agent-network/commit/29fd290)）
Vincent catch：老 vendor-first selector 只 enum claude-agent-sdk vendors（intern / MiniMax / Claude / GLM / ...），用 `claude-code-cli` (Anthropic Max plan + 本地 `claude` CLI 登录态) 或 `codex-sdk` (OpenAI `codex auth login`) 的用户**implicitly stuck** —— 必须知道传 `--runtime codex-sdk` 才能 skip vendor picker。新 flow：
1. `selectRuntime()` 3-way picker: `claude-agent-sdk` / `claude-code-cli` / `codex-sdk`
2. `claude-agent-sdk` → 继续走 `selectVendorAndModel()` (existing flow)
3. `claude-code-cli` → print `claude auth login` hint, skip vendor
4. `codex-sdk` → print `codex auth login` hint, skip vendor

backward-compat：显式 `--runtime <X>` 仍 skip picker；demo / batch / 已 `--env` 注入 credential 的 scripted 调用路径不变。

**4. [#136](https://github.com/sleep2agi/agent-network/issues/136) 回退 v0.9.0 #122 默认 detached tmux**（[`a3a3fd4`](https://github.com/sleep2agi/agent-network/commit/a3a3fd4)）
起因：detached tmux + bun claude-code-cli 调 `setRawMode` 在 macOS 触发 `errno 5 (EIO)` —— detached child 的 stdio 不是 real PTY。回退 v0.9.0 短暂引入的 4 条件 wrap 矩阵：
- `anet node start <alias>` → **默认前台**（修 macOS bug）
- `anet node start <alias> --tmux` → `tmux new -As <alias>` **attached** 模式（PTY chain 保持完整不再触发 setRawMode bug）

移除 `--foreground` / `--no-tmux` / `--attach` flag（默认就是 foreground，`--tmux` 自带 attach）。`anet project up` 内部 `startNodeTmuxSession` 路径**仍是 detached**（在 macOS bun 下可能 re-trigger setRawMode，跟进 follow-up 待）。

**5. Wizard 静默退出修复链 [#135](https://github.com/sleep2agi/agent-network/issues/135) / [#138](https://github.com/sleep2agi/agent-network/issues/138) / [#139](https://github.com/sleep2agi/agent-network/issues/139)**
- **#135** Node v24 top-level await warning ([`fa08eb4`](https://github.com/sleep2agi/agent-network/commit/fa08eb4) v3)：dispatch 包进 `async main()` 解决 root cause
- **#138** `@inquirer/prompts + readline ask()` stdin mismatch ([`b8c5885`](https://github.com/sleep2agi/agent-network/commit/b8c5885) preview.5 + [`596cfe9`](https://github.com/sleep2agi/agent-network/commit/596cfe9) preview.6)：wizard `select()` 之后 silent exit 修复 + `launchAgent` await child before parent exit
- **#139** dispatch add await to 5 async commands ([`15cf6de`](https://github.com/sleep2agi/agent-network/commit/15cf6de) preview.7)

跟 #133 runtime-first wizard 配合：让交互式 wizard 在 Node v24 环境跑得稳。

### 6 SOP 升级

- **两 phase publish SOP** 沿用（v0.9.0 split-brain lessons #126）—— 避免 npm `--tag latest` 直推
- **macOS PTY 边界 case** 进入 release smoke checklist（detached tmux + setRawMode）
- **fan-out / 高并发 timeout 调参文档化**：[troubleshooting Vendor API 超时段](/troubleshooting#vendor-api-超时fan-out-高并发-132-retry-with-backoff) + [agent-node.md env table](/guide/agent-node#环境变量)
- **runtime-first wizard 区分 anet create vs --batch**：batch wizard 仍 vendor-first（用 `selectVendorAndModel()` 但不走 `selectRuntime()`），doc 显式消歧
- **CLAUDE_MAX_RETRIES=0 opt-out**：保留退回 v0.9.1 行为路径供调试 / 跑老脚本
- **vendor-specific remediation hint 路由**进入设计原则：每加一个 verified vendor 都附 URL hint

### Breaking changes / Migration

- ⚠ **`anet node start` 默认行为再变**（v0.9.0 → v0.9.1 短暂 detached → v0.9.2 回退前台）：脚本/CI 上 v0.9.1 加的 `--foreground` / `--no-tmux` flag **v0.9.2 已移除**（默认前台无需 flag）；想 tmux 用 `--tmux` opt-in attached 模式
- ⚠ **`anet node create` interactive 行为变**（vendor-first → runtime-first）：scripted `--runtime <X>` 仍 skip picker，**没有 backward-compat 问题**；交互用户体验改善（3 runtime 平等可选）
- ⚠ **`CLAUDE_TIMEOUT_MS` 默认从 120 → 300**：之前显式覆盖到更短超时的脚本不受影响；fan-out 场景默认更宽容
- ✅ **新 `CLAUDE_MAX_RETRIES` env var**：默认 `2`（共 3 attempts）。设 `0` 退回 v0.9.1 no-retry 行为

---

## v0.9.1 — **Patch: #130 intern tool-calling hotfix promote**（2026-05-15）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.1.14` （只升 version 字段，无源码变更；让 `anet upgrade` 看到 v0.9.1 line 跟 agent-node 2.3.9 + dashboard 配套）
- `@sleep2agi/agent-node@2.3.9` （promote [#130](https://github.com/sleep2agi/agent-network/issues/130) hotfix to latest）
- `@sleep2agi/commhub-server@0.8.1` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.4.6` *(无变化)*

### 修复

- **[#130](https://github.com/sleep2agi/agent-network/issues/130) intern-s2-preview tool calling 真打通**（[commit `4cd0024`](https://github.com/sleep2agi/agent-network/commit/4cd0024) ＋ 双 phase publish promote）—— v0.9.0 时 intern-s2-preview 在 Anthropic 协议 `tool_choice: "auto"` 下默认走 verbose Thinking Process 不发 `tool_use` content blocks，强制 `tool_choice` 又被 `-20077` 拒。Hotfix：检测到 `ANTHROPIC_BASE_URL` 命中 `intern-ai.org.cn` / `chat.intern-ai` 时，prepend 一段短 system-prompt bias 让 model 直接发 `tool_use`。curl A/B verified：`stop_reason: max_tokens → tool_use`，`output_tokens: 1024 → 122`。详见 [Vendor 适配层](/concepts/vendor-adapters)（含 5 副作用 + opt-out 路径）。

### 已知 gap 提醒（不阻 promote）

- vendor adapter detection 用 URL regex 检测 vendor —— 自部署 lmdeploy / 走 proxy / 走 aggregator 的 intern endpoint 不命中 bias，需要手动 `--prompt` 复制 bias。详见 [Vendor 适配层 ⚠ 5 副作用](/concepts/vendor-adapters#副作用必读)。
- `--no-vendor-bias` flag 未实现（P1 polish gap，跟 `bias_active` info display follow-up 一起规划）。

### 发布流程

per v0.9.0 split-brain 教训（[issue #126](https://github.com/sleep2agi/agent-network/issues/126)）：两 phase publish 路径

```
1. version bump → preview.N+1
2. npm publish --tag preview     → tarball uploaded
3. curl tarball URL               → HTTP 200 确认
4. npm dist-tag add @<pkg>@<v> latest
5. npm view dist-tags.latest      → "<v>" verified
```

避开 `npm publish --tag latest` 直推路径的 split-brain（CDN 异步同步窗口里 `latest` tag 指向但 tarball 还没分发）。

---

## v0.9.0 — **Recovery & Observability**（2026-05-15）✅ stable

- `@sleep2agi/agent-network@2.1.13`
- `@sleep2agi/agent-node@2.3.8`
- `@sleep2agi/commhub-server@0.8.1`
- `@sleep2agi/agent-network-dashboard@0.4.6`

### 🎯 主题：Recovery & Observability

22 节点 reboot 后的**零键盘恢复闭环** + 默认 toolset 行为透明化 + 服务器级聚合观测。

### 新功能 — Recovery 链

- **`anet project up / restart / down`**（issue [#117](https://github.com/sleep2agi/agent-network/issues/117)）— cwd-wide 节点编排，扫 `.anet/nodes/` 全起 / 全重启 / 全停。共享选项 `--stagger <秒>`（默认 3 错峰）/ `--only a,b,c` / `--exclude x,y`。`down` 给 hub-offline 通知设 2s race timeout 防 hub 自挂场景拖死命令。
- **`anet node create --resume <id>` / `--resume-latest`**（issue [#115](https://github.com/sleep2agi/agent-network/issues/115)）— 创建节点时直接绑定已有 Claude session；TTY 模式下交互式 picker 列 `~/.claude/projects/<cwd>/*.jsonl`（age / size / 60-char 首行预览）。`anet session ls` 用同一份 `listClaudeSessions()` helper。
- **零键盘恢复机制**（[#115](https://github.com/sleep2agi/agent-network/issues/115)）— `anet node start` spawn `claude` 时自动注入 `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999`，跳过 Claude Code 默认 70min session-age 阈值的「Resume from summary / full / Don't ask again」交互弹窗；per-spawn 注入、不污染 `~/.claude/settings.json`、用户显式 export 覆盖；resume 还原完整 session（restart-recovery 不带意外 compaction）。
- **`anet node start` 默认 detached tmux**（issue [#122](https://github.com/sleep2agi/agent-network/issues/122)，⚠ **v0.9.2 已回退**见 [#136](https://github.com/sleep2agi/agent-network/issues/136)）— v0.9.0 短暂引入 4 条件 wrap 矩阵（TTY + `$TMUX` 未设 + 装了 tmux + 同名 session 不存在）+ `--foreground` / `--no-tmux` / `--attach` flag + 两层递归保护。**v0.9.2 回退**：macOS bun 在 detached tmux 下触发 `setRawMode errno 5`（detached child stdio 不是 real PTY），新机制改成默认前台 + `--tmux` opt-in attached 模式（保留 PTY chain）。`anet node stop` 联动 `tmux kill-session` 先于 SIGTERM 仍然保留。
- **`anet upgrade` 4-包 + 双通道 + dry-run + self**（issue [#88](https://github.com/sleep2agi/agent-network/issues/88)）— 覆盖 `anet self` / `agent-node` / `commhub-server` / `dashboard`。Channel auto-detect（prerelease tag → preview，否则 latest）+ `--channel` 覆盖。`--dry-run` 只 print plan。`--self` opt-in detached spawn（默认 print 手动命令避免升级时替换运行进程）。Plan 行带 action badge：`upgrade` / `up-to-date` / `lazy via npx skip` / `self skip` / `lookup failed`。`commhub-server` 行恒显 `PINNED_SERVER_VERSION = 0.8.0` 提醒 `anet hub start` 跑 pinned 不跟全局走。
- **`anet.sh` install / upgrade scripts 同步**（issue [#123](https://github.com/sleep2agi/agent-network/issues/123)）— anet.sh 一键脚本与 npm 双通道对齐 + Node 22.13 engine 校验。

### 新功能 — Runtime 默认行为透明化

- **`claude-agent-sdk` 默认 Claude Code preset 全集**（issue [#101](https://github.com/sleep2agi/agent-network/issues/101) Option B）— 修了 root cause：`config.json` 无 `tools` 字段时 agent-node 设 SDK `options.tools = undefined` → agent 零内建工具 → 幻觉「网络受限」。改成 fallback 到 SDK `{ type: 'preset', preset: 'claude_code' }` sentinel，agent 默认获得 WebFetch / WebSearch / Bash / Read / Write / Edit / Glob / Grep / Task / NotebookEdit 等。`--tools "all"` 路由到同一 preset（去硬编码 8-tool 列表）。
- **行为披露 banner**（[#101](https://github.com/sleep2agi/agent-network/issues/101) Vincent push）— `anet node create` 成功后 print built-in tools + MCP tools + `dangerouslySkipPermissions=true` 警示 + restrict-tools / disable-auto-skip / inspect-current-set hint。`anet info <alias>` 显示 `tools:` + `flags:` 行供随时审计。
- **`anet ls -v` / `--verbose`**（同 [#101](https://github.com/sleep2agi/agent-network/issues/101) 配套）— 每节点多打一行 `tools=...  permGate=on/off`。

### 新功能 — Security hardening

- **Vendor token envRef 模式**（issue [#125](https://github.com/sleep2agi/agent-network/issues/125)，v0.9.0 P0 gate #2）— `config.json` env map 接受 tagged union：`string`（legacy，仍兼容，print 一次性 deprecation banner）或 `{ "_envRef": "VAR_NAME" }`（推荐，secret 留 process.env 永不落盘）。agent-node unset envRef 时**启动直接 FATAL exit** + remediation hint，refuse silent broken。
- **`anet node create` 自动 envRef rewrite** — `saveCreatedNode` 前跑 `rewritePlainSecretsToEnvRef()`：secret 识别启发式（key 后缀 `/_TOKEN|_KEY|_SECRET|AUTH$/` 或 value 前缀 `/sk-|utok_|ntok_|atok_|ak-|gsk_|key-|Bearer/`）任一命中就翻 envRef，原值塞当前 `process.env`（spawn 立即可用）+ print `export NAME='value'` 让用户抄进 `~/.bashrc`。
- **`anet node migrate-token-to-envref <alias>`** — 新命令，已有节点一键迁。备份原文件到 `config.json.bak-<ts>`，rewrite + print export 行；idempotent（非 secret + 已 envRef 不动）。
- **`anet doctor` enumerate plain-secret 节点** — passive 扫描 + 提示走 migrate 命令（不自动 `--fix`，per-node opt-in）。

### 新功能 — Observability

- **`GET /api/servers` REST endpoint**（issue [#119](https://github.com/sleep2agi/agent-network/issues/119)，server 11a3018）— 按 `hostname` + `ip` 聚合 agent + host 实时遥测，dashboard「服务器侧栏」用。返回**裸 JSON array**（非 `{ok, ...}` wrapper）。先 10min stale 标 offline 再聚合；`addNetworkScope` 网络作用域。字段：`hostname` / `ip` / `agent_count` / `cpu_load_1min` / `cpu_cores` / `mem_avail_gb` / `mem_used_gb` / `last_seen`。
- **agent-node host telemetry**（[#119](https://github.com/sleep2agi/agent-network/issues/119) step 1，5364931）— 每次 `report_status` 附带 host 字段。Linux `/proc/loadavg` + `/proc/meminfo` MemAvailable 优先；macOS/Win 兜底 `os.loadavg()` / `os.totalmem()` / `os.freemem()`；Windows `[0,0,0]` 主动 coerce `null`；10s cache 阻断 burst。
- **Dashboard ServersDrawer**（[#119](https://github.com/sleep2agi/agent-network/issues/119) step 3）— Web UI 侧栏展示按物理机聚合的 agent count + CPU / RAM 实时条。
- **Dashboard 拓扑图重做 + 38 轮持续 polish**（issue [#112](https://github.com/sleep2agi/agent-network/issues/112) + [#116](https://github.com/sleep2agi/agent-network/issues/116)）— grid / ring 双视图 + mount fade-in + hover ring focus + click ripple + label scale + arrow tier + offline dim + group-box hover + minimap + cwd tooltip 等 9+ 轮交互细化。

### 文档

- **GitHub README 门面级优化**（issue [#118](https://github.com/sleep2agi/agent-network/issues/118)，commit `2dd646d`）— Hero / Quick start / Demo / CTA 提前；anet vs LangGraph/AutoGen/CrewAI 5×4 对比表；信任信号 4-badge + Star History chart；mermaid 架构图 + 节点接入流程；ZH + EN 双语同步。
- **docs-site catch-up sweep**（issue [#124](https://github.com/sleep2agi/agent-network/issues/124)）— 把今日 ship 的所有新功能批量同步到 anet.sh：`cli.md` / `upgrade.md` / `security.md` / `rest.md` / `CHANGELOG.md` 全部 ZH + EN。

### Breaking changes / Migration

- ⚠ **`anet node start` 默认行为变化（v0.9.0 only，v0.9.2 已回退）** — 从 v0.9.0 起短暂默认 wrap 进 detached tmux（v0.8 是前台跑），但 v0.9.2 via [#136](https://github.com/sleep2agi/agent-network/issues/136) **回退到前台默认**（macOS bun setRawMode bug）。脚本/CI 用 v0.9.1 时仍需 `--foreground` / `--no-tmux`，v0.9.2+ 已默认前台无需 flag；想 tmux 走 `--tmux` opt-in attached 模式。
- ⚠ **`claude-agent-sdk` 节点默认 toolset 变化** — 从空集变成 Claude Code preset 全集（含 Bash / WebFetch / Write 等）。已有节点显式 `tools` 列表保留原行为。新节点请确认是否需要 `--tools Read,Glob,Grep` 显式收窄。
- ⚠ **vendor secret 不再落 `config.json` 明文** — 新建节点自动走 envRef；已有明文节点跑 `anet node migrate-token-to-envref <alias>` 一键迁，过渡期 plain string 仍兼容（deprecation banner 提醒）。
- ✅ **Preview 版本号规则**（[Vincent push](https://github.com/sleep2agi/agent-network/issues/126)）— preview chain 内升 `-preview.N+1` 后缀，**不升 patch 重置 preview.0**，避免版本号「倒退看起来像 downgrade」。

### Smoke validation 必跑（promote 前）

```
1. plain fallback           — 旧 config 含 "sk-..." 仍能启动 + 显示 deprecation banner
2. envRef happy path        — { _envRef: "TEST_TOKEN" } + export TEST_TOKEN=fake → 节点拿到正确 token
3. envRef missing var FATAL — #2 不 export → 启动 FATAL + remediation hint
4. anet doctor 扫描         — 混合 plain + envRef 节点 → 只 plain 入 warning
5. migrate 幂等            — plain → migrate → 再跑无 op + `.bak-<ts>` 存在 + export 行打印
6. anet node create 自动    — `--env ANTHROPIC_AUTH_TOKEN=sk-fake` → config.json 是 envRef，不是字面 sk-fake
```

详见 [issue #125](https://github.com/sleep2agi/agent-network/issues/125#issuecomment-4457630036) 完整可复现步骤。

---

## 2026-05-14 — **v0.8.3 正式版** batch primitive + 多 demo + P0/UX 修复 ✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.1.9`
- `@sleep2agi/agent-node@2.3.1`
- `@sleep2agi/commhub-server@0.8.0` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.4.5`

> 注：agent-network 2.1.8 因早先 stale build 占位跳过，正式版为 2.1.9。

### 新功能

- **`anet create --batch` 批量 agent 原语**（issue [#55](https://github.com/sleep2agi/agent-network/issues/55)）— 一行起 N 个带身份的 agent，`--prefix` 自动编号，每节点独立工作目录 + config + tmux session；配套 `anet batch <verb>` 统一管 lifecycle（list/stop/cleanup/start/restart）。
- **`anet demo sci-team`**（issue [#51](https://github.com/sleep2agi/agent-network/issues/51)）— 科研军团 demo：1 leader + N-1 worker 主动 fan-out 协作。
- **`anet demo pr-review`**（issue [#41](https://github.com/sleep2agi/agent-network/issues/41)）— 4-agent PR review room demo。
- **`anet login` 首次登录引导**（issue [#58](https://github.com/sleep2agi/agent-network/issues/58)）— 认证失败时给出 register / 默认账号 / hub admin reset-user 指引。
- **claude-agent-sdk 模型 dropdown 增加 verified vendor presets**（issue [#48](https://github.com/sleep2agi/agent-network/issues/48)）— MiniMax + 书生 Intern。
- **SDK 升级** — codex-sdk / claude-agent-sdk / inquirer 依赖升级。

### 修复

- **batch 节点身份注入**（issue [#93](https://github.com/sleep2agi/agent-network/issues/93)，P0）— batch 创建的节点之前不知道自己的 alias；现在 per-node 注入身份前缀。
- **`anet hub dashboard` npx 缓存自愈**（issue [#89](https://github.com/sleep2agi/agent-network/issues/89)，P0）— spawn 前自动清理 stale staging dir。
- **`anet hub dashboard` release channel 匹配**（issue [#61](https://github.com/sleep2agi/agent-network/issues/61)）— dashboard 版本号改为按 anet channel 动态匹配。
- **`anet init` token prompt UX + session 计数**（issue [#56](https://github.com/sleep2agi/agent-network/issues/56)）。
- **进程 spawn 移除 shell**（issue [#36](https://github.com/sleep2agi/agent-network/issues/36)）— 消除 command injection 面。
- **claude-agent-sdk env 注入 + timeout guard**（issue [#98](https://github.com/sleep2agi/agent-network/issues/98)，部分修复）— config.json env 块在 `--config` 启动路径正确注入；claude 调用加 wall-clock timeout guard，hang 变可见超时错误。
- **PINNED commhub-server → 0.8.0 stable**。

### 包变更明细

- **agent-network** 2.1.7 → 2.1.9（13 个 preview 迭代累积）
- **agent-node** 2.3.0 → 2.3.1 — claude-agent-sdk / codex-sdk 依赖升级 + #98 修复
- **commhub-server** 0.8.0 *(无变化)*
- **agent-network-dashboard** 0.4.2 → 0.4.5 — 三环 layout / alias 头像 / 全屏 zoom / 前缀分组 / 书生头像 / 标签遮挡修复 / trial badge 删除

---

## 2026-05-12 — **v0.8.2 正式版** telegram channel + claude-code-cli session resume ✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.1.7`
- `@sleep2agi/commhub-server@0.8.0` *(无变化)*
- `@sleep2agi/agent-node@2.3.0` *(无变化)*

**关联**：issue [#13](https://github.com/sleep2agi/agent-network/issues/13) (closed) · issue [#14](https://github.com/sleep2agi/agent-network/issues/14) · commit [143b2a1](https://github.com/sleep2agi/agent-network/commit/143b2a1) (`release: 2.1.7 stable`) · commit [f1e3d9c](https://github.com/sleep2agi/agent-network/commit/f1e3d9c) (`fix(cli): bind claude code sessions on first start`)

### 新功能

- **`anet channel add telegram` 一键接入** — 给已有 node 绑定 Telegram bot token + allow user，自动生成 channels/telegram 配置（细节见 cases/telegram-squad）。

### 修复

- `claude-code-cli` runtime 创建节点时预生成 Claude session UUID。
- 首次启动使用 `claude --session-id <uuid>` 绑定固定 session；检测到本机已有 `~/.claude/projects/<cwd>/<uuid>.jsonl` 后改用 `claude --resume <uuid>` 续会话，避免 `anet node start` 误开新对话。
- `anet node start --new-session` 会生成并保存新的 session UUID。

---

## 2026-05-11 — **v0.8.1 补丁** Dashboard SSE-online 全局修补 ✅ stable

**版本同步**（npm `latest` tag，git tag `v0.8.1`）：
- `@sleep2agi/commhub-server@0.8.0` *(无变化)*
- `@sleep2agi/agent-network@2.1.5`
- `@sleep2agi/agent-network-dashboard@0.4.2`
- `@sleep2agi/agent-node@2.3.0` *(无变化)*

### 修复

- Dashboard `/nodes`、`/admin`、`/api/hub/session` 三处都因为 SSE key 在 v0.7+ 改成 `network_id:alias` 而显示所有 agent 为 offline。0.4.1 的 fix 漏了这 3 处，0.4.2 补齐全局 sse 查询的 alias-fallback 模式。
- CLI 同步 bump `PINNED_DASHBOARD_VERSION` 到 0.4.2，否则 `anet hub dashboard` 仍拉老版。

---

## 2026-05-11 — **v0.8.0 正式版** 🎉 RFC-001 阶段 2 落地 ✅ stable

**版本同步**（git tag `v0.8.0`）：
- `@sleep2agi/commhub-server@0.8.0`
- `@sleep2agi/agent-network@2.1.4`
- `@sleep2agi/agent-network-dashboard@0.4.1`
- `@sleep2agi/agent-node@2.3.0` *(无变化)*

### 鉴权变化

- `COMMHUB_AUTH_TOKEN` 进入软废弃：v0.8 只保留 `/api/*` 读类兼容并打印 warning，v1.0 移除。
- `anet hub start` 首次启动 bootstrap 默认 admin 账户（`admin / anethub` 快速上手默认），把本机恢复用 admin `utok_` 写到 `~/.anet/server/admin-utok.json`（`chmod 600`）。**公网部署立刻 `anet passwd` 改强密码**。
- 第二次起 `anet hub start` 是 idempotent：admin-utok.json 已存在直接跳过 bootstrap，不再 prompt。
- Dashboard 改为浏览器 cookie 透传（thin proxy 起步，完整 0-token 模型留 v0.8.x 后续）。
- tmux / admin 端点强制 admin `utok_`。

### 密码管理

- `anet passwd` 默认交互输入旧密码、新密码、确认密码；保留 `--old` / `--new`。
- 改密成功后当前设备换新 `utok_`，其他设备 `utok_` 自动失效；Agent `ntok_` 不受影响。
- 新增 `anet hub admin reset-user --username <u>`，仅 hub 主机本机恢复普通用户密码，写入 `password_reset_by_admin` 审计事件。
- 用户自选密码最小长度 8 + top-1000 弱密码字典；首次 bootstrap admin 的默认密码不受此限制（≥ 4 即可）。

### Doctor 大幅增强

- `anet doctor --fix` 现在会**主动 probe 每个 node 的 ntok_** 是否被 hub 接受。401/403 自动从当前 utok_ 重新颁发 ntok_，**in-place patch 文件**，session_id / channels / runtime / role 全部保留。这覆盖了"hub DB 被 wipe / token 被撤销" 场景。

### CLI / UX

- `anet hub start` 默认 silent auto-generate，不再 prompt 中断启动。
- `anet login` 输出加 ✅ + 下一步提示；prompt 文案去掉重复冒号 bug。
- 命令行错误信息从 `[anet]` 平淡前缀改为 ✅ / ❌ 视觉标识。

### Dashboard 0.4.1

- 修 Command Mesh 的 `sse:undefined`：SSE key 在 server v0.7+ 改为 `network_id:alias`，dashboard 同步按双层 key 查询，带 alias-only fallback 兼容老 hub。
- light/mint 主题 solid button 修补（从 0.3.4 起）。

---

## 2026-05-10 — **v2.1 正式版** 🎉

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.1.0`
- `@sleep2agi/commhub-server@0.6.0`
- `@sleep2agi/agent-node@2.3.0`
- `@sleep2agi/agent-network-dashboard@0.3.0`

::: tip 安装
```bash
npm install -g @sleep2agi/agent-network
```
不需要再加 `@preview`，默认就是新正式版。
:::

### 这一波带来什么

**🩺 `anet doctor --fix` 自动迁移老 V2 节点**
来自一线踩坑：claude-code-cli runtime 路径上很多 V2 时代的 node config（带 `alias`/`resume`/没 token / hub URL 是 dev IP）跑 V3 hub 直接报 `utok_ but SSE needs ntok_`。doctor 现在能：
- 检测 6 类老 config 问题（字段重命名、runtime 改名、stale hub、缺 token、无前缀 token、缺 node_id）
- 一键 `--fix` 升级，**保留 session 字段不丢对话历史**，重新申请 ntok_

**🪄 `anet demo` 子命令族**
- `anet demo ls` — 列出 demo
- `anet demo debate` — 6 agent 9 步辩论赛
- `anet demo socialmedia` — 4 agent 社交媒体内容工厂（小红书/Twitter/微信/LinkedIn）
- 默认建独立 `demo-<suffix>` network 跑完自动清场，**不污染 default**

**🔧 hub telemetry 修复**
- `POST /api/task` 现在双写 inbox + tasks 表（之前只写 inbox 导致 dashboard Tasks 页空 + send_reply 找不到 task）
- 派任务时立即 UPDATE sessions.task + updated_at（dashboard Overview 实时反映"任务在飞"）

**🎨 dashboard 多主题**
- 4 个主题：Cyber（默认深色）/ Light / Mint / Sunset
- 右下角切换，localStorage 持久化
- 修复 `useSSE` 死循环（之前 hub 收 1500+ admin SSE 把 mcp 拖死）
- 默认 `COMMHUB_URL` fallback 改回 `127.0.0.1:9200`（之前是 leftover dev IP）

**🛠️ CLI**
- `--runtime http-api` 不再错走 claude CLI 分支
- agent-node HTTP runtime 同时识别 `ANTHROPIC_AUTH_TOKEN`（之前只读 `ANTHROPIC_API_KEY`）
- demo 子命令调 createCommand 时不再触发 6 次 "选择 provider" 交互弹窗

**📦 一键部署脚本**
- `hub-only.sh` 重写：4G swap + sudoers NOPASSWD + enable-linger + systemd autostart + AUTOSTART=1
- `agent-only.sh` 同步更新

### 升级路径

```bash
# 1. 升级 CLI
npm install -g @sleep2agi/agent-network    # 或 npm update -g

# 2. 重启 hub（让新 commhub-server 生效）
# tmux 起的: tmux kill-session -t hub; tmux new -d -s hub 'anet hub start'
# systemd-user 起的: systemctl --user restart anet-hub

# 3. 每个老项目目录跑 doctor --fix
cd <project-dir>
anet doctor --fix

# 4. 重启 agent
kill <claude-pid> && anet resume <node-name>
```

详细见 [升级指南](/guide/upgrade)。

---

## 2026-05-03 — `anet demo` 子命令族 + 多个 bug 修复

**版本同步**：anet@2.0.3-preview.4 / agent-node@2.2.0-preview.1 / dashboard@0.2.1-preview.1 / commhub-server@0.5.3-preview.0

### 新功能

- **`anet demo ls`** — 列出可用 demo
- **`anet demo debate`** — 一键 6-agent 辩论赛（主持人/正反 4 辩/评委）
  - `--topic "议题"` 议题（默认交互输入）
  - `--key sk-cp-xxx` MiniMax API key（默认 `$MINIMAX_KEY`）
  - `--quick` 4 步简化版（默认 9 步完整版）
  - `--keep` 跑完保留 6 个临时 agent（默认清掉）
  - `--out path.md` 实录路径
  - 角色个性独立 systemPrompt，跑完输出 markdown 实录
- **`anet demo monitor`**（旧 `anet demo --live` 别名保留）

### Bug 修复

- **anet CLI**：`--runtime http-api` 在 `node start` 时错走 claude CLI 分支 → 改为 spawn agent-node 并显式传 `--runtime`
- **agent-node**：HTTP runtime 加读 `ANTHROPIC_AUTH_TOKEN` env（之前只读 `ANTHROPIC_API_KEY`，导致 MiniMax 配置无法工作）
- **dashboard**：`useSSE` 钩子的 `connect` callback 依赖 `onEvent`，调用方传内联函数导致每次 render 都 reconnect → 用 ref 包装 `onEvent`（修复了"hub 收 1500+ admin SSE"的死循环）
- **hub-only.sh** 一键脚本重写：自动加 4G swap、配 sudoers NOPASSWD、enable-linger、systemd --user 自启（`AUTOSTART=1` 启用）

---

## 2026-04-30 — Parent Task Lineage + Auto-Chain Reply

**commhub-server@0.5.3-preview.0**

修复多 agent 链式调用断链问题：admin → 指挥室 → 主编 时，指挥室 reply 后会话结束，主编返回结果时找不到 admin。

- `tasks` 表加 `parent_task_id` 列 + `chainReplyToParent()` helper
- `send_task` 接受 `parent_task_id`（缺失时根据 caller 最近一个 open task 推断）
- `send_reply` / `report_completion` 自动沿 parent 链向上转发结果
- agent-node 自动注入 `CURRENT_TASK_ID` env，prompt 提示 LLM 必须传 `parent_task_id`

---

## 2026-04-26 — Hub Server Logs Page + V2 Lineage Foundation

**commhub-server@0.5.2-preview.0 / dashboard@0.2.1-preview.0 / anet@2.0.3-preview.1**

- Dashboard 新页面 `/server-logs`：实时查看 hub stdout（最近 N 行 ring buffer）
- REST `GET /api/server-logs`（admin 鉴权）
- Hub banner & `/health` 显示真实 published 版本号

---

## 2026-04-15 — V3 Stable: Multi-Network + User System + Trial License

**Agent Network V3 — Multi-Network + Commercial Ready**（commhub-server 0.5.x、anet 2.0.x）

主要交付：
- **多网络支持**：每个网络隔离 nodes/tasks/sessions
- **用户系统**：用户名+密码注册/登录、JWT、双 Token 体系（utok_ + ntok_）
- **试用授权**：14 天免费试用，授权码激活 Pro
- **39 CLI 命令**：quickstart、login、register、passwd、token、network (CRUD)、status、tasks、doctor、info、logs、demo、config、license、activate、hub start...
- **17 MCP 工具**：send_task/send_reply/retry_task/cancel_task/reassign_task/list_tasks/get_task/...
- **17 REST 端点**：/api/auth/* + /api/networks/* + /api/tasks + /api/nodes + /api/stats + /api/audit-log + /api/license + ...
- **3 种 Runtime**：claude-agent-sdk、codex-sdk、http-api（OpenAI/MiniMax 兼容）
- **审计日志** + **速率限制** + **PostgreSQL 支持**（DbAdapter 接口）

测试：200+ Docker E2E 回归测试覆盖（认证、网络、隔离、token CRUD、SSE 并发、审计）。

---

## v1.0.0-preview.25 (2026-04-11)

### PostgreSQL + Adapter Architecture

**新功能**：
- **PostgreSQL 支持**：`DATABASE_URL=postgres://...` 启用 PostgreSQL（SQLite 仍为默认）
- **DbAdapter 接口**：统一数据库抽象层（SQLiteAdapter + PgAdapter）
- **SQL 自动翻译器**：`sqliteToPostgres()` 处理 datetime->NOW、?N->$N、AUTOINCREMENT->SERIAL
- **34 个 CLI 命令**：新增 passwd、token (create/ls/revoke)、network (info/rename/delete)、demo、config、license、activate、hub start
- **17 个 REST 端点**：新增 PUT /api/networks/:id、DELETE /api/networks/:id、POST /api/auth/password、token CRUD
- **一键 Demo**：`bash examples/demo-one-click.sh` -- 60 秒自动化演示
- **createAdapter() 工厂**：环境驱动的数据库选择

**架构改进**：
- 全部 85+ 个 `db.query()` 调用迁移到 adapter 方法（`db.get()`、`db.all()`、`db.run()`）
- 全部 7 个手动 `BEGIN/COMMIT/ROLLBACK` 事务转换为 `db.transaction()`
- 零原始数据库访问 -- 所有代码通过 `DbAdapter` 接口
- SQL 翻译器处理 4 个源文件中的 161 个 SQL 片段

**测试**：
- 200 个 Docker E2E 测试（137 基础 + 25 认证 + 22 网络 + 16 配置）
- 19 个 adapter 专项 E2E 测试
- 10 个 SQL 翻译器单元测试

---

## v1.0.0-preview (2026-04-10)

### Agent Network V3 -- Multi-Network + Commercial Ready

**新功能**：
- **多网络支持**：创建隔离的网络，每个有独立的 nodes/tasks/sessions
- **用户系统**：用户名+密码注册/登录、API Token 认证
- **试用授权**：14 天免费试用，授权码激活 Pro
- **39 个 CLI 命令**：quickstart、login、register、passwd、token、network (create/ls/use/info/rename/delete)、status、tasks、doctor、info、logs、demo、config、license、activate、hub start...
- **17 个 MCP 工具**：send_task、send_reply、retry_task、cancel_task、reassign_task、list_tasks、get_task...
- **17 个 REST 端点**：/api/auth/*、/api/networks/*、/api/tasks、/api/nodes、/api/stats、/api/audit-log、/api/license...
- **2 种 AI Runtime**：codex-sdk (OpenAI Codex / GPT-5)、claude-agent-sdk (Claude / MiniMax / OpenAI 兼容)
- **审计日志**：所有用户操作 + 任务状态变更记录
- **速率限制**：注册 30/min、登录 10/min per IP

**安全**：
- MCP/SSE/WebSocket 认证
- Server 端强制 network_id（token 绑定，客户端不可覆盖）
- SQL 注入修复（全部参数化查询）
- 网络所有权检查（跨用户访问 403）
- 密码哈希（SHA-256）
- localhost 免速率限制（开发/测试）

**数据库（13 张表）**：
sessions、inbox、tasks、nodes、completions、task_events、users、networks、api_tokens、audit_log、licenses、network_members、network_invites

**测试（200 个回归测试）**：
- 基础 E2E：137 个测试（节点生命周期、消息生命周期、认证、授权、SSE、并发）
- 认证套件：25 个测试（注册、登录、token、profile、密码、审计、速率限制）
- 网络套件：22 个测试（CRUD、隔离、所有权、重命名、删除、跨用户）
- 配置优先级：16 个测试（CLI > env > project > global）
- 真实 AI：Codex (GPT-5) + MiniMax (Anthropic API) 验证
- 10-agent 成语接龙（混合 codex + minimax）

**npm 包**：
- @sleep2agi/agent-network (anet CLI)
- @sleep2agi/agent-node (Agent 运行时)
- @sleep2agi/commhub-server (通信中枢)

---

## v0.x (2026-03 ~ 2026-04-09) -- Pre-V3

### 核心功能建设

- **CommHub Server**：基于 MCP + SSE 的通信中枢
- **agent-node**：双引擎 Runtime（Claude + Codex）
- **anet CLI**：create / start / resume / channel 等基础命令
- **Dashboard**：基础版本
- **消息类型**：task / reply / message / ack 四种类型区分
- **Channel 插件**：Claude Code 接入 CommHub

### 早期里程碑

| 版本 | 日期 | 内容 |
|------|------|------|
| v0.1 | 2026-03 初 | 基础 CommHub + SSE |
| v0.3 | 2026-03 中 | agent-node 双引擎 |
| v0.5 | 2026-03 末 | anet CLI + Channel |
| v0.7 | 2026-04 初 | Dashboard + 消息类型 |
| v0.9 | 2026-04-09 | 多模型支持（MiniMax、书生） |

---

## 未来规划

### v0.9 -- 安全硬化
- 密码哈希升级到 Argon2id（当前 SHA-256）
- `utok_` / `ntok_` TTL + revoke-all
- 安装脚本 checksum 校验
- Dashboard 完整 0-token 模型收尾

### v1.0 -- 清理 + 公开网络
- 完全移除 `COMMHUB_AUTH_TOKEN` 兼容路径
- Token scope (full/agent/readonly) 完整实现
- 公开 / 邀请混合网络（member 申请 + owner 审批流）
- Dashboard 按角色精细化按钮可见性

### 后续探索
- ~~可选 PostgreSQL 后端~~ — adapter 接口保留作扩展点，**v0.8+ 产品方向已转为 SQLite only**（见 [docs/v3-postgresql-design.md banner](https://github.com/sleep2agi/agent-network/blob/main/docs/v3-postgresql-design.md)）
- SSO 集成
- Webhook 回调
- 任务调度（cron）

## 下一步

- [升级指南](/guide/upgrade) — v0.7 → v0.8 行为变化 + 标准步骤
- [架构概览](/guide/architecture) — 各版本是怎么累积成现在这套系统的
- [GitHub Releases](https://github.com/sleep2agi/agent-network/releases) — 每个 git tag 的 release notes
- [RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) — v0.8 ~ v1.0 master token 废弃路线图
