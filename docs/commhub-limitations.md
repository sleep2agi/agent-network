# CommHub 已知限制和注意事项

> 更新日期: 2026-04-02
> 版本: v0.4.1

---

## Channel 限制

### 1. Channel 仅支持 Claude Code

Channel 插件依赖 Claude Code 的 `--dangerously-load-development-channels` 功能和 `notifications/claude/channel` 协议。**Codex 不支持 Channel**——Codex 只能用 MCP Tool 模式（url 配置）。

### 2. Channel 必须用 stdio 类型

`.mcp.json` 中的 Channel 配置**必须**是 `"type": "stdio"`：

```json
{
  "commhub": {
    "type": "stdio",
    "command": "bun",
    "args": ["run", "/path/to/commhub-channel.ts"]
  }
}
```

**不能用 `"url": "http://..."` 的 http 类型**。原因：Channel 本质是 Claude Code 启动的一个子进程，通过 stdin/stdout 双向通信。http 类型只建立网络连接，不启动子进程，因此 Channel 无法工作。

### 3. `server:{name}` 的查找机制

`--dangerously-load-development-channels server:commhub` 中的 `server:commhub`：
- `server:` 前缀表示"从 MCP Server 定义中查找"
- `commhub` 是 `.mcp.json` 或 `~/.claude/.mcp.json` 中的 key 名
- Claude Code 找到这个定义后，以 Channel 模式（而非普通 MCP Server 模式）启动它

如果找不到对应的 key，Claude Code 会报错：`No server named "commhub" found`。

### 4. 路径必须是绝对路径

`.mcp.json` 中 `args` 里的脚本路径**必须是绝对路径**。相对路径会导致找不到文件，因为 Channel 子进程的工作目录不确定。

### 5. 同目录多 Session 需要手动区分

在同一项目目录下开多个 Claude Code session 时，它们的 alias 会冲突（解析出相同值）。必须用 `COMMHUB_ALIAS` 环境变量手动区分。

---

## Server 限制

### 6. 单服务器架构

CommHub 是单进程、单 SQLite 文件的架构。没有高可用（HA）、没有集群、没有主从复制。

**缓解**：
- systemd 自动重启（5 秒恢复）
- SQLite 是 crash-safe 的（WAL 模式）
- 30 个 Session 的负载对单进程完全够用

### 7. 无内置 TLS

CommHub Server 只监听 HTTP，没有 HTTPS 支持。

**缓解**：
- 在内网使用时风险较低
- 需要公网暴露时，用 Nginx/Caddy 反向代理 + Let's Encrypt 证书
- 防火墙 IP 白名单作为额外防护层

### 8. 无内置认证管理

Token 认证是简单的字符串比对（`COMMHUB_AUTH_TOKEN`），没有用户管理、权限分级、Token 轮换等机制。

**缓解**：
- 内网场景下够用
- 配合防火墙 IP 白名单双重防护
- 需要时可在 Nginx 层加更复杂的认证

### 9. SSE 连接断线重连

Channel 的 SSE 连接断开后有 3 秒重连间隔。在这个窗口期内的任务不会丢失（存在 SQLite inbox 中），但 Agent 不会收到即时推送通知。

### 10. 10 分钟离线超时

CommHub 用 10 分钟无心跳作为 offline 判定标准。如果 Agent 执行长时间任务（如编译、渲染），需要定期调用 `report_status` 保持在线。

---

## 协议限制

### 11. 不支持 A2A / ACP

CommHub 只用 MCP 协议。不支持 Google A2A（Agent-to-Agent）和 IBM ACP（Agent Communication Protocol）。

**原因**：Claude Code 和 Codex 只原生支持 MCP。引入其他协议需要适配层，增加复杂度。等 Claude Code 原生支持 A2A 时再考虑。

### 12. 消息大小限制

MCP 单条消息没有硬限制，但 `output` 字段建议控制在 4000 字符以内（超过部分可能被截断）。大文件传输应使用文件路径/URL 引用而非内联。

---

## 已知问题

### Channel 开发模式警告

`--dangerously-load-development-channels` 是 Claude Code 的开发模式功能，启动时会显示安全警告。这是预期行为。等 Channel 功能 GA 后会有正式的加载方式。

### tmux 环境变量继承

在 tmux 中启动的 Claude Code session，环境变量继承自 tmux session 创建时的环境。如果后续修改了 `.bashrc` 中的环境变量，需要重启 tmux session 或手动 `source ~/.bashrc`。

### Bun 版本兼容性

需要 Bun 1.2+。低版本的 `bun:sqlite` API 不兼容。用 `bun upgrade` 升级。
