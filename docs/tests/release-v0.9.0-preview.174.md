# 0.9.0-preview.174

> 首次 retention sweep 的延迟从 60 秒改成 **180 秒**：`.173` 上线后实测，60 秒仍在部署风暴里。

## 1. 为什么 60 秒不够（#2614 / PR #3116）

```
18:55:24  boot（372 sessions / 148 SSE 同时重连）
18:55:38  stall 20.6s (served 812)
18:56:24  retention（+60s）swept 3894ms, max 1238ms
          telemetry=2964 行 / 2935ms = 0.99ms/行    ← 稳态 0.24ms/行
18:56:26  stall 2.7s · 18:57:28 stall 3.4s · 18:57:31 stall 2.6s   ← 风暴 2 分钟后仍在
```

⇒ 60 秒时风暴没排空，`max` 单批被推到 1,238ms（越过 1 秒慢 SQL 阈值）。
改为默认 **180 秒**（`COMMHUB_RETENTION_FIRST_DELAY_MS` 可覆盖，0 = 立即）。

整点的每小时 sweep 与首次延迟无关，仍在启动后 60 分钟。

## 2. 一次完整部署风暴的记录（runbook）

18:55 那次部署的完整时间线（含 RSS 4.4 GB、`/health` 超时一次、6 分钟后自行排空、
未触发 6 GiB 上限）已写入 `docs/runbooks/hub-memory-and-sse.md`，并附三条判据：

1. 部署后 0–6 分钟的延迟指标全部不可用；
2. 用「每行单价」对照，别用总时长（4.2 ms/行 vs 0.24 ms/行 ⇒ 环境，不是语句）；
3. 启动期的工作要主动避开风暴（回填、首次 sweep 都有延迟开关）。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.174
commhub-server --version   # 0.9.0-preview.174
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.174
commhub-server --version   # 0.9.0-preview.174
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.174` 后 `npm install`，
指到新目录再重启；`runtime-v173-preview173` 保留即可回滚，无数据迁移。

## 验收

```bash
# 部署后 3 分钟内不应看到 retention 行；第 3 分钟出现，且 max 应回到 ~250ms 量级
grep "commhub retention" ~/.commhub/pm2-hub-out.log | tail -2

# 部署后 6 分钟内 /health 不应超时
curl -sS --max-time 8 http://127.0.0.1:9200/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["version"], d["event_loop"].get("stall_count"))'
```

回滚：`HUB_RUNTIME_DIR` 指回 `runtime-v173-preview173` 并重启；无 schema 变更。
