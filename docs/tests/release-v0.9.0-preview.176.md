# 0.9.0-preview.176

> **回滚版本**：撤销 `.175` 的「首次 sweep 等循环安静」（#3119）。`.175` 在生产上**启动即崩**（pm2 重启 164 次），本版只是把它拿掉。

## 1. 发生了什么

```
20:32  部署 0.9.0-preview.175
       健康检查读到的版本仍是 0.9.0-preview.174
       pm2 describe commhub-hub → status online, restarts 164, uptime 20s
20:38  回滚 HUB_RUNTIME_DIR → runtime-v174-preview174 → /health 恢复 0.9.0-preview.174
```

**线上影响**：约 6 分钟不可用（`.174` 的运行时目录保留着，回滚只换指针，无数据变更）。
CI 的 167 项检查全绿 —— 因为单元测试不经过「bun 启动整个 server」这条路径。

## 2. 本版内容

- 撤销 `#3119`（`firstSweepShouldWait` / `waitForQuietLoop` / 对 `mcp-inflight`、`event-loop-lag` 的顶层导入）；
- 行为回到 `.174`：首次 sweep 固定延后 180 秒。

## 3. 根因（未确认，写在这里不猜）

`retention.ts` 新增的两个顶层 `import`（`./mcp-inflight.js`、`./event-loop-lag.js`）最可能构成
启动期循环依赖。待用 bun 在临时端口复现拿到真实堆栈后再决定是修还是永久放弃这条路径。

## 4. 未完成的验收

`#2614` 的「首次 sweep 避开风暴」仍是**未解决**：60 秒、180 秒两次实测都被更长的风暴盖过。
回滚不等于放弃，但不带着未验证的启动路径改动上线。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.176
commhub-server --version   # 0.9.0-preview.176
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.176
commhub-server --version   # 0.9.0-preview.176
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.176` 后 `npm install`，
指到新目录再重启；`runtime-v174-preview174` 保留即可回滚，无数据迁移。

## 验收

```bash
curl -sS --max-time 8 http://127.0.0.1:9200/health \
 | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["version"], d["sessions_count"], d["event_loop"].get("stall_count"))'
# 期望：0.9.0-preview.176 且能持续返回（不是 .174）
```

回滚：`HUB_RUNTIME_DIR` 指回 `runtime-v174-preview174` 并重启。
