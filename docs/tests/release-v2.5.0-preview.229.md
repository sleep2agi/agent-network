# agent-node 2.5.0-preview.229

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.263** 精确配对。

## Why

**聊天密钥卡片（`request_secret` / `reply_secret_request`）**（`#3864`）：

- 新增 `request_secret` MCP 工具与 `reply_secret_request` 回复元数据字段，AI 向用户索要密钥时可直接在聊天里弹出加密输入卡片，用户提交后直接写入节点加密密钥库而不落入聊天正文与模型上下文。
- **Hub 生效要求**：`reply_secret_request` / 卡片字段需要**主 Hub 运维重启 `commhub-hub`** 后生效。

**Antigravity 就绪报错收尾（`#3865`，承接 `#3825`）**：

- 当 `agy` 不存在（`ENOENT`）或 `agy --version` 读不出版本时，不再继续执行 `agy acp --help` 并报自相矛盾的「这个版本没有 acp 子命令：没读到版本」。
- 拆分为两条人话回复（不暴露 `PATH` / `AGY_BIN` / `acp`，技术细节保留在节点日志）：
  - 找不到程序：「这台机器上找不到 Antigravity 程序。请确认已安装，再发一次。」
  - 程序存在但读不出版本：「这台机器上的 Antigravity 程序没正常响应，读不到版本号。请确认它能正常启动，再发一次。」
  - 仅在解析出版本号且确实缺少 `acp` 时，才提示版本过低需要升级。

**OpenCode V2 无原因失败给出明确指引**（`#3858`）：

- 当 OpenCode V2 回合失败且未返回具体原因时，回复中明确提示用户下一步操作，不再只丢出空白/笼统错误。

**Hub PostgreSQL 兼容修复**（`#3861`、`#3863` / `#5431`）：

- 修复节点配置读取及两张数据表在 PostgreSQL 下依赖 SQLite 专属 `rowid` 的问题。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.229 @sleep2agi/agent-network@2.3.0-preview.263
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行（应为 2.5.0-preview.229）
anet upgrade  # 按配对升级节点与 CLI
```

## 未验

- 聊天密钥卡片：需主 Hub 重启 `commhub-hub` 并配合 App / Dashboard 密钥卡片版本上线后，在真实对话中做完整提交与回执复验。
- Antigravity 报错收尾与 OpenCode V2 失败提示：依据定向单测与 CI 套件通过，发布后按需在真机复核。
