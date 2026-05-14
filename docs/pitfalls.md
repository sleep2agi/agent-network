# Channel 插件踩坑经验

> **适用范围**：本文是给**实现 Claude Code Channel 插件**（telegram / commhub / wechat / feishu 等）的开发者看的内部踩坑记录。
>
> - 内容时效：源自 V2 ~ V3 早期 channel 插件开发（2026-03 ~ 04），R216 (2026-05-13) 对照 `agent-network/bin/cli.ts` `ensureMcpJson`（当前 `cli.ts:1644-1727`） + `agent-network/src/node-server.ts` + `channel/commhub-channel.ts` 做了 v0.8 source-of-truth 校准；核心概念（`meta.user` / MCP server name `commhub-channel` / `ensureMcpJson` / config.json 继承）仍有效。
> - 不适用于：anet 终端用户、agent 编写者。普通用户看 [https://anet.sh/concepts/channels](https://anet.sh/concepts/channels)。
> - 官方参考：[claude-plugins-official/telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)
> - **channel 暴露的 5 个 MCP tool**：`commhub_reply` / `commhub_report_status` / `commhub_send_task` / `commhub_send_message` / `commhub_get_all_status`（[channel/commhub-channel.ts:138-196](https://github.com/sleep2agi/agent-network/blob/main/channel/commhub-channel.ts#L138)；`get_inbox` 故意不在列，agent 通过 SSE 自动轮询 inbox）。

## 1. meta.user 字段决定 Channel 显示名

Claude Code 用 channel notification 的 `meta.user` 字段生成显示名。

- telegram 插件设 `user: from.username` → 显示 `telegram · alice`
- commhub 插件设 `user: msg.from_session` → 显示 `commhub · SDK马`

**缺少 `meta.user` 就只显示 server name，没有 `· xxx` 后缀。**

```typescript
// 正确
await mcp.notification({
  method: "notifications/claude/channel",
  params: {
    content: msg.content,
    meta: {
      sender: msg.from_session || "hub",
      sender_id: "commhub",
      user: msg.from_session || "hub",   // ← 必须有
      task_id: msg.id,
      priority: msg.priority || "normal",
    },
  },
});
```

## 2. MCP Server name 不需要带 alias

telegram 插件 name 就是 `"telegram"`，不是 `"telegram · alice"`。`· alice` 是 Claude Code 根据 `meta.user` 自动加的。

不要在 Server constructor 的 name 里拼 alias：

```typescript
// 错误
name: `commhub · ${ALIAS}`,

// 正确
name: "commhub-channel",
```

## 3. ensureMcpJson 不能覆盖已有配置

`.mcp.json` 可能是用户手动配的（指向开发源码），不能无条件覆盖。

```typescript
// 错误：每次都写
mcpConfig.mcpServers.commhub = { ... };
writeFileSync(mcpJsonPath, ...);

// 正确：只在没有时才写
const hasCommhub = Object.keys(mcpConfig.mcpServers).some(k => k.includes("commhub"));
if (!hasCommhub) {
  mcpConfig.mcpServers.commhub = { ... };
  writeFileSync(mcpJsonPath, ...);
}
```

## 4. node-server.js 要对比更新，不能跳过已存在

npm 包更新后，项目里的 `.anet/node-server.js`（**注意：是 `.js` 不是 `.ts`** —— anet 把源文件复制为 `.js` 落到项目 `.anet/` 下）需要同步。不能因为文件存在就跳过。

```typescript
// 对比内容，不同才更新
const src = readFileSync(npmPath, "utf-8");
const dst = existsSync(localPath) ? readFileSync(localPath, "utf-8") : "";
if (src !== dst) {
  writeFileSync(localPath, src);
}
```

verify [`agent-network/bin/cli.ts:1658-1674`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1658) `candidates` 数组：源文件搜索顺序为
1. `dist/src/node-server.js`（npm 包混淆后产物，优先）
2. `src/node-server.ts`（开发环境源码）
3. `npm root -g/@sleep2agi/agent-network/...` 全局安装路径兜底

最终都落盘为项目 `.anet/node-server.js`，`.mcp.json.mcpServers.commhub.args = [".anet/node-server.js"]`（cli.ts:1724）。

## 5. config.json 全局继承规则

两个 config.json 都要读，字段级合并：

```
项目 .anet/nodes/<node-name>/config.json  （有值的字段优先；目录名是 alias）
    ↓ fallback
全局 ~/.anet/config.json            （缺失字段兜底）
```

项目 config 不需要写 token/hub 等通用配置，全局配一份所有项目共用。

## 6. channel 插件的 token 来源

channel 插件（node-server.ts）读 token 的优先级：

```
COMMHUB_TOKEN env > ~/.anet/config.json token > 空
```

不依赖 `.anet/.env` 或 anet 传 env。只要全局 config 有 token 就能用。

## 7. Claude Code Channel 插件参考

官方 telegram 插件源码：
https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram

关键结构：
- `Server` constructor: `name` 简洁（如 `"telegram"`），不拼用户信息
- `capabilities`: `experimental: { "claude/channel": {} }`
- `instructions`: 告诉 Claude 消息格式和回复方式
- `notifications/claude/channel`: `meta.user` 决定显示名
