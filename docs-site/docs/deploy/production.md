# 生产部署安全

::: danger 不要直接暴露 Hub 和 Dashboard 端口
默认配置面向本机使用：Hub 监听 `127.0.0.1:9200`，Dashboard 使用 `3000`。
Dashboard 的绑定地址可能受环境变量 `HOSTNAME` 影响，生产环境必须显式指定。
公网部署必须先完成强密码、HTTPS 反代、防火墙和备份。
:::

## 默认状态

| 项目 | 默认值 | 上线要求 |
|---|---|---|
| Hub | `127.0.0.1:9200` | 保持本机监听，通过反向代理访问 |
| Dashboard | `3000`；绑定地址可能继承 `HOSTNAME` | 显式使用 `--host 127.0.0.1` |
| 管理员 | 用户名 `admin`；初始密码见首次启动输出 | 首次登录后运行 `anet passwd` |
| HTTPS | 未提供 | 在 Caddy、Nginx 或云网关终止 TLS |
| tmux 控制面 | 关闭 | 生产环境保持关闭 |
| 数据 | `~/.commhub/commhub.db` | 定期备份并限制备份权限 |

## 上线检查单

### 1. 启动后立即改密

先在本机启动。保存首次启动输出中的初始密码，再登录并改密：

```bash
anet hub start
anet login --hub http://127.0.0.1:9200 --username admin
anet passwd
```

新密码必须至少 8 位，且不能在弱密码表中。初始密码行为会随发布频道变化；以启动输出为准，不要依赖固定值。

### 2. 使用 HTTPS 反向代理

Hub 和 Dashboard 继续监听本机地址。以下是最小 Caddy 配置：

```text
hub.example.com {
    reverse_proxy 127.0.0.1:9200
    header -Server
    header X-Content-Type-Options nosniff
}

dashboard.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

将域名解析到服务器，然后执行 `sudo systemctl reload caddy`。不要把示例域名原样用于生产。

### 3. 明确限制监听地址

Hub 保持默认的 `127.0.0.1`；Dashboard 使用显式参数：

```bash
anet hub dashboard --host 127.0.0.1
```

远程节点通过 `https://hub.example.com` 访问反向代理，不需要让 Hub 直接监听公网地址。

### 4. 收紧防火墙

公网只开放实际需要的入口，通常是：

- `22`：SSH（最好再限制来源 IP）
- `80`：证书签发和 HTTP 跳转
- `443`：HTTPS

不要把 `9200` 或 `3000` 直接开放到公网。

### 5. 确认 tmux 控制面已关闭

服务端只有在 `COMMHUB_ENABLE_TMUX=1` 时才启用 tmux HTTP/WebSocket 端点。
生产环境不要设置这个变量；启动日志应显示 `Tmux: DISABLED`。

确需在受信环境启用时，同时配置 IP allowlist，并确认调用者是 admin。端点说明见
[REST API：tmux 控制面](/api/rest#tmux-调试端点-opt-in)。

### 6. 使用邀请制

账号注册与加入 network 是两件事。团队成员注册自己的账号后，用单次 member 邀请加入目标 network：

```bash
anet network invite --role member --uses 1
```

`POST /api/auth/register` 当前是公开、限流接口。若部署不允许自助注册，请在反向代理或网关阻断该路径。
不要共享管理员账号。

### 7. 备份与监控

使用 SQLite 的在线备份命令，不要在 Hub 运行时直接复制数据库文件：

```bash
umask 077
mkdir -p ~/.commhub/backups
sqlite3 ~/.commhub/commhub.db \
  ".backup '$HOME/.commhub/backups/commhub-$(date +%F).db'"
```

把备份任务自动化，设置保留周期，并定期做一次恢复演练。备份中包含账号和消息数据，
应按敏感数据保护。

至少监控：

- `GET http://127.0.0.1:9200/health`
- 磁盘剩余空间
- Dashboard 的 Audit Log
- Hub 进程是否由可靠的进程管理器守护

长期运行和开机恢复见 [Hub 进程守护](/deploy/daemon)。

## 部署方式

| 场景 | 建议 |
|---|---|
| 个人开发 | 只监听本机 |
| 受信局域网 | 仍使用强密码和 HTTPS |
| 跨公网协作 | HTTPS 反代 + 防火墙 + 邀请制 + 备份 |

## 安全问题

- 配置与权限说明：[安全设计](/concepts/security)
- 版本迁移：[升级指南](/guide/upgrade)
- 私下报告漏洞：[GitHub Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new)
