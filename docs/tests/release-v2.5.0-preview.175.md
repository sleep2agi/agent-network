# @sleep2agi/agent-node 2.5.0-preview.175

Since `.174`: 读模型清单**失败时沿用上一次成功的**，不再让一次 3 秒超时把整份清单抹掉。

## Why

`config_snapshot` 是**整份覆盖**写的，不是逐键合并。而读清单要抢同一个 busy 的
opencode server（`/api/provider` + `/api/model` + `/api/model/default`，3s 超时）。
节点一忙，这一次读就会失败 ⇒ 这次心跳里没有 `opencode_catalog`
⇒ 客户端看到「这个节点没有清单」⇒ 回落到「同 runtime 其他节点」的清单。

生产实测（2026-11-01，通信欧 `n_28e6b2c2`）：

```text
opencode-v2-catalog-endpoint.json 存在（0600），三个端点单独调用都 200，
手动跑 readOpenCodeCatalog 立刻拿到 51 个模型 / 6 个 provider / default=deepseek/deepseek-flash
但 nodes.config_snapshot 里没有 opencode_catalog —— 说明心跳那次读失败了
```

于是 admin 在「模型与运行时」里看到的模型列表，不是这台机器报的，而是别的节点报的，
被当成本机的可选项 —— 点下去失败时，谁也说不清是「模型不可用」还是「切换被拒」。

## What changed

- `runtime/opencode-catalog-report.ts` 新增 `keepLastCatalog(previous, next)`：
  这次读失败（`next === undefined`）就用上一份，**并保留它自己的 `seenAt`**
  —— `seenAt` 说的是「这份清单什么时候采的」，不是「这次心跳什么时候」。
- `cli.ts`：模块级 `lastCatalogReport`，成功时更新、失败时返回它。

## Verification

```text
opencode-catalog-report.test.ts            9 pass（新增 3 例：失败沿用 / 成功覆盖 / 从未成功仍 undefined）
report-status-catalog-seen-at.test.ts      5 pass（新增 2 例：**接线**判据，不是只测纯函数）
witness：把 catch 分支改回 `return undefined;`
  ⇒ 接线那两例红（reds=2，同一行为两种判据，记连坐）；其余全绿
bun build 通过
```

## What it does not do

- 不清空「清单确实过期」的判断：`seenAt` 会一直停在最后一次成功采集的时刻，
  这正是客户端该显示的「这份清单有多旧」。要更新它，得等下一次读成功。
- 不改 Hub；不需要同步发 Hub 版本。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.175
```

## Upgrade

```bash
anet node restart <name>
```
