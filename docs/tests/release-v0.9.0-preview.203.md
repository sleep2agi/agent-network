# 0.9.0-preview.203

> 权限相关的两件小事：密钥闸门多了一个「未知」原因码，节点白名单能写也能读了。

## 本版

### 1. `secret_transport_unknown`（`#1510`）

```
ANET_SECRET_TRANSPORT_GATE_STRICT=1     # 新增，默认关
  → 关：transport 未上报的节点照旧放行（与 .202 逐字一致）
  → 开：未上报也拒，原因码 secret_transport_unknown
```

口径变了：原来是**拒绝名单**（只拒 `plain`），现在是**允许名单**（只许 `loopback` / `https`），
分歧点 `null` 由上面这个开关显式决定。

默认关的依据是生产数据 —— 373 个会话里 332 个从未上报 transport（89%）。
「未知即拒」当默认，等于打开 `enforce` 当天拦掉近九成节点。

### 2. `GET /api/nodes` 三个只读字段（`#2969`）

```
peer_allowlist   string[] | null     null = 不限制
tool_allowlist   string[] | null     null = 不限制
env_transport    string | null       loopback | https | plain | null
```

两张白名单此前只有 `PUT`，读不回来 —— 客户端做不出「当前设置」这一屏。
`env_transport` 则是给严格模式留的眼睛：不知道谁的 transport 未知，就没人敢打开它。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version        # 0.9.0-preview.203

# 只读字段（用户令牌）
curl -s "localhost:9200/api/nodes?network_id=<net>" \
  -H "Authorization: Bearer <user-token>" | jq '.nodes[0] | {peer_allowlist, tool_allowlist, env_transport}'
```

## 兼容性

无 schema 变更；默认行为与 `.202` 完全一致（两个新开关默认关、三个新字段只读）。

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.203
```

## Upgrade

回滚：`HUB_RUNTIME_DIR` 指回 `.202`。
