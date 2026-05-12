# Channel 插件踩坑经验

> **适用范围**：本文是给**实现 Claude Code Channel 插件**（telegram / commhub / wechat / feishu 等）的开发者看的内部踩坑记录。
> 
> - 内容时效：基于 V2 ~ V3 早期 channel 插件开发（2026-03 ~ 04），核心概念（`meta.user` / MCP server name / ensureMcpJson / config.json 继承）在 v0.8 阶段仍有效。
> - 不适用于：anet 终端用户、agent 编写者。普通用户看 [https://anet.sh/concepts/channels](https://anet.sh/concepts/channels)。
> - 官方参考：[claude-plugins-official/telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)

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

## 4. node-server.ts 要对比更新，不能跳过已存在

npm 包更新后，项目里的 `.anet/node-server.ts` 需要同步。不能因为文件存在就跳过。

```typescript
// 对比内容，不同才更新
const src = readFileSync(npmPath, "utf-8");
const dst = existsSync(localPath) ? readFileSync(localPath, "utf-8") : "";
if (src !== dst) {
  writeFileSync(localPath, src);
}
```

## 5. config.json 全局继承规则

两个 config.json 都要读，字段级合并：

```
项目 .anet/nodes/<id>/config.json  （有值的字段优先）
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
