# @sleep2agi/agent-network 2.3.0-preview.51 — release notes

这一版的主体是**消息真的送得到**，外加 **daemon 不再恒显示离线**。三条都是当天在生产
环境上量出来的缺陷，不是推演出来的。

- **#1276** — 节点回执的 originator 在内存表未命中时，把「不知道」当成了 `hub`。
  结果是回执要么被拒（`reply_target_mismatch`，任务永远终结不了），要么在收件人恰好
  是 hub 时被静默投进错误频道。改为未命中就省略 alias，让 hub 从 `in_reply_to` 反查。
- **#1277** — hub 的推送**从来没发出去过**：`tasks.status` 被无条件写成 `delivered`，
  而 SSE 推送另被一道「`last_seen_at` 5 分钟内才算 online」的闸挡着。全网省额度规则
  要求 agent 少发状态消息 ⇒ 安静但 SSE 还连着的会话必然老化成 "offline"，推送静默停止。
  拆掉该闸（`pushEvent` 无订阅者时本就 no-op，拿时间戳去闸不增加任何安全性）。
- **#1279** — `list_host_supervisors` 的 `online` 恒为 `false`：SQLite 存的是**无时区
  UTC 串**，裸 `Date.parse` 按宿主本地时区解释，生产机 CST+8 下「距上次心跳」恒算成
  +483 分钟。同时把窗口从 60s 放宽到 5min（agent-node 心跳周期是 3 分钟，60s 的窗口
  即使时区修好也会周期性抖成离线）。
- **#1280** — daemon 生命周期 E2E 进 CI：首次覆盖「同一 daemon 生命周期内、同一子节点」
  的状态交接（`update_node_config` 真的改到子节点磁盘上的 `config.json`，且扛得住
  `restart_node`）。

## Install

```bash
npm install -g bun @sleep2agi/agent-network@2.3.0-preview.51 @sleep2agi/agent-node@2.5.0-preview.37
```

🔴 **`bun` 不能省**：`anet hub start` 是 bun-only（用 `Bun.serve` + `bun:sqlite`，
没有 Node fallback），裸装 anet 后直接起 hub 会停在 `requires the Bun runtime`。

🔴 **两个包配对安装**：`agent-network` 会校验 agent-node 的版本严格等于内置的
`PAIRED_AGENT_NODE_VERSION`，不等就拒绝启动。

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.51 @sleep2agi/agent-node@2.5.0-preview.37
# hub 侧改动要重启 hub 才生效
anet hub restart      # 或按 deploy/dashboard/README.md 的 pm2 方式重启
```

🔴 **#1276/#1277/#1279 都是 hub 侧或节点侧的行为改动，装了包不重启不生效。**
其中 #1277（推送闸）和 #1279（online 判据）在 **hub 进程**里，只升节点没有用。

## 本版包含

| PR | 影响面 |
|---|---|
| #1276 | 节点回执不再误投；`reply_target_mismatch` 类失败消除 |
| #1277 | 安静会话重新能收到推送（可达性根因） |
| #1279 | `list_host_supervisors` 的 online 恢复真实；Dashboard 选服务器可用 |
| #1280 | daemon 生命周期 E2E 进 CI（recovered-suites） |
| #1283 | CLAUDE.md 复核纪律第⑥条 |
| #1285 | daemon 常驻文档（三平台配方） |

## Verification

- 三台真机 daemon（Linux 中继机 / macOS Mac Mini / Windows）在生产 hub 上注册并保持心跳
- 对 relay 上的真 daemon 端到端跑通 `create_node` → 子进程 fork → 子节点自注册 → `stop_node`
- daemon E2E 套件 `PASS=22 FAIL=0`，3 道红门见证

## 已知不支持

- `delete_node` 对**已 stop** 的子节点返回 `ok:true` 但不做清理（daemon 侧 `child not in map`），
  配置目录残留 —— 见 **#1286**，本版未修。
- Windows 上 daemon 常驻需要 WMI `Win32_Process.Create` + `.bat` 包装，见
  `docs-site/docs/deploy/daemon.md` 的「让 daemon 在后台活下去」。
