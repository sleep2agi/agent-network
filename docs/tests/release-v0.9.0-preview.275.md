# commhub-server 0.9.0-preview.275

Since `.274`: 修 `GET /api/token-usage` 在**不传 network_id** 时与 `/api/providers` 给出相反答案。

## 现场（`.274` 上线后立刻发现）

```text
同一用户、同一页：
  GET /api/providers     → 200（自动回退到唯一所属网络）
  GET /api/token-usage   → 400 network_required
```

## 根因

`resolveRestNetworkScope()` 在 `authCtx` 为 null 时返回
`{ networkId: requested || null, networkIds: null }` ——
这里的 `networkIds: null` **不是**「属于所有网络」，而是「这份 scope 没有成员信息」。
上一版把 null 当成「拿不到」，于是直接 400。

## What changed

```text
server/src/server.ts —— /api/token-usage 的作用域解析改三档（信息量从高到低）
  ① restScope.networkId             显式参数 / 节点绑定 / 管理员指定
  ② restScope.networkIds 长度 == 1   普通用户只属于一个网络
  ③ 前两档都拿不到 ⇒ 退回 getUserNetworkIds(这个人) 再判一次唯一性
```

## Verification

```text
server/src/token-usage-http.test.ts  6 pass（新增 1 例）
  · 不传 network_id ⇒ 200，且 network_id == 自己的网络
  · 镜像断言：回退到的**不是** stranger 的网络（防「回退到任意一个」）
  · 节点令牌 403 user_token_required · 别网络成员 403 且无 nodes · 无令牌 401
  · total = input + output，cache 单列（596 倍时这条才刺眼）
  · coverage.capable_nodes 严格小于 sessions_with_version
```

## 顺带（同一批进 main 的测试口径修正，不属于本包行为变化）

`list_tasks` 键集两处补 `server_time`；`visibleAgents` 查询预算 3→4（#3432 多一条常量查询）；
`daemon-inherited-env` 补齐与 `hub-daemon.sh` 的差异 5 个名字（#620）。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.275
```

## Upgrade

```bash
anet hub upgrade
```

## What it does not do

- 不改 `/api/token-usage` 的响应字段（仍含 coverage 四数）
- 不改变「节点令牌读不到用量」这条边界
