# commhub-server 0.9.0-preview.287

Since `.286`（只发一笔：#4987 只读收件箱端点，让「inbox_pending=N」这件事可核实）

## Why

Hub 一直能算出 `inbox_pending = N`（Dashboard / 节点状态里都有），但**没有任何接口能列出那 N 条**。
结果是：运维看到「某节点有 3 条未读」却无法回答「那 3 条到底是什么、谁发的」；
节点侧更糟 —— 调用 `get_inbox(别人)` 会拿到 `{ ok:false, error:"inbox_identity_mismatch" }`，
而调用方把这个 `ok:false` 当成「空列表」，于是「0 条」是个假象（#4987 的 B 项）。

这一版只加**一个只读端点**，不新增写接口：标已读仍然复用现有的 `ack_inbox`。

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.287
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.287
# production: 用 scripts/deploy-hub-runtime.sh --version 0.9.0-preview.287
#   （装 → 验 → 切 → 回读 → 失败即回滚，按 docs/runbooks/hub-release-deploy.md 写 build-info.json）
#   注意：anet 主机的 ~/.local/bin/hub-daemon.sh 硬编码了 HUB_RUNTIME_DIR，必要时改那一行再 pm2 restart。
```

## What changed

```text
#3639  feat(hub)  GET /api/inbox?alias=<alias>&limit=<n>
        —— 只读、只列 acked=0、按 created_at DESC + id DESC 稳定排序
        —— 鉴权与 get_inbox / ack_inbox 共用 resolveInboxCaller：
           · 节点令牌读自己 → 200；读别人的 alias → 403 { ok:false, error:"inbox_identity_mismatch" }
           · 用户令牌 owner/admin 代读同网络 alias → 200，响应带 scope:"delegated"
           · 跨网络（目标 alias 不在调用方网络内）→ 403，且只看 delegated，不看 alias 是否改了名
        —— 响应：{ ok, alias, pending, returned, scope, messages:[{ id, from, at, preview, acked, is_task }] }
           · pending  = 未读总数（单独 COUNT，不受 limit 影响）
           · returned = 本次返回条数（pending >= returned 恒成立）
           · at       = ISO-8601 UTC（带 Z）
           · preview  = 按码点截断 <=200，超长追加单个「…」，换行折叠成空格
        —— 代读时查询去掉 `network_id IS NULL OR`：不把没有 network_id 的历史行带进别人的收件箱
           （读自己时保留该分支 —— 老数据没写 network_id，仍属本节点自己）
```

## 实现中抓到的两个坑（写下来免得重复）

```text
① 判「是不是节点令牌」不能用 `!!networkId && !userId` —— 节点令牌同时带 userId（代表其主人），
   会被当成用户令牌走 owner 分支 ⇒ A 能用自己令牌读到 B 的收件箱（实测 200）。必须用 nodeIdentity(tokenId, networkId)。
② delegated 不能用 `canonical !== requested` 判 —— canonical 就是请求值规范化后的结果，两者恒等，
   恒 false ⇒ scope 永远 self，代读被静默；跨网络检查也因为套在同一个条件里永远走不到。
   正解是语义直说：只有「节点令牌读自己」「username 等于请求」是 false，其余一律 true。
```

## Verified

```text
· inbox-caller-delegated.test.ts         7 pass   resolveInboxCaller 的 delegated 语义（owner/自有节点=true，节点令牌读自己/同名用户=false）
· inbox-endpoint-4987-http.test.ts       9 pass   HTTP 端到端：双向跨网络 403、代读剔除 NULL 行、limit=1 时 pending>returned、at 为 ISO、preview 201 码点
· inbox-endpoint-4987.test.ts            3 pass   纯判定 helper（scope / at / 跨网络拒绝）
· user-inbox-by-agent-http.test.ts       9 pass   回归
· task-network-resolution-http.test.ts   5 pass   回归（需独立库；同进程跑多文件会串库）
· 通信客户端欧 独立复跑 5/5 全绿（d747e2b2），含「代读剔除 NULL 行」「跨网络 403」
```

## Not verified

```text
· 生产 `/health` 的 node_grants / inbox 相关字段未变，但本版仍未做灰度发布验证（NOT_RUN）
· 客户端 UI（把 inbox_pending 做成可点开）不在本版：App 仓单独提，随下个 App 版本发
```
