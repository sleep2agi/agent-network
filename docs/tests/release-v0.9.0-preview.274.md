# commhub-server 0.9.0-preview.274

Since `.273`: **修 `GET /api/token-usage` 自 `.273` 上线起一直 500**，并给响应加覆盖率分母。

## Why（一个两天没人发现的 500）

`.273` 发布后，这个端点的所有「验证」都通过了：

```text
① 表里的行对不对       → 脚本直读 SQLite        ✓
② 增量累加对不对       → 对账 0 误差（三列逐位） ✓
③ 权限对不对           → 节点令牌打 → 403       ✓
```

而实际请求：

```text
GET /api/token-usage → 500
[serve-error] id=… getNetworkId is not defined
```

③ 最要命：403 走的是 handler **前面**的分支，根本没执行到 500 那一行。
⇒ 「权限正确」不蕴含「功能可用」。

## What changed

```text
server/src/server.ts
  · 作用域改用 handler 顶部已解析的 restScope.networkId
    （它已判过成员资格，denied 分支在上面统一 return 403）
    —— 上一版调了一个本文件里不存在的 getNetworkId()，就是这个 500 的来源
  · 响应新增 coverage：{ reporting_nodes, capable_nodes,
                          sessions_with_version, sessions_without_known_version }

server/src/node-token-usage.ts
  · readTokenUsage 的行类型补 cache_read_tokens（SELECT 有它、类型没有）
    ⇒ 运行期 r.cache_read_tokens 是 undefined，totals 会变 NaN
  · reportsTokenUsage(version) 三态：true / false / null（解析不出版本线就不猜）
```

## 为什么加 coverage（一个分母问题）

生产实测：203 个 agent-node 里**只有 1 个 >= .180**（会报 token），其余停在 .164/.146。
于是表里只有 1 行 —— 那不是「系统没工作」，是「几乎没有节点拥有这个能力」。

两个解释在报表上完全同形，处置却相反（查故障 vs 升级节点），所以分母必须一起返回。

## Verification

```text
server/src/token-usage-http.test.ts  5 pass（新增）
  · 本人网络：两行，total = input + output，cache 单列且 != total（596 倍）
  · 节点令牌 → 403 user_token_required
  · 别的网络成员 → 403 且响应里没有 nodes
  · 没令牌 → 401（不是空表）
  · coverage：capable 只数 >= .180，且严格小于 sessions_with_version
witness：阈值改 999 ⇒ 版本判定两例立刻红（可隔离）
tsc：无新增类型错（server 存量 145 → 144）
```

## 线上复现与验收（部署后跑）

```bash
# 修复前：500  {"error":{"code":-32603,"message":"getNetworkId is not defined"}}
# 修复后：200
curl -s -H "Authorization: Bearer <用户令牌>" \
  "http://127.0.0.1:9200/api/token-usage?since_hours=24" | head -c 200

# 顺带：全站 GET 路由不许 5xx（#3969 探针）
ANET_PROBE_TOKEN=<用户令牌> python3 scripts/probe-rest-500.py
```

## What it does not do

- 不改变上报口径（写入侧仍是 `.181` 起的 claude/codex/opencode 三路）
- 不让旧版节点上报：覆盖率的提升只能靠升级节点（各自换钉子 + 重启）
- 不修 `turns` 在 opencode 上「不适用」这件事（那是读数标注，脚本侧已标 `turns*`）

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.274
```

## Upgrade

```bash
anet hub upgrade
```
