# @sleep2agi/agent-network 2.3.0-preview.66 — release notes

一条修复，只影响 Windows —— 但在 Windows 上它影响的是**全部功能**。

- **Windows 上 `anet` 什么都干不了**（PR #1137，修 #1137）。在真机上诊断的
  （Windows 11 26200 / Node 24.18 / npm 11.16），不是从平台推理出来的。

  根因：`bunx` / `bun` / `npx` / `npm` 在 Windows 上都是 `.cmd`，而 `.cmd` **不是可执行映像**，
  只有命令解释器能跑它。`spawnSync`/`execFileSync` 直接调它们一律 `ENOENT`；
  显式写 `npm.cmd` 则撞上 Node ≥18.20/20.12 的 CVE-2024-27980 防护，得到 `EINVAL`。
  agent-network 里有八处这样的调用点，而整个文件里 `shell: true` **出现零次** ——
  于是组件探测、`anet hub start`、dashboard、自升级、每一次版本检查**同时失效**。
  `anet -v` 报「agent-node — not installed yet」而 npm 明明列着已安装，就是这个原因，
  不是打包问题。

  同一版还修了 Windows 上每一次 `chmod` 的失败路径。

🔴 Windows 用户请连同 `@sleep2agi/agent-node@2.5.0-preview.51` 一起升。那一版有**两条**同类修复
（`anet_bin` 路径校验 #1290、子进程 `HOME` 解析 #1490），都是「只在 POSIX 成立的假设跑在 Windows 上」。
三条串联：本包让 `anet` 能调起外部启动器 → `.51` 让 daemon 能过路径检查 fork 出节点 →
再让 fork 出的节点不立刻崩。**只升其中一个包，Windows 上仍然起不了节点。**

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.66 @sleep2agi/agent-node@2.5.0-preview.51
anet hub start
anet node create
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.66
anet hub restart
curl -fsS http://127.0.0.1:9200/health
```

本版把 `PINNED_SERVER_VERSION` 升到 `0.9.0-preview.41`，`anet hub restart` 会拉起新版 hub
（desktop message 持久化 + 未读数，见 commhub-server `0.9.0-preview.41` 的 release notes）。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1137 | #1137 | Windows：外部启动器改走命令解释器、`chmod` 路径修复 |
| — | — | pin 链同步：`PINNED_SERVER_VERSION` → `0.9.0-preview.41`、`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.51` |
