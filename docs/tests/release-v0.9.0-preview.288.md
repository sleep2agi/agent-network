# commhub-server 0.9.0-preview.288

Since `.287`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.288
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.288
# production: 用 scripts/deploy-hub-runtime.sh --version 0.9.0-preview.288
#   （装 → 验 → 切 → 回读 → 失败即回滚）
```

## What changed

```text
#3721  #3665 部门范围管理权限（人的范围管理授权）：
        · 新表 user_grants（network_id, user_id, capability, scope_kind, scope_id, level, granted_by, created_at）
          —— 不碰 node_grants：节点与人两套主体，避免 nullable 列区分主体带来的漏判
        · GET/PUT /api/users/:user_id/grants（整份替换）；第一期 capability 只开 manage_nodes，
          scope_kind 只开 network / department，level 只开 read / edit
        · 授权越权在**接口层**挡住：owner/admin 任意范围；部门负责人只能授自己子树内的 department，
          授 network 级或别的部门 → 403 permission_denied
        · /api/nodes 列表按部门范围收窄；单节点读写越界 → 403（不是 404，避免「假装不存在」）
        · 受部门范围约束的人看不到「无部门」节点（按口径：无部门节点只归全局 owner/admin）
```

## Verified

```text
· 单测/HTTP：#3665 相关 5 + 4 条，列表收窄回归 api-nodes-shape 10 pass
· 发版后实测：/health 版本号、/api/users/:id/grants 读写、跨部门 403（本轮上线后核对，NOT_RUN 之前不写「已生效」）
```

## Not verified

```text
· App 侧「给用户设置只管某部门」界面（客户端欧），本版只放 Hub 能力
· 灰度发布 NOT_RUN
```
