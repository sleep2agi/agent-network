# `anet create --batch` + `anet batch <verb>` — 批量 agent 工作流

> Phase 1 scaffold per issue [#55](https://github.com/sleep2agi/agent-network/issues/55).
> 该文档跟 cli `--help` 同步，是 user-facing surface 的 source of truth；
> 命令实现见 `agent-network/bin/cli.ts` `createBatch` / `batchLifecycle`。

## 一句话

`anet create --batch` 批量起 N 个 agent，prefix 自动编号，每个 agent 一个独立工作目录 + config + tmux session；之后用 `anet batch <verb> <prefix>` 统一管 lifecycle。

## Quick start

```bash
# 一行起 5 个工程师 agent，用 Claude Haiku
anet create --batch \
  --preset claude-haiku-4-5 \
  --api-key sk-ant-... \
  --prefix 工程师 \
  --count 5

# 看现在跑着哪些 batch
anet batch list

# 全部停下
anet batch stop 工程师

# 彻底删（停 + rm -rf 工作目录）
anet batch cleanup 工程师 --workdir ~/anet-team
```

不带 flag 直接跑 `anet create --batch` 进 wizard 一项项问。

## Wizard 字段

| 字段 | flag | 默认 | 说明 |
|------|------|------|------|
| Vendor preset | `--preset <key>` | (prompt) | vendor key（见下方 `VENDORS` 列表），未列入的 provider 走 `custom` 自己填 baseUrl + model |
| API key | `--api-key <key>` | (prompt) | `ANTHROPIC_AUTH_TOKEN` 写入每个 node 的 `env` |
| Workdir | `--workdir <path>` | `~/anet-team` | 父目录 |
| Workdir mode | `--workdir-mode <mode>` | `separate` | `separate` = `<workdir>/node{i}/.anet/nodes/<alias>` 每 node 一个子目录；`shared` = 全部 N 个 node 写同一个 `<workdir>/.anet/nodes/<alias>` |
| Prefix | `--prefix <name>` | (prompt) | alias 前缀，e.g. `工程师` → `工程师1号`, `工程师2号`, ..., `工程师N号` |
| Count | `--count <N>` | (prompt) | `1-50`；超过 20 会 stderr 警告 memory/ulimit 风险 |
| Description | `--description <text>` | (prompt) | `systemPrompt` 内容；空串则不写 systemPrompt |
| Leader alias | `--leader-alias <name>` | (off) | 可选；设了→ `i=1` 用这个 alias 标 `role: "leader"`，剩下 `count-1` 个走 `${prefix}{1..N-1}号` 当 worker |

env vars 也认 `ANET_BATCH_API_KEY` 当 fallback。

## Vendor preset 列表（`VENDORS` registry）

R104-B 校准：`--preset` 现在接受的是 **vendor key**（不再是 model id）。`anet create --batch` 跟 `anet create` / `anet node create` 共用同一个 `selectVendorAndModel()`（`cli.ts:1230`）+ `VENDORS` registry（`cli.ts:1114-1175`）。旧的 `MODEL_PRESETS` / `PROVIDER_CHOICES` / `BATCH_PRESETS` 三套结构已合并删除（见 `cli.ts:1083-1085` 注释）。

| `--preset` key | Runtime | 内置模型 | baseUrl |
|--------|---------|-------|---------|
| `intern` | `claude-agent-sdk` | intern-s2-preview（默认）/ intern-s1-pro | `https://chat.intern-ai.org.cn`（裸域名）|
| `minimax` | `claude-agent-sdk` | MiniMax-M2.7 | `https://api.minimaxi.com/anthropic` |
| `mimo` | `claude-agent-sdk` | mimo-v2.5-pro（默认）/ v2.5 / v2-pro / v2-omni | `https://token-plan-cn.xiaomimimo.com/anthropic` |
| `anthropic` | `claude-agent-sdk` | claude-sonnet-4-6（默认）/ claude-opus-4-6 / claude-haiku-4-5 | Anthropic 原生 |
| `codex` | `codex-sdk` | gpt-5.4（默认）/ o3 | (需 `codex auth login`) |
| `claude-code` | `claude-code-cli` | 用 Claude Code 订阅模型 | (需 Claude 订阅) |
| `custom` | `claude-agent-sdk` | 自己填 model id | 自己填 baseUrl |

每个内置 vendor 的 baseUrl + model id 都 verified-with-real-call 才进 `VENDORS` 列表。`--preset` 为兼容旧用法也接受旧的 model id（如 `--preset intern-s1-pro`），cli.ts 自动 resolve 回对应 vendor。不带 `--preset` 走交互式 vendor 选单（先选供应商，再在该供应商的内置模型里选）。

## Lifecycle — `anet batch <verb>`

```bash
anet batch <verb> [<prefix>] [--workdir <path>]
```

| Verb | 作用 | Phase 1 状态 |
|------|------|---------------|
| `list` | 列所有 tmux session group by 第一个 `-` 分隔 | ✅ 跑得起；**已知噪声**：会把 host 上任何 `${something}-${rest}` 形式的 tmux session 都算成一个 group。Phase 2 计划加 `~/.anet/batches.json` marker registry 后过滤干净 |
| `stop <prefix>` | kill 所有 `${prefix}-*` tmux session | ✅ 干净 |
| `cleanup <prefix> --workdir <path>` | `stop` + `rm -rf <workdir>/node*` + 删空 `<workdir>` | ✅ 干净 |
| `start <prefix>` | re-launch | ⚠️ Phase 1 是 hint-only：提示重跑 `anet create --batch`。in-place supervisor 留 Phase 2 |
| `restart <prefix>` | `stop` + `start` | ⚠️ 同上，`stop` 走完 `start` 是 hint-only |

> 想"重启所有节点"目前的可靠做法：`anet batch stop <prefix>` → `anet batch cleanup <prefix> --workdir <path>` → 重新跑 `anet create --batch`。Phase 2 会让 `restart` 直接复活已存在的 config，不需重跑 wizard。

## Output 结构

`workdir-mode=separate` (默认)：

```
<workdir>/
├── node1/
│   └── .anet/nodes/<alias-1>/
│       └── config.json     # runtime / model / token / env / systemPrompt / team? / role?
├── node2/
│   └── .anet/nodes/<alias-2>/...
└── node{N}/...
```

`workdir-mode=shared`：

```
<workdir>/
└── .anet/nodes/
    ├── <alias-1>/config.json
    ├── <alias-2>/config.json
    └── ...
```

tmux session 命名是 `${team || prefix}-${alias}`：

```
$ tmux ls
工程师-工程师1号
工程师-工程师2号
工程师-工程师3号
sci-team-研究Leader     # `anet demo sci-team` 走的同款 batch primitive
sci-team-研究员1号
...
```

## `anet demo sci-team` — preset wrapper 示例

`anet demo sci-team` 现在是 batch primitive 的一个 *preset wrapper*，user-facing surface 跟 PR #53 preview.7 保持 bit-identical：

```bash
anet demo sci-team --count 10 --intern-api $INTERN_API_KEY --dir ~/intern-s
```

内部相当于：

```bash
anet create --batch \
  --preset intern-s1-pro \
  --api-key $INTERN_API_KEY \
  --workdir ~/intern-s --workdir-mode separate \
  --prefix 研究员 --leader-alias 研究Leader \
  --count 10 \
  --description '<sciTeamPrompt active fan-out template>'
```

差别是 sci-team 自带 `team="sci-team"` 标签 + `role="leader|worker"` 字段 + `sciTeamPrompt` 主动 fan-out 模板（详见 RFC-008）。通用 batch 不带这些字段，systemPrompt 走用户 `--description` 输入。

> 老的 `anet demo sci-team --stop|--restart|--cleanup` 仍然能跑，但会 stderr 一条 deprecation 警告，指向新的 `anet batch <verb> sci-team`。下一个 major 会移除 legacy flag。

## Phase 1 限制 + Phase 2 路线

| 限制 | 现在表现 | Phase 2 计划 |
|------|----------|---------------|
| `anet batch list` 噪声 | 群组 host 上**所有** `${a}-${b}` tmux session，包括非 anet | `~/.anet/batches.json` marker registry 写入 `createBatch` 时，list 时过滤 |
| `restart` / `start` in-place | hint-only：提示重跑 wizard | 走 `<workdir>/node*/.anet/nodes/<alias>/config.json` 重新 spawn tmux |
| 多 prefix list 过滤 | 全部 group 一起返 | `anet batch list <prefix>` filter |
| Cross-batch 任务路由 | 不做 | RFC-008 Phase 3+ |

## 关联

- 上游 issue：[#55](https://github.com/sleep2agi/agent-network/issues/55)
- 同源 primitive 来历：[#51 科研军团 demo PR #53](https://github.com/sleep2agi/agent-network/pull/53)（generalized）
- 长程协调协议：[RFC-008 multi-agent team convention](rfcs/RFC-008-multi-agent-team-convention.md)
- Vendor preset 真值锚：[commit 1bc03c0](https://github.com/sleep2agi/agent-network/commit/1bc03c0)
