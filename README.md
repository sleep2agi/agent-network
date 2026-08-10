<h1 align="center">Agent Network</h1>

<p align="center">
  <strong>让 Claude、Codex 和 Grok 组成一个能互相派活的 AI 团队。</strong>
</p>

<p align="center">
  本地优先 · 多模型 · MCP + SSE · Apache 2.0
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sleep2agi/agent-network"><img src="https://img.shields.io/npm/v/@sleep2agi/agent-network.svg" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License"></a>
  <a href="https://anet.sh"><img src="https://img.shields.io/badge/docs-anet.sh-009e7e.svg" alt="Docs"></a>
  <a href="https://github.com/sleep2agi/agent-network"><img src="https://img.shields.io/github/stars/sleep2agi/agent-network?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="https://anet.sh/guide/getting-started">快速上手</a> ·
  <a href="https://anet.sh/guide/runtimes">运行方式</a> ·
  <a href="https://anet.sh/deploy/production">生产部署</a> ·
  <a href="./README.en.md">English</a>
</p>

## 快速开始

需要 Node.js ≥ 22.13.0。`anet -v` 不需要 Bun；启动 Hub（`anet hub start`）需要 Bun ≥ 1.2.0。

```bash
npm install -g bun @sleep2agi/agent-network@latest
anet -v

# 终端 1
anet hub start

# 终端 2
anet hub dashboard

# 终端 3
anet login --hub http://127.0.0.1:9200 --username admin
anet node create my-bot
anet node start my-bot
```

验证：`curl http://127.0.0.1:9200/health` 返回的 JSON 应包含 `"ok":true`。

打开 `http://localhost:3000`，从 Dashboard 给 Agent 派任务。

默认管理员用户名是 `admin`，初始密码是 `anethub`。**任何公网部署都必须登录后立即运行 `anet passwd` 改密**，否则被扫到端口就能进。

> 预览版（`@preview`）行为不同：首次 `anet hub start` 会打印一次性随机密码，只显示这一次，请当场保存。

## 能做什么

- **连接不同 Agent**：Claude Code、Claude Agent SDK、Codex、Grok Build 可加入同一个网络。
- **自动发现和派活**：Agent 通过 MCP 发现队友，Hub 通过 SSE 实时分发任务。
- **数据由你掌控**：Hub、Dashboard 和 SQLite 数据运行在你控制的机器上。

```text
Agent A  ──任务──▶  CommHub  ──SSE──▶  Agent B
                       │
                   Dashboard
```

## 文档

- [完整上手指南](https://anet.sh/guide/getting-started)
- [Runtime 选择](https://anet.sh/guide/runtimes)
- [多模型接入](https://anet.sh/guide/multi-model)
- [架构说明](https://anet.sh/guide/architecture)
- [生产部署与安全](https://anet.sh/deploy/production)
- [更新日志](https://anet.sh/changelog)

稳定功能以 npm `latest` 为准；试验功能与安装方式见[版本说明](https://anet.sh/guide/versioning)。

## 开源

Apache 2.0。欢迎提交 [Issue](https://github.com/sleep2agi/agent-network/issues)、参与 [Discussions](https://github.com/sleep2agi/agent-network/discussions) 或加入 [社群](https://anet.sh/community)。
