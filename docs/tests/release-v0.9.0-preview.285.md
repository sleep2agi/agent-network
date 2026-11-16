# commhub-server 0.9.0-preview.285

Since `.284`（只发一笔：节点管理授权新增「规则文件」能力）

## Why

admin 2026-11-16：「节点新增权限可以编辑其他人的 AGENTS.md 的管理权限」。
在此之前，正常模式的节点令牌调用 `write_node_rules_file` 可以写**任何**节点的规则文件，Hub 不看目标；
App 里也没有地方授权或收回。

## What changed

```text
#3609  feat(hub)  节点管理授权新增 rules 能力（network / department / node × read / edit）
                  —— GET /api/nodes/:id/grants 的 capabilities 里多了 rules（App 据此显示「规则文件（AGENTS.md）」）；
                     节点令牌写**自己的**规则文件照旧；写**别的节点**的必须有覆盖目标的 rules·edit，
                     否则 rules_write_not_granted；只读节点最多 read（写不了）；人（用户令牌）不受影响。
                     上线前查过生产全部历史：node_rules_requests 里节点令牌发起的写只有 1 次，且写的是它自己 ⇒ 无人受影响。
```

## Verified

```text
· node-grants-http.test.ts 23 pass（新增 6 条：写自己放行；没授权写别人拒；node 范围只放行那一个；
  department 范围覆盖子树；read 级别不能写；只读节点不能写；用户令牌照旧）
· rules-file-duplicate-alias 10、rules-file-session-target 9、rules-file-transport 11、board-grants 11、
  tool-audience-http 13（字节上限未抬）、agent-acl-slice3-http 38 —— 全过
```

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.285
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.285
# production: 用 scripts/deploy-hub-runtime.sh --version 0.9.0-preview.285
#   （它做 装 → 验 → 切 → 回读 → 失败即回滚，并按 docs/runbooks/hub-release-deploy.md 写 build-info.json）
#   注意：anet 主机的 ~/.local/bin/hub-daemon.sh 硬编码了 HUB_RUNTIME_DIR，要改那一行再 pm2 restart。
```

## What it does not do

```text
· 不改读：读别的节点的规则文件仍是 read 类，照旧
· 不改 COMMHUB_NODE_PERMISSIONS 开关（生产仍是 log）；是否改成 enforce 等 admin 决定
```
