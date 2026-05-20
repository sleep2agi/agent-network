# 批量 Agent：`anet create --batch` + `anet batch <verb>`

> 对应 v0.8.3 起正式发布的 batch primitive（issue [#55](https://github.com/sleep2agi/agent-network/issues/55)）。已在 npm `latest` tag，不需要装 `@preview`。本页从 `agent-network/docs/batch.md` 迁移到 docs-site，作为线上用户文档。

## 一句话

`anet create --batch` 会批量创建 N 个 agent：按 prefix 自动编号、写入每个 node 的 `config.json`、启动对应 tmux session。之后用 `anet batch <verb> <prefix>` 统一管理 stop / cleanup / list。

## 快速开始

```bash
# 安装 / 升级到 latest（batch 自 v0.8.3 起在 stable）
npm install -g @sleep2agi/agent-network

# 一次创建 5 个工程师 agent
anet create --batch \
  --preset claude-haiku-4-5 \
  --api-key sk-ant-... \
  --prefix 工程师 \
  --count 5

# 查看 batch tmux group
anet batch list

# 停止全部工程师节点
anet batch stop 工程师

# 停止并删除默认 separate-mode 工作目录
anet batch cleanup 工程师 --workdir ~/anet-team
```

不带 flag 直接执行 `anet create --batch` 会进入 wizard。

## Wizard 字段

| 字段 | flag | 默认 | 说明 |
|------|------|------|------|
| 供应商 / 模型 | `--preset <key>` | 不传则走交互式 **vendor 选单**（共用 `selectVendorAndModel()` —— ⚠ batch wizard 仍 vendor-first，**跟 `anet create` v0.9.2+ 的 runtime-first wizard 不一样** [#133](https://github.com/sleep2agi/agent-network/issues/133)；先选供应商再选模型。v0.10.5-7 incremental UX 增强已 ship：workdir mode prompt（[#152](https://github.com/sleep2agi/agent-network/issues/152)）/ silent-exit 修（[#155](https://github.com/sleep2agi/agent-network/issues/155)）/ codex-sdk batch path yolo flags parity（[#156](https://github.com/sleep2agi/agent-network/issues/156)））| `--preset` 接受 vendor key（`intern` / `minimax` / `mimo` / `anthropic` / `codex` / `claude-code` / `custom`）；为兼容旧用法也接受旧的 model id（如 `intern-s1-pro`，会自动 resolve 回对应 vendor）|
| API key | `--api-key <key>` | 交互输入 | 写入每个 node 的 runtime auth token —— **codex-sdk / claude-code-cli runtime 自动跳过 API key prompt**（v0.10.5 [#153](https://github.com/sleep2agi/agent-network/issues/153) — 用户改去 `codex auth login` / `claude auth login`）|
| Workdir | `--workdir <path>` | `~/anet-team` | 父目录 |
| Workdir mode | `--workdir-mode separate\|shared` | `separate` | `separate` 每个 node 一个子目录；`shared` 所有 node 写同一个 `<workdir>/.anet/nodes` |
| Prefix | `--prefix <name>` | 交互输入 | alias 前缀，例如 `工程师` → `工程师1号` |
| Count | `--count <N>` | 交互输入 | `1-50`；超过 20 会提示内存 / ulimit 风险 |
| Description | `--description <text>` | 交互输入 | 写入 `systemPrompt`；空则不写 |
| Leader alias | `--leader-alias <name>` | 关闭 | 设置后第一个 node 用该 alias 且 `role=leader`，其余为 worker |

`ANET_BATCH_API_KEY` 可作为 `--api-key` fallback。

## 内置供应商（`VENDORS` 列表）

`anet create --batch` wizard 走 `selectVendorAndModel()`（cli.ts `VENDORS` 列表）—— 跟 `anet create` 单节点 wizard **共用同一个 vendor 选单实现**，但 `anet create` v0.9.2 起 [#133](https://github.com/sleep2agi/agent-network/issues/133) 顶部加了 runtime-first picker（batch v0.10.8 仍未加 — runtime-first picker 排期 v0.11+ batch wizard 重构），所以 batch 仍是 vendor-first；`--preset <vendor-key>` 直接选定供应商：

| `--preset` key | Runtime | 内置模型 | Base URL |
|--------|---------|-------|----------|
| `intern` | `claude-agent-sdk` | intern-s2-preview（默认）/ intern-s1-pro | `https://chat.intern-ai.org.cn`（裸域名）|
| `minimax` | `claude-agent-sdk` | MiniMax-M2.7 | `https://api.minimaxi.com/anthropic` |
| `mimo` | `claude-agent-sdk` | mimo-v2.5-pro（默认）/ v2.5 / v2-pro / v2-omni | `https://token-plan-cn.xiaomimimo.com/anthropic` |
| `anthropic` | `claude-agent-sdk` | claude-sonnet-4-6（默认）/ opus-4-6 / haiku-4-5 | Anthropic 原生 |
| `codex` | `codex-sdk` | gpt-5.5（默认）/ o3 | （需 `codex auth login`）|
| `claude-code` | `claude-code-cli` | 用 Claude Code 订阅模型 | （需 Claude 订阅）|
| `custom` | `claude-agent-sdk` | 自己填 model id | 自己填 base URL |

每个内置 vendor 的 `baseUrl` + model id 都 verified-with-real-call 才进 `VENDORS` 列表。DeepSeek / GLM / Kimi / OpenRouter 等不在列表的 provider 走 `--preset custom` 手填。

> 兼容性：`--preset` 也接受旧的 model-id 值（如 `--preset intern-s1-pro`），cli.ts 会自动 resolve 回对应 vendor。

## Lifecycle：`anet batch <verb>`

```bash
anet batch <verb> [<prefix>] [--workdir <path>]
```

| Verb | 作用 | Phase 1 状态 |
|------|------|---------------|
| `list` | 列出当前 tmux session group | 可用；已知噪声：会把 host 上形如 `${a}-${b}` 的非 anet tmux session 也列出 |
| `stop <prefix>` | kill 所有 `${prefix}-*` tmux session | 可用 |
| `cleanup <prefix> --workdir <path>` | `stop` + 删除 `<workdir>/node*` | 对默认 `separate` 模式干净 |
| `start <prefix>` | 重新启动 | Phase 1 hint-only，提示重新跑 `anet create --batch` |
| `restart <prefix>` | `stop` + `start` | `stop` 可用，`start` 仍是 hint-only |

::: warning shared mode cleanup 限制
`--workdir-mode shared` 会把配置写到 `<workdir>/.anet/nodes/<alias>/config.json`。当前 `cleanup` 只自动删除默认 separate-mode 的 `<workdir>/node*`，shared-mode 残留配置需要手动 `rm`。Phase 2 会通过 `~/.anet/batches.json` registry 做安全清理。
:::

## 目录结构

默认 `workdir-mode=separate`：

```text
<workdir>/
├── node1/.anet/nodes/<alias-1>/config.json
├── node2/.anet/nodes/<alias-2>/config.json
└── nodeN/.anet/nodes/<alias-N>/config.json
```

`workdir-mode=shared`：

```text
<workdir>/.anet/nodes/
├── <alias-1>/config.json
├── <alias-2>/config.json
└── <alias-N>/config.json
```

tmux session 命名是 `${team || prefix}-${alias}`，例如：

```text
工程师-工程师1号
工程师-工程师2号
sci-team-研究Leader
sci-team-研究员1号
```

## `anet demo sci-team` 的关系

`anet demo sci-team` 是 batch primitive 的 preset wrapper，用户入口保持兼容：

```bash
anet demo sci-team --count 10 --intern-api "$INTERN_API_KEY" --dir ~/intern-s
```

内部相当于：

```bash
anet create --batch \
  --preset intern-s1-pro \
  --api-key "$INTERN_API_KEY" \
  --workdir ~/intern-s \
  --workdir-mode separate \
  --prefix 研究员 \
  --leader-alias 研究Leader \
  --count 10
```

差异是 sci-team 自动写入 `team="sci-team"`、`role="leader|worker"` 和科研综述 prompt。

老的 `anet demo sci-team --stop|--restart|--cleanup` 仍能跑，但会打印 deprecation warning，建议迁移到 `anet batch <verb> sci-team`。后续 major 可能移除 legacy flag。

## Phase 1 限制

| 限制 | 当前表现 | 后续方向 |
|------|----------|----------|
| `batch list` 噪声 | 会列出部分非 anet tmux session | 加 `~/.anet/batches.json` registry |
| `start` / `restart` | hint-only | 从已有 config 重新 spawn tmux |
| 精确清理 shared mode | 需手动删除 | registry 后安全清理 |

## 关联

- Issue [#55](https://github.com/sleep2agi/agent-network/issues/55)
- 科研军团 demo PR [#53](https://github.com/sleep2agi/agent-network/pull/53)
- RFC-008: [multi-agent team convention](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-008-multi-agent-team-convention.md)
