# commhub-server v0.9.0-preview.36 — daemon 远程创建放开共存 runtime

**Channel:** `preview` only

**Date:** 2026-08-28

## 这一版带什么

**① #1376 —— hub 的 `RUNTIMES` 从 3 个放开到 7 个**（Vincent 2026-08-28 定）

daemon 远程创建现在接受全部 7 个 runtime，含三个人机共存的：
`codex-app-server` / `grok-build-cli` / `opencode-cli`。

理由（Vincent 原话大意）：节点不动了的时候，人要能进去跟 Codex / Claude Code 对话排错 ——
attach 是「建好之后」的动作，不是「建的时候」的前提。

🔴 **只升 hub 不够**：daemon 侧配置里的 `runtimes_supported` 也要是 7 个
（旧 daemon 的 config.json 里存的是 3 个）。hub 会强制执行 daemon 自己声明的能力。

**② #1372 —— `runtime_invalid` 现在会说清「允许哪些」和「还有什么路」**

**③ #1374 —— `/api/nodes` 显式给出 `lifecycle_controllable` + `lifecycle_daemon_node_id`**

客户端据此置灰不可用的「停止/重启/删除」按钮，不再靠 id 前缀猜。

**④ #1360 —— `ack_stop_request` 六条出口全部留痕**（与 agent-node .40 的 daemon 侧埋点配对）

**⑤ #1377（若已合入）—— `create_nodes_blocked_reason` 支持四类失败码**

## Install

```bash
npm install -g @sleep2agi/commhub-server@0.9.0-preview.36
```

## Upgrade

生产 hub 走 `~/.local/bin/hub-daemon.sh` 的 RUNTIME_DIR 切换（保留旧目录可回滚）：

```bash
mkdir -p ~/.commhub/runtime-v40-preview36 && cd ~/.commhub/runtime-v40-preview36
npm init -y >/dev/null && npm install @sleep2agi/commhub-server@0.9.0-preview.36
# 备份 DB → 改 hub-daemon.sh 的 RUNTIME_DIR → pm2 restart commhub-hub
```

🔴 升级前照例：`VACUUM INTO` 备份 + integrity_check + 四表计数对照。
🔴 升级后验收不是 /health 200，是**真建一个共存 runtime 的节点并让它完成一次任务**。
