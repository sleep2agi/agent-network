# 版本规划（living doc）

> **各版本的迭代范围（冻结的功能清单）** 见 [docs/version/](../version/)：[版本矩阵](../version/README.md) · [v0.11.0](../version/0.11.0/) · [v0.10.16](../version/0.10.16/)。本文只保留通道状态与政策。

> 最后更新：2026-08-14（`npm view` 实测）。Owner：release ops。版本号**怎么读**（npm 版号 vs bundle tag 两套体系）见 [versioning](../../docs-site/docs/guide/versioning.md)。

## 当前已发布状态

**这张表是 `npm view <pkg> dist-tags` 的映射**，浮动。改前用 `npm view` 核一遍。

| 通道 | @sleep2agi/agent-network | @sleep2agi/agent-node | @sleep2agi/commhub-server | 说明 |
|---|---|---|---|---|
| **latest**（稳定） | 2.2.21 | 2.4.13 | 0.8.8 | 4 个 stable runtime；⚠ 带 Windows 跨盘 `anet --version` 崩溃（#446） |
| **preview** | **2.3.0-preview.39** | **2.5.0-preview.31** | **0.9.0-preview.29** | 迭代中：Windows 修复 + `codex-app-server` flag + OpenCode `1.18.1`。preview 还额外暴露 `codex-app-server` / `opencode-cli` 两个 runtime。**promote 门禁** = 全 Linux 门禁真绿 + Windows 复验 PASS + 审计发现的 stop 孤儿窗（OpenCode 节点 stop 可留 detached ACP 孤儿）修复合入并复跑受影响门禁。 |

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

- 🔴 **门禁证据只认 runner 在候选树之外生成的报告**：候选 commit 内自带的 docs/tests 报告一律视为
  作者自证、不得作为验收输入（2026-07-16 实案：发布依据误采了 commit 自带旧报告，真实门禁当时并未全绿）。

- 发 preview 永远不动 `latest`；promote 是刻意的两阶段动作。
- 每个 preview promote 前必须真机验证（Linux Docker E2E 测不出 Windows 专属的坏——原因见 #447）。
