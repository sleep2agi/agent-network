# commhub-server 0.9.0-preview.292

Since `.291`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.292
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.292
# production: 装到新 runtime 目录 → 改 profile 的 HUB_RUNTIME_DIR → pm2 restart commhub-hub → 回读 /health
```

## What changed

```text
#3754  report_status.config_snapshot schema 增加 workdir
        · 根因：zod object 默认**丢弃未知键** —— 节点 .217 已经在报 workdir，
          但 Hub 的 schema 里没有这一格 ⇒ 被静默剥掉 ⇒ nodes.config_snapshot 永不包含它
          ⇒ /api/nodes 的 workdir_state 永远是 not_reported（#5125 的功能等于没生效）
        · 同一个坑此前踩过两次：#3294 build_commit、#1545 心跳字段
```

## Verified

```text
· report-status-workdir-schema 2 pass：workdir 原样保留；超长只丢这一格、model 仍在
· 回归：tool-audience-http（含 #476 每角色字节预算）+ node-workdir-http = 16 pass
· 上线后实测：临时节点从 not_reported 变 reported（带真实路径），验完删除
```

## Not verified

```text
· 真实用户令牌下 owner/部门负责人两档的 reported 正例（此前用 admin utok 只验到 not_reported）
```
