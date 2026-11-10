# commhub-server 0.9.0-preview.258

Since `.257`: two of the Hub's authorization and read-visibility gaps become **readable** —
「改节点安全配置」的授权判据收敛成一条具名门，`register` / `login` 的限流与锁定命中变成计数。

## Why

这两件事的共同点是：它们原本都只写在代码里，没有任何数能让人看出「现在是不是对的」。

- 同一句授权语义曾以**两种写法**并存（手写四条件 / 具名函数 `canRestWriteNetwork`）。两者在调用点
  长得一样，而强度差在被调函数里：后者放行任何非 viewer 成员。所以「统一写法」若选错方向，就是
  把「改节点白名单」降到「往网络里发东西」的强度 —— 而现有夹具全是 owner/admin 探针，放宽不会让
  任何测试变红。
- `register` / `login` 是**故意匿名**的两条路由（注册与登录发生在有身份之前），所以「有没有身份门」
  这个判据对它们不成立。它们的健康度只能从「限流与锁定实际拦了几次、打到了几个不同来源」看出来。

## What is added

### 1. `canRestWriteNodeSecurity(...)` —— 一条具名门

| 判据 | 结果 |
|---|---|
| Hub 管理员 | 放行 |
| 节点主人（即使已不是该网络成员） | 放行 |
| 网络 owner / admin | 放行 |
| member / viewer / 陌生人 / 无身份 | 拒绝 |

四条路由改调它：`PUT /api/nodes/:id/permission-mode`、`/tool-allowlist`、`/rest-allowlist`、
`/peer-allowlist`。行为等价（逐条核对 `isAdmin` 短路与 `owner_user_id` 为 null 的情形）。

守卫：`scripts/check-node-security-write-gate.py` —— 四条路由都必须在**自己那个 if 块**里调具名门、
全文件不得再有手写四条件、具名函数与它的测试必须同时在位。块边界用花括号计数取，不用行窗口。

### 2. `GET /health → counters.auth_abuse`

```json
{ "since": "…",
  "register_rate_limited_total": 0, "login_ip_rate_limited_total": 0, "login_locked_total": 0,
  "distinct_register_limited_ips": 0, "distinct_login_limited_ips": 0,
  "distinct_locked_usernames": 0, "distinct_capped": false }
```

为什么去重数必须和命中数**一起**给：`register` 的限流键是 IP ⇒ 命中数 ≫ 去重 IP 数 = 单点在撞，
两者接近 = 换 IP 绕过（键选错了单位）；`login` 的失败锁定键是**用户名** ⇒ 命中数 ≫ 去重用户名数
= 有人在锁死某一个账号。只给命中数时，这两种情形完全同形。

两份 IP 集合（register / login）**不合并**：两者阈值与窗口不同，合并会让「哪个入口在被撞」
退化成一个数，而两者的修法相反。`distinct_capped` 只在真的丢过一条时置真 —— 之后 `distinct_*`
是下界，不是真值。快照里不含 IP 或用户名本身。

## What it does not do

它不会改变任何现有授权结果，也不会开始拦截更多请求 —— 这一版把**已有的**判断换成可机械检查的
名字，把**已有的**拦截换成可读的数。真正的限流阈值与锁定窗口没有改。

## Verification

- `node-security-write-gate.test.ts` 6 例（矩阵 + 孤儿节点 + 与 `canRestWriteNetworkAsHuman` 不等的显式断言）
- `auth-abuse-counters.test.ts` 9 例（含「同一来源 5 次 ⇒ 命中 5 / 去重 1」、「capped 后 distinct 只是下界」、
  「快照里没有来源本身」）
- `node-permissions-http.test.ts` + `create-node-validate.test.ts` 94 例
- `health-redaction.test.ts` 93 例（`/health` 键集与 meta 双向投影仍在）

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.258
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.258
# hub run by pm2 (production profile)
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-258 pm2 restart <name> --update-env
```

回读：

```bash
curl -s http://127.0.0.1:9200/health | jq '.counters.auth_abuse'
```
