# test-codex-code-cli — E2E for RFC-005 `codex-code-cli` runtime

**RFC**: [RFC-005 codex-code-cli runtime](../../docs/rfcs/RFC-005-codex-code-cli-runtime.md)
**派单**: 通信龙 → 通信测试马（Primary in test PR / Helper in cli.ts PR）
**目标版本**: agent-network v2.1.8（Vincent telegram 4019+4020 拍板）

## 范围

| 层 | 内容 | 状态 |
|---|---|---|
| L0 | `which codex` + `which anet` | scaffold sanity |
| L1 | `anet hub start` + `/health` + admin login（带 retry） | scaffold sanity |
| L2 | `anet node create x --runtime codex-code-cli` + `config.json` 写盘 + `.runtime == codex-code-cli` | **需 cli.ts ship** |
| L3 | spawn `codex` 二进制 + `mcp_servers.commhub` flag 注入 | **需 cli.ts ship** |
| L4 | `COMMHUB_TOKEN` 环境变量注入到 codex 进程（`/proc/<pid>/environ` 验） | **需 cli.ts ship** |
| L5 | `--ignore-user-config` + `--ignore-rules` 沙箱化 flag（`/proc/<pid>/cmdline` 验） | **需 cli.ts ship** |
| L6 | codex-code-cli + claude-code-cli 两 alias 共存 + admin send_task 跨 runtime 路由（hub-side） | **需 cli.ts ship** |

不覆盖（per [RFC-005 §7.3](../../docs/rfcs/RFC-005-codex-code-cli-runtime.md)）：
- 真实 OpenAI / Anthropic API auth（test env 无 key）
- agent 实际消费 task → 真 LLM 响应（mock 留独立 test，跟 qa-node-02 / docker-e2e SC05 同思路）
- session 续接（resume）— 跟 [test31](../test31-claude-code-cli-resume) 同类逻辑，等 codex 侧支持后另测

## 跑

```bash
sg docker -c 'docker build -t anet-test-codex-code-cli -f tests/test-codex-code-cli/Dockerfile .'
sg docker -c 'docker run --rm anet-test-codex-code-cli'
```

预算：cold ~90s（含 apt + bun + codex npm + anet npm），warm ~25s。

## 当前状态（2026-05-13）

⚠️ **L2+ 现在必 fail** —— `agent-network/bin/cli.ts` L140 `RuntimeName` enum 还没加 `codex-code-cli`（通信工程马 1-2 天内 ship）。

- L0 + L1 现在就能跑（用做 scaffold sanity）
- L2-L6 等通信工程马 cli.ts merge 到 main + preview tag publish 后一次性应 PASS

发版工作流（通信龙 铁律）：
1. 通信工程马 cli.ts PR merge 到 main
2. preview tag publish `@sleep2agi/agent-network@x.y.z-preview.N`
3. 本测试 `sg docker -c 'docker build ... && docker run ...'` 跑通
4. Vincent 亲测 → latest 升级

## 锁住的 RFC-005 契约

| 契约 | 测试断言 |
|------|---------|
| RuntimeName enum 含 `codex-code-cli` | L2 config.runtime 字段 |
| `--config 'mcp_servers.commhub.url=...'` inline 注入 | L3 pgrep cmdline |
| `bearer_token_env_var=COMMHUB_TOKEN` + env 注入 | L4 /proc/environ |
| `--ignore-user-config` + `--ignore-rules` 沙箱化 | L5 /proc/cmdline |
| hub 跨 runtime 路由 alias-agnostic | L6 send_task to codex-bot + claude-peer |

## 资源

- Docker（`sg docker`）
- `node:20-bookworm` + apt（bash/curl/jq/procps/unzip/ca-certificates）
- `bun` via `bun.sh/install`
- `@openai/codex@0.130.0`（pin per RFC-005 §7.1 — 含 `--config` inline MCP 支持）
- `@sleep2agi/agent-network@preview`（等 cli.ts ship）
- 0 OpenAI / Anthropic API calls

## 跟现有测试的关系

| 测试 | 关系 |
|------|------|
| [test31 claude-code-cli-resume](../test31-claude-code-cli-resume/) | claude 侧对称参考（runtime + session resume） |
| [qa-hub-05-roundtrip](../qa-hub-05-roundtrip/) | hub 起 + login + ntok mint + report_status 模式复用 |
| [qa-node-02-success-reply](../qa-node-02-success-reply/) | mock-via-MCP 模式（L6 send_task hub-side 验证） |
| [test32 shell-spawn-audit](../test32-agent-network-shell-spawn-audit/) | 防御纵深（spawn 不带 `shell: true`） — 本测试不重 audit 但 cli.ts 实施需遵守 |
