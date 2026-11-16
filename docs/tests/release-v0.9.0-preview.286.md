# commhub-server 0.9.0-preview.286

Since `.285`（只发一笔：#4616 三期，节点代管「只能收紧」的权限授权）

## Why

admin 2026-11-16 定的权限方案里，节点之间的授权都走 node_grants（能力 × 范围 × 级别）。
#4616 三期补上最后一种：让被授权的节点（Agent）在授权范围内**收紧**别的节点的权限，
例如安全巡检节点发现问题时把某个节点的收件名单缩小、或把它降成只读。只能收紧，不能放宽。

## What changed

```text
#3613  feat(hub)  node_grants 新增能力 permissions（只接受 level=edit；范围 network / department / node）
                  —— 节点令牌现在可以 PUT 别的节点的 inbox-allowlist / permission-mode，前提：
                     · 有覆盖目标的 permissions·edit 授权（只读模式的节点降为 read ⇒ 不行）
                     · 不是改自己（自己改自己 ⇒ reason self）
                     · 确实是收紧：收件名单新值是旧值的子集（旧值 null=不限时任何非空名单都算）；
                       permission_mode 只能 normal → restricted → readonly；
                       !strict（连主人和管理员也挡）既不能删也不能加 —— 那是人的决定
                  —— 被拒：403 node_permission_denied，reason = not_granted / self / not_tightening
                  —— 审计：node_permission_mode_changed / node_inbox_allowlist_changed 带 actor_node_id、
                     via=permissions_grant、「由 X 节点（授权）修改」
                  —— 人（用户令牌）的路径不变；没有新路由、没有新表
```

## Verified

```text
· permission-tightening（纯函数）、permissions-grants-http 15、node-inbox-allowlist-http 25、
  node-permissions-http 56、node-grants-http 23、tool-audience-http 13（字节上限未抬）、agent-acl-slice3-http 38 —— 全过
· 在 COMMHUB_NODE_PERMISSIONS=enforce 下复跑上面三组 HTTP 测试：除一条「log 模式默认行为」的既有用例
  （它本来就假设 log，main 上同样失败）外全过
```

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.286
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.286
# production: 用 scripts/deploy-hub-runtime.sh --version 0.9.0-preview.286
#   （它做 装 → 验 → 切 → 回读 → 失败即回滚，并按 docs/runbooks/hub-release-deploy.md 写 build-info.json）
#   注意：anet 主机的 ~/.local/bin/hub-daemon.sh 硬编码了 HUB_RUNTIME_DIR，要改那一行再 pm2 restart。
```

## What it does not do

```text
· 不允许代管节点放宽任何东西；放宽仍只有人（主人 / owner / admin）能做
· 不进 App「两个问题」的四档；App 只在「高级 → 管理权限」里显示为「权限（只能收紧）」
```
