# @sleep2agi/commhub-server 0.9.0-preview.33 — release notes

本版**只发 `preview` 通道**。promote 到 `latest` 需要 owner ACK，本文件不代表已发 latest。

🔴 **这一版的修复住在 hub 进程里。** 装 `@sleep2agi/agent-network` 或
`@sleep2agi/agent-node` **拿不到它们** —— 必须升级并**重启** hub 本身。
（同一句话在 `.32` 的发版说明里写过一次，这里重复是因为它每一版都成立，
而漏读它的代价是"升级了却什么都没变"。）

## 本版包含

相对 `0.9.0-preview.32`，新增 **#1304**：

- **agent 主动给 dashboard / 客户端登录用户发消息**的接口
- **客户端未读消息数**（用户报告的 BUG：新消息不显示计数）

实现主体在 `server/`：`server/src/push.ts`（新增）、`server/src/server.ts`、
`server/src/tools.ts`，配套 `desktop-message.test.ts` / `observer-push.test.ts` /
`observer-avatar-http.test.ts`。

`.32` 已含、本版继续保留的：hub 侧在线判定的时区修复
（`server/src/db-timestamp.ts`，无时区 UTC 串按 aware 解析会整批抛异常）
与 `ONLINE_MS` 放宽到 5 分钟。

## Install

新装（`commhub-server` 是**源码分发**，需要 `bun`）：

```bash
npm install -g bun
npm install -g @sleep2agi/commhub-server@0.9.0-preview.33
commhub-server --help
```

## Upgrade

```bash
npm install -g @sleep2agi/commhub-server@0.9.0-preview.33
# 🔴 必须重启 hub 进程，装包不重启不生效
```

走 `anet hub start` 的用户：该命令按 `agent-network` 里的
`PINNED_SERVER_VERSION` 常量拉取 hub，**升级 hub 还需要一并升级 `agent-network`**
（本轮配对版本 `2.3.0-preview.52` 已把该常量指向 `0.9.0-preview.33`）。

## Verification

判据是**产物与运行版本**，不是安装命令的退出码：

```bash
npm view @sleep2agi/commhub-server@0.9.0-preview.33 version   # 产物在不在
curl -s http://127.0.0.1:<port>/health | grep -o '"version":"[^"]*"'   # 跑的是不是它
```

🔴 `/health` 的 `version` 是**当前进程**报出来的。装了包不重启，这里仍会显示旧版本 ——
这正是判断"到底生效没有"的那一格。

## 已知不支持

- `latest` 通道未动（promote 需 owner ACK）。
- Windows 上的 `anet daemon` 仍被显式拒绝（与本版无关，见 #1290）。
