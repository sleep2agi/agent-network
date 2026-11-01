# commhub-server 0.9.0-preview.264

Since `.263`: `GET /api/nodes/:id/config` 多一格 `last_update` —— **上一次切模型的结局**。

## Why

2026-11-01 admin 在客户端点「切换模型」，界面回：

```text
已下发 xai/grok-4.7，但 90s 内节点没有以新模型回来。请到它所在机器看日志(anet node logs)。
```

而 Hub 库里当时已经写着真实结局（`node_config_updates`，节点 `n_28e6b2c2`，两次尝试）：

```text
status = 'rejected'
error  = 'OpenCode V2 session is not running; model was not changed'
acked_at 已写
```

客户端不是乱写：这个端点此前只回 `config_revision / model / flags / config_update_capable`，
**没有一处能读到上一次下发的结局**。于是客户端只能靠「revision 有没有涨」推断，
涨不了就只能是 timeout —— **答案在库里，读者拿不到**，还被指去机器上看日志。

## What changed

`GET /api/nodes/:id/config` 新增 `last_update`（无下发记录时为 `null`）：

```text
update_id · status（闭集 pending/restarting/applied/rejected/timeout，闭集外报 unknown）
observed_status（原值，永远给）· terminal · requested_model · error · created_at · acked_at
```

三条规矩写进 `server/src/node-config-last-update.ts`：

1. **闭集外不折叠**：不认识的 status 报 `unknown` 并带出原值，`terminal=false`
   —— 「不知道结没结束」不等于「结束了」。
2. 时间列是 **TEXT 存 ms epoch**（不是 hub 那种无时区字符串），转不出 ISO 就 `null`，
   不允许出现 `Invalid Date`。
3. **不投影 `created_by_token`**：凭据标识不是界面信息。

## Verification

```text
server/src/node-config-last-update.test.ts  11 pass
  · rejected ⇒ 原因原样带出（不是变成 timeout）
  · 闭集外 ⇒ unknown + observed_status + terminal=false
  · 枚举与 terminal 映射不许脱节（三档 false / 三档 true）
  · 时间坏值 ⇒ null 且响应里不出现 Invalid Date
  · 响应里不出现 created_by_token（镜像否定）
  · 接线判据用守卫位置：last_update 必须在 GET /api/nodes/:id/config 那段 handler 里
witness A：删掉响应里的 last_update ⇒ 接线那一例红（其余 10 绿）
witness B：把闭集外折叠成 applied ⇒ 闭集那一例红（其余 10 绿）
```

## What it does not do

- 不改客户端渲染；客户端要用这一格才算真的「给出原因」（已把形状发给通信客户端欧）。
- 不解释「为什么 OpenCode V2 session is not running」—— 那是节点侧另一件事
  （`#3166` 已把这条降级为「重启而不是拒绝」，需节点升级到含该修复的版本）。
- 老 Hub 不返回这一格时，客户端应保持现有行为（不要显示成「没有失败」）。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.264
```

## Upgrade

```bash
anet hub upgrade
```
