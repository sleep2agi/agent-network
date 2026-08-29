# @sleep2agi/agent-node 2.5.0-preview.52 — release notes

两条修复，一条守启动、一条修 Windows。

- **一个可选遥测字段的形状分歧，不再弄死整个节点**（PR #1506）。启动注册是顶层
  `await register()` 且没有 catch，所以 `report_status` 被拒会让**整个进程退出**。
  `0.9.0-preview.42` 修的是当时那次具体分歧（`host.ip`）；这一条修的是**形状** ——
  hub 与 agent-node 独立发版，谁先升都可能出现「一方发了另一方不认的遥测字段」，
  而一个纯展示用的字段不该有能力让节点起不来。
  现在若被拒且判定为**可选遥测块**的 schema 分歧，会去掉
  `host` / `process_telemetry` / `external_schedules` 重试一次。
  🔴 判据刻意窄：要求 `-32602` **且**被拒路径落在那三个块里（带点号）。
  `at alias` 这种**必需字段**被拒仍然照抛 —— 那是本节点自己的调用有 bug，
  盖成一条 warn 比崩掉更糟。兜底只用一次，不做无限降级。
- **Windows daemon 的 ANET `path.conf` 默认位置改为 `%ProgramData%\anet-daemon`**
  （PR #1504，修 #1491）。此前默认写的是 POSIX 的 `/etc/…`，在 Windows 上不成立。

🔴 **和 hub 的关系**：#1506 只帮到**升级之后**的节点；**现网已经装好的**那些是靠
`commhub-server 0.9.0-preview.42`（#1498）从 hub 侧恢复的。两件事互补，不重复 ——
Windows 用户和 loopback-only 机器上的用户请两个都升。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.67 @sleep2agi/agent-node@2.5.0-preview.52
anet node create
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.52
cd ~/anodes && anet project restart
```

跑着的节点要重启才会拿到新 agent-node（#117）。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1506 | #1225 硬化 | 可选遥测块 schema 被拒 → 去掉重试一次；必需字段被拒仍照抛 |
| #1504 | #1491 | Windows daemon `path.conf` 默认改 `%ProgramData%\anet-daemon` |
