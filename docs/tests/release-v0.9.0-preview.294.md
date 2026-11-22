# commhub-server 0.9.0-preview.294

Since `.293`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.294
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.294
# production: 装到新 runtime 目录 → 改 profile 的 HUB_RUNTIME_DIR → pm2 restart commhub-hub → 回读 /health
```

## What changed

```text
#5321  agy（antigravity）模型清单 / 登录状态：Hub 收下并投影
        · report_status.config_snapshot 增加 agy_models（string[]）与 agy_login_state
          （'logged_in' | 'needs_login' | 'unknown'）；枚举外只丢该格，不拒整份心跳
        · /api/nodes 每行投影 agy_models / agy_login_state；没上报 / 形状不对 / 非 agy 节点 ⇒ null
        · 配套 node .220：节点侧用后台探测（启动一次 + 每 10 分钟）填这两格，读不到一律 unknown
        · App 侧（第三段）据此在 agy 模型选择器里列模型并显示登录状态 —— 不在本版
```

## Verified

```text
· agy-catalog-projection 3 pass（schema 不丢键 / 枚举外只丢该格 / 投影三种情况）
· 回归 tool-audience-http（含 #476 字节预算）13 pass、api-nodes-shape 10 pass
· 上线后实测：/health 版本 + 一台 agy 节点两格有值（真机待验）
```

## Not verified

```text
· 真机 agy 节点的两格实际值（需要一台装 node .220 的 antigravity 节点）
· App 面板（第三段，未开始）
```
