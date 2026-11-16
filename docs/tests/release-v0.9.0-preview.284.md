# commhub-server 0.9.0-preview.284

Since `.283`（只发一笔 Hub 修复：派单「从不取走」闸误拦已恢复的节点）

## Why

admin 2026-11-16 报：给 TMA客户端欧 等节点派单一律 409 `target_never_consumes`，界面显示「未送达」，
但节点在线、最近还回过消息，只能 `pm2 restart commhub-hub` 清零才恢复。11-15 断网之后同时有 14 个节点被这样拦住。

## What changed

```text
#3603  fix(hub)  neverConsumeGate 的内存计数只数「最后一次回复之后」的过期
                 —— 内存桶以前只有 count + lastAt：只要回复后再过期一条，回复前攒的全部复活
                    （TMA客户端欧：内存 4 = 回复前 3 + 回复后 1；库里回复后只有 2，仍被拒）。
                    现在每个节点记最近 16 次过期时刻（recent_at），闸只数晚于 last_reply_at 的那几条，
                    与 DB 证据同一条边界；旧快照（无 recent_at）退回原计数。
                    拒绝体新增 last_reply_at，便于排障；recent_at 不进诊断读数。
```

## Verified

```text
· expiry-counters.test.ts 26 pass（新增 4 条：回复前 3 + 回复后 1 ⇒ 放行；回复后 3 ⇒ 仍拒且带 last_reply_at；
  旧快照退回整桶计数；recent_at 封顶 16）
· expiry-evidence-db 7、task-expiry-notice-http 6、health-redaction 94、mcp-write-network-resolution 30、
  node-health-dispatch-http 21、reply-bare-infer-4315 2 —— 全过
```

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.284
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.284
# production: 用 scripts/deploy-hub-runtime.sh --version 0.9.0-preview.284
#   （它做 装 → 验 → 切 → 回读 → 失败即回滚，并按 docs/runbooks/hub-release-deploy.md 写 build-info.json）
#   注意：anet 主机的 ~/.local/bin/hub-daemon.sh 硬编码了 HUB_RUNTIME_DIR，要改那一行再 pm2 restart。
```

## What it does not do

```text
· 不改阈值（3）与 2 小时时效；不改 DB 证据的判据
· 「回复」仍只认 tasks 表里 replied / completed 的行；只用 send_message 回话的节点不算回复
· 不处理 TMAI负责人 这类真不消费的节点（它会继续被拦，这是对的）
```
