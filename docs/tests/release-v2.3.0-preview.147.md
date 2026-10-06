# agent-network 2.3.0-preview.147

配对版本：`PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.147`，`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.114`（见 [`release-v2.5.0-preview.114.md`](./release-v2.5.0-preview.114.md)）。

自 `.146`（发版合并 `30ecfc86`，#2411）以来，`agent-network/` 有 2 个改动（`git log 30ecfc86..origin/main -- agent-network/`）：

| 提交 | PR | 内容 |
|---|---|---|
| ecb5a3f0 | #2422 | #448 回归：`anet node start` 检查共存会话的 `CODEX_HOME` 时按字节读 `/proc`，中文名节点不再被拒 |
| 6513d5b8 | #2419 | #602：从没对话过的 Codex 共存节点，`anet node stop` 之后能再次 `anet node start` |

## 你会看到的变化

- **Codex 共存节点停了能再起（#2419）。** 以前一个 Codex TUI 共存节点如果还没聊过一句，`anet node stop` 之后再 `anet node start` 会一直报 `pending Codex thread is not bound to the exact private previous-generation marker`，只能删了重建。现在如果那个线程在本节点的 `CODEX_HOME` 里没有任何会话记录，启动时会丢掉它、开一个新线程并在日志里说明；有会话记录的线程仍按原规则拒绝，不会接管别人的线程。聊过的节点 stop → start 照旧恢复原线程。Windows 不变。
- **中文名的共存节点能正常启动（#2422）。** `anet node start` 核对共存会话的 `CODEX_HOME` 时，以前把 UTF-8 当 latin1 读，中文路径永远对不上；现在按字节严格解码（与 agent-node `.114` 是同一份代码）。
- 配对的 agent-node 升到 `.114`：daemon 能真正停掉 / 删除共存节点、Mac 上找得到 Homebrew 工具、超时统一按毫秒、起 app-server 前看内存负载、上报 codex 登录指纹，详见 agent-node 说明。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.147 @sleep2agi/agent-node@2.5.0-preview.114
```

## Upgrade

```bash
anet upgrade --channel preview
# 或显式指定：
npm i -g @sleep2agi/agent-network@2.3.0-preview.147 @sleep2agi/agent-node@2.5.0-preview.114
```

两个包一起升级（`agent-network@2.3.0-preview.147 ↔ agent-node@2.5.0-preview.114`）。

## 证据

- #2419：`codex-pending-thread-restart.test.ts` 17 个测试；新 Docker 套件 `tests/qa-codex-copresence-stop-start`（真 Hub + 真 codex + 私有 tmux socket）origin/main PASS=25 FAIL=9 → 修复后 PASS=34 FAIL=0。
- #2422：test745 agent-network 单测 PASS（含两份 `codex-home-enforce.ts` 一致性检查）。

## promote 时的 must_contain

`"version": "2.3.0-preview.147"`
