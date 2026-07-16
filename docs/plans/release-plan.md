# 版本规划（living doc）

> **各版本的迭代范围（冻结的功能清单）** 见 [docs/version/](../version/)：[版本矩阵](../version/README.md) · [v0.11.0](../version/0.11.0/) · [v0.10.16](../version/0.10.16/)。本文只保留通道状态与政策。

> 最后更新：2026-07-16。Owner：release ops。版本号**怎么读**（npm 版号 vs bundle tag 两套体系）见 [versioning](../../docs-site/docs/guide/versioning.md)。

## 当前已发布状态

| 通道 | @sleep2agi/agent-network | @sleep2agi/agent-node | 说明 |
|---|---|---|---|
| **latest**（稳定） | 2.2.21 | 2.4.13 | 4 个 runtime；⚠ 带 Windows 跨盘 `anet --version` 崩溃（#446） |
| **preview** | **2.3.0-preview.34** | **2.5.0-preview.26** | canonical：全部 Windows 修复 + codex-app-server flag + OpenCode 1.18.1 全门禁（7/7 Linux + 真 Windows 复验）|

## 进行中 → 下一个 preview（canonical，`.34` / `.26`）

**draft PR [#454](https://github.com/sleep2agi/agent-network/pull/454) 已出**（base 含全部 Windows 修复），等门禁重跑 + Windows 复验后单点发布。内容：

- **全部 Windows 修复**（真机验证过）：`fileURLToPath`（#446）、codex-app-server 启动派发、`where`/`shell:true` spawn、agent-node `isAbsolute` 配置路径（#447）
- **`--codex-app-server-url` / `--codex-thread-id`** 建节点 flag（RFC-030），并收紧 runtime guard
- **OpenCode（RFC-029）**：恢复 vetted `opencode-ai@1.18.1` pin + release-gate 产物
- **MCP 上下文**：commhub 回复 status 语义写进 agent 说明（[详见](../sop/agent-reply-to-dashboard.md)）

门禁：release ops 跑 Linux/OpenCode CI 门禁 → 真 Windows 机器验证 → 单点发布（不再两人并行发 `@preview`）。

## 接下来的稳定版

- **2.2.22（latest 补丁）**：把 #446 Windows 崩溃修复 cherry-pick 回 2.2.21 基线，让稳定版 Windows 用户不再崩。卡点：先定位 2.2.21 基线 commit（没打 git tag）+ owner 拍板。
- **2.3.0（下一个 minor）**：canonical preview 泡够 + UAT 确认后，整线 promote 成 latest（preview-first 政策）。

## 政策提醒

- 发 preview 永远不动 `latest`；promote 是刻意的两阶段动作。
- 每个 preview promote 前必须真机验证（Linux Docker E2E 测不出 Windows 专属的坏——原因见 #447）。
