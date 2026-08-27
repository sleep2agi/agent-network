# @sleep2agi/commhub-server 0.9.0-preview.32 — release notes

🔴 **这一版是 hub 侧的消息可达性修复。`0.9.0-preview.31` 不含它们** ——
`.31` 于 2026-08-27T08:39Z 构建，而下面两条分别在当天 10:56 / 12:xx 才合入 main。
如果你已经把生产 hub 升到 `.31`，**那次升级没有带上这些修复**（字节核对：`.31` 里
`db-timestamp.ts` 不存在、`ONLINE_MS` 仍是 `60_000`、被 #1277 拆掉的 `state === "online"`
闸还在 3 处）。

- **#1277 — 推送从未发出**：`send_task` / `send_message` 把 `tasks.status` 无条件写成
  `delivered`，而 SSE 推送另被一道「`last_seen_at` 在 ONLINE_MS 内才算 online」的闸挡着。
  安静但 SSE 仍连着的会话会老化成 "offline"，推送**静默停止**——同一次发送三行之后给
  observer 的事件却标着 `queued`，hub 自己知道没投出去。本版拆掉该闸（`pushEvent` 在无
  订阅者时本就 no-op，拿时间戳去闸不增加任何安全性），可达性改由订阅者注册表判定。
- **#1279 — `list_host_supervisors` 的 online 恒为 false**：SQLite 存的是**无时区 UTC 串**，
  裸 `Date.parse` 按宿主本地时区解释；生产机 TZ=CST+8 时「距上次心跳」恒算成 +483 分钟。
  本版统一走 `parseDbTimestampMs()`，并把窗口从 `60_000` 放宽到 `5 * 60_000`
  （agent-node 心跳周期是 3 分钟，60 秒的窗口即使时区修好也会周期性抖成离线）。

## Install

```bash
npm install -g bun @sleep2agi/commhub-server@0.9.0-preview.32
```

🔴 **`bun` 不能省**：commhub-server 是 bun-only（`Bun.serve` + `bun:sqlite`，无 Node fallback）。

## Upgrade

```bash
npm install -g @sleep2agi/commhub-server@0.9.0-preview.32
# 🔴 必须重启 hub 进程，装包不重启不生效
pm2 restart <hub-进程名>        # 或按 deploy/dashboard/README.md 的方式
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/health   # 期望 200
```

🔴 **本版两条都在 hub 进程内**。只升级 `@sleep2agi/agent-network` 或 `@sleep2agi/agent-node`
**不会**带来这两条修复——它们是不同的 npm 包。

## Verification

升级并重启后，两条各有一个可直接观察的判据：
- **#1279**：`list_host_supervisors` 对一台心跳正常的 daemon 应返回 `online: true`
  （升级前恒为 `false`）
- **#1277**：一个安静超过 1 分钟、但 SSE 仍连着的会话，应能收到新任务推送
  （升级前会被静默跳过）

## 本版包含

| PR | 影响面 |
|---|---|
| #1277 | 安静会话重新能收到推送（消息可达性根因之一） |
| #1279 | daemon 不再恒显示离线；Dashboard「选服务器」可用 |

## 已知不支持

- Windows 上的 host_supervisor daemon 无法 fork 子节点（#1290，属 agent-node 侧）
- `delete_node` 对已 stop 的子节点返回 `ok:true` 却不清理（#1286，修复在 #1292 待合）
