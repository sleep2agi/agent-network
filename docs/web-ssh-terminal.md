# Web SSH 终端方案调研

> 日期: 2026-04-03
> 需求: 在 vansin.me/commhub 点击 session 直接在浏览器里打开 SSH 终端连 tmux session

---

## 1. 方案对比

| 工具 | Stars | 语言 | tmux 直连 | 部署复杂度 | 认证 | 许可证 | 推荐 |
|------|-------|------|----------|-----------|------|--------|------|
| **ttyd** | 11.3K | C | ✅ 直接 | 1/5 | Basic auth | MIT | **首选** |
| **GoTTY** | 19K+2.5K | Go | ✅ 直接 | 1/5 | Basic auth | MIT | 备选 |
| **Wetty** | 5.2K | TypeScript | ❌ 间接(SSH) | 2/5 | SSH 委托 | MIT | 可用 |
| **Sshwifty** | 3.1K | Go | ❌ 间接(SSH) | 2/5 | 共享密码 | AGPL | 不推荐 |
| **Guacamole** | 5.4K | C+Java | ❌ 间接(SSH) | 5/5 | 企业级 | Apache | 过重 |
| **自建 xterm.js** | 20.2K | TS | ✅ 直接 | 4/5 | 完全自定义 | MIT | 灵活 |

## 2. 推荐方案：ttyd + 反向代理

### 2.1 为什么选 ttyd

- **一行命令直连 tmux**: `ttyd tmux attach -t session-name`
- **单二进制，零依赖**: 下载即用，11K stars，活跃维护
- **内置 xterm.js**: 浏览器打开就是终端
- **支持只读模式**: `-R` 参数，安全观察

### 2.2 架构

```
浏览器 (vansin.me/commhub)
  │  点击 session "codex-硅谷"
  ▼
Caddy/nginx 反向代理
  │  验证 JWT token（CommHub 生成）
  │  路由到 /terminal/codex-硅谷
  ▼
ttyd -p 7682 tmux attach -t codex-硅谷
  │  PTY ↔ WebSocket ↔ xterm.js
  ▼
tmux session (codex-硅谷)
```

### 2.3 最小部署

```bash
# 安装 ttyd
apt install ttyd  # 或 brew install ttyd

# 单 session 模式
ttyd -p 7682 -R tmux attach -t codex-硅谷

# 动态 session 模式（通过 URL 参数选择 session）
ttyd -p 7682 bash -c 'tmux attach -t ${TTYD_SESSION:-default}'

# 生产部署：Caddy 反向代理 + TLS
# Caddyfile:
# terminal.vansin.me {
#   reverse_proxy localhost:7682
# }
```

### 2.4 嵌入 Dashboard

```html
<!-- CommHub Dashboard 中 -->
<iframe
  src="https://terminal.vansin.me/?session=codex-硅谷&token=JWT_TOKEN"
  style="width:100%; height:500px; border:none;"
></iframe>
```

## 3. 安全风险评估

### 3.1 核心风险

| 风险 | 级别 | 说明 |
|------|------|------|
| **凭证暴露** | 高 | SSH 密码/密钥流经 Web 代理，代理被攻破=所有主机被攻破 |
| **会话劫持** | 高 | WebSocket 无 TLS 时可被中间人劫持 |
| **XSS → Shell** | 严重 | Dashboard XSS 漏洞 = 浏览器里的 Shell 被控制 |
| **横向移动** | 高 | Web 终端 = Shell-as-a-Service，无命令限制 |
| **无审计** | 中 | 默认无操作录制 |

### 3.2 缓解措施

| 措施 | 优先级 | 实现 |
|------|--------|------|
| **TLS 必须** | P0 | Caddy 自动 Let's Encrypt |
| **短期 JWT token** | P0 | CommHub 生成 5 分钟有效 token，ttyd 前端验证 |
| **只读模式默认** | P0 | `ttyd -R`，写入需额外授权 |
| **IP 白名单** | P1 | nginx/Caddy 限制来源 IP |
| **网络隔离** | P1 | ttyd 监听 127.0.0.1，只有反向代理能访问 |
| **会话超时** | P1 | 空闲 5 分钟自动断开 |
| **操作录制** | P2 | tmux 日志 or script 命令录制 |
| **CSP 防 XSS** | P2 | Content-Security-Policy header 限制 iframe 来源 |

### 3.3 权限控制方案

```
用户访问 → Caddy 检查 JWT → 提取 session_id + role
  │
  ├─ role=viewer → ttyd -R (只读)
  ├─ role=operator → ttyd --writable (可写)
  └─ 无效 token → 403
```

JWT 由 CommHub Dashboard 后端生成，包含：
- `session_id`: 允许访问的 tmux session
- `role`: viewer / operator
- `exp`: 过期时间（5 分钟）
- `iss`: commhub

## 4. 部署复杂度

| 步骤 | 工作量 | 说明 |
|------|--------|------|
| 安装 ttyd | 5 分钟 | `apt install ttyd` |
| 配置 Caddy/TLS | 30 分钟 | 自动证书 |
| Dashboard iframe 集成 | 2 小时 | 前端 JS + JWT 生成 |
| 进程管理（多 session） | 半天 | 按需启动/停止 ttyd 实例 |
| 完整安全加固 | 1 天 | JWT 验证 + IP 白名单 + 审计 |
| **总计** | **1-2 天** | |

## 5. 是否值得做（投入产出比）

### 值得做的场景
- 需要给非 SSH 用户（如产品经理）展示 Agent 运行状态
- 需要统一 Dashboard 体验（不切换窗口）
- 需要给团队成员安全的只读观察权限
- 需要操作录制/审计

### 不值得做的场景
- **只有你一个人运维** → 直接 `ssh + tmux attach` 更快更安全
- 不需要给别人看 → 没有观众就不需要舞台
- 安全要求极高 → Web 终端增加攻击面

### 结论

**对当前 1 人运维的场景：不值得做。** `ssh + tmux attach` 是零成本、零风险、零维护的方案。

**什么时候值得做：**
- 团队超过 3 人需要协作查看 Agent 状态
- 需要给非技术人员展示
- 做产品 demo 时需要浏览器内展示

**如果要做，用 ttyd + Caddy，1 天搞定。**

## 6. 备选方案：不嵌入终端

如果不想暴露 SSH，Dashboard 可以只展示：
- CommHub `get_all_status()` 的结构化数据（状态/任务/进度）
- `get_completions()` 的完成记录
- Agent 最近的 `output` 字段（report_status 传上来的文本）

这样 Dashboard 是纯数据展示，不需要终端，安全风险为零。
