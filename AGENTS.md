# Agent Network — Codex 规则

## 测试规则

- **分层测试，从简单到复杂**：环境→认证→单点通信→完整流程→多用户→安全
- **前一层不过就不跑后面的**：被依赖的原子能力必须先验证可靠
- **所有测试在 Docker 里跑**：不碰本地环境，不改生产
- **测试结果保存**：docs/tests/report-testN.txt
- **每个测试套件独立 Dockerfile**：可并行构建和运行
- **Docker 权限**：用 `sg docker -c '...'` 执行 docker 命令

## 开发规则

- **不频繁发 npm preview**：本地源码开发，大版本完成时统一发
- **不改本地全局 npm 包**：只改 git 仓库源码
- **Docker 先验证**：所有改动 Docker E2E 通过后再合并
- **向后兼容**：旧 atok_ token 仍然有效

## 项目结构

- `server/src/` — CommHub Server (Bun + SQLite)
- `agent-network/bin/cli.ts` — anet CLI (39 命令)
- `agent-node/src/cli.ts` — Agent 运行时 (4 runtime: claude-agent-sdk / claude-code-cli / codex-sdk / grok-build-acp)
- `tests/testN-xxx/` — 独立 Docker 测试套件 (每个有 Dockerfile + run.sh)
- `docs/` — 设计文档 + 测试报告

## 通信

通过 CommHub MCP 工具通信。收到任务直接执行，完成后回复结果。
