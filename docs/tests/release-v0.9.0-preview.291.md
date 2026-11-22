# commhub-server 0.9.0-preview.291

Since `.290`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.291
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.291
# production: 装到新 runtime 目录 → 改 profile 的 HUB_RUNTIME_DIR → pm2 restart commhub-hub → 回读 /health
```

## What changed

```text
#5125  /api/nodes 每行新增 workdir + workdir_state（app#1528 / fork 向导依赖）
        · workdir        节点上报的真实项目目录（config_snapshot 的 flags.workdir → flags.cwd → workdir）
        · workdir_state  reported | not_reported | forbidden
            reported      有权查看且节点上报了 → workdir 有值
            not_reported  有权查看但还没上报   → workdir 为 null（「节点旧」，提示升级节点）
            forbidden     无权查看             → workdir 为 null，且响应里没有任何路径线索
        · 判定逐行：owner/admin/网络级授权可见；部门负责人（本人负责部门含子部门）或被授部门范围仅本子树；
          其余（普通成员、节点令牌）一律 forbidden —— **默认拒绝**，不套用列表可见性那条「零授权不额外拦」的口径
        · workdir 比「节点在不在列表里」敏感得多（暴露文件系统路径 / 项目结构），所以判定单独写
```

## Verified

```text
· node-workdir 单测 3 pass：读取顺序 / 坏形状一律当没上报 / forbidden 即使有路径也不带出去
· node-workdir-http 3 pass：owner（reported + not_reported）、部门负责人（本部门 reported / 别部门 forbidden 且响应体不含该路径）、普通成员（一律 forbidden）
· 回归：api-nodes-shape 10 pass、user-grants-http 4 pass
· 发版后实测 /health 与 /api/nodes 三态（上线后核对）
```

## Not verified

```text
· 真机上「节点真的上报了 workdir」这一格：需要装了会上报 workdir 的 node 版本
· App 侧 app#1528 的 UI 不在本版
```
