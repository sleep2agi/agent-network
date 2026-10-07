# agent-network 2.3.0-preview.155

配对版本：`PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.155`，`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.123`（见 [`release-v2.5.0-preview.123.md`](./release-v2.5.0-preview.123.md)）。

自 `.154`（发版合并 `5e3c63ec`，#2485）以来，`agent-network/` 有 2 个代码改动（`git log 5e3c63ec..<发版提交> -- agent-network/`）：

| 提交 | PR | 内容 |
|---|---|---|
| 55ec9e15 | #2481 | anet 自带的团队技能安装与 agent-node 同步：启动时把 `~/.anet/skills` 链进运行时的用户级技能目录 |
| 69bae2fc | #2486 | #711：`anet passwd` 默认请求 `keep_cli_tokens`，保留 CLI / 脚本令牌并列出；`--revoke-cli-tokens` 全部撤销；登录 / 注册 / `hub start` 带 `client_kind=cli` |

## 🔴 升级须知

- 🔴 **#2486 的令牌分类与保留在 Hub 端**（commhub-server）。旧 Hub 不认 `keep_cli_tokens`，改密码仍撤销其他全部令牌，anet 会打印 `This Hub does not support keeping CLI tokens`。
- 🔴 （沿用 `.154`）不要把新 Hub 回滚到旧的签发器（#678）。
- （沿用 `.153`）开机脚本要和 CLI 一起更新；（沿用 `.150`）`codex` / `grok` / `claude` 不在系统目录时先配 `daemonExtraPath`；（沿用 `.116`）`secrets.env` 必须是 `0600`。

## 你会看到的变化

- **团队技能进入用户级目录（#2481）。** 见 agent-node `.123` 说明；claude 链到 `~/.claude/skills`，全机生效。
- **改密码保留 CLI 令牌（#2486，#711）。** 新 Hub 上 `anet passwd` 只登出其他登录会话，保留并列出 CLI / 脚本令牌；要一并撤销加 `--revoke-cli-tokens`。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.155 @sleep2agi/agent-node@2.5.0-preview.123
```

## Upgrade

```bash
anet upgrade --channel preview
# 或显式指定：
npm i -g @sleep2agi/agent-network@2.3.0-preview.155 @sleep2agi/agent-node@2.5.0-preview.123
```

两个包一起升级（`agent-network@2.3.0-preview.155 ↔ agent-node@2.5.0-preview.123`）。

## 证据

- #2481：`tests/test9763-team-skills-e2e/`（Docker）。
- #2486：`server/src/auth-password-change-cli-tokens-http.test.ts`（SQLite test798、PostgreSQL test2123）。
- 未在真实生产节点 / daemon 上验证。
