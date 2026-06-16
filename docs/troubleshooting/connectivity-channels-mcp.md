# 排障：连接不上 / 收不到消息（telegram & commhub MCP）

> 对应加固 issue #245。下面两类是最常见的「节点看着活着、其实连不通」故障，先按症状对号入座。
> 一键体检命令：**`anet doctor`**（会直接报这两类问题）。

---

## 症状 1：commhub 工具全没了 / 派不动单

**现象**：会话里 `commhub_*` 工具一个都没有；其它一切正常，就是无法收发任务。

**根因**：节点的 commhub MCP server（`.anet/node-server.js`）启动即崩。最常见是
`.anet/node_modules/@modelcontextprotocol/sdk` **装残**（只剩 `dist/`，缺子路径导出），
于是 server 在 `import` 阶段就抛 `Cannot find module '@modelcontextprotocol/sdk/server/...'`，
**没有任何工具注册成功**。常见诱因：磁盘清理 / node_modules 被破坏的连带。

**诊断**：
```bash
anet doctor          # 看 "CommHub MCP dependency" 这一行
```
或手动直接跑 server 看启动报错（最快）：
```bash
cd <node-cwd> && bun .anet/node-server.js
# Cannot find module @modelcontextprotocol/sdk... = 坏依赖
# MCP stdio connected + registered as "<alias>" = 好
```

**修复**：
```bash
cd <node-cwd>/.anet && bun install      # 补全 sdk
anet node restart <alias>               # 重启会话才会重新 spawn 修好的 MCP server
```
> 从 #245 起，`anet node start` 会**每次启动实地探测**该依赖、坏了自动重装、修不好则明确报错——
> 多数情况下不再需要手动修。

**别做**：① 当成会话级问题反复重启（坏依赖在，每次 respawn 照崩）；② 去 `kill` MCP 进程（纯添乱）。

---

## 症状 2：telegram 通道加了，但一直收不到消息

**现象**：`anet channel add telegram ...` 提示成功，但 Telegram 收不到；`anet resume` 也没用；
`/mcp` 列表里看不到 telegram。

**根因**：telegram 通道是会话**启动那一刻**才拉起的 stdio MCP server，从 `TELEGRAM_STATE_DIR/.env` 读 token。
1. 若**先起会话、后 add channel**，首启时通道还没建 → server 找默认空目录 → 报
   `TELEGRAM_BOT_TOKEN required` → 退出。
2. `anet resume` **不会重连**首次缺失/失败的通道（会重连 commhub 等其它的），失败的通道也不进 `/mcp`。
3. 只有 `stop + start` 才会从头初始化成功。

**诊断**：
```bash
anet doctor                  # "Telegram channels" 段：看各节点 allowFrom / pending / policy
anet channel status [节点]    # 看节点实际读取的 access.json 绝对路径 + allowlist + 待配对
```

**修复**：
```bash
anet node stop <alias> && anet node start <alias>
```
> 从 #245 起，对**正在运行**的节点执行 `anet channel add` 会明确警告「需 stop+start 才生效」，
> 不再静默成功。

---

## 症状 3：改了 access.json 还是不对 / 不知道改哪个文件

每个节点读的是**它自己的** `access.json`（路径 = `TELEGRAM_STATE_DIR` =
`.anet/nodes/<节点>/channels/telegram/access.json`）。改全局或别的节点的副本**无效**。

```bash
anet channel status [节点]    # 直接打印「节点运行时实际读取的那个 access.json」绝对路径
```
改对它，再 `anet node stop && start` 即可。

---

## 速查

| 你想知道 | 命令 |
|---|---|
| 整体体检（含上面两类） | `anet doctor` |
| telegram 配置真实路径 + 谁能发 + 谁在等配对 | `anet channel status [节点]` |
| commhub MCP 依赖好不好 | `anet doctor`（看 CommHub MCP dependency 行） |
| commhub MCP 直接看启动报错 | `cd <cwd> && bun .anet/node-server.js` |
