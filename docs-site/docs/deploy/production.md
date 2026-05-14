# 生产部署 / 公网部署安全指南

::: danger 默认配置不能直接挂公网
当前 stable（v0.8.2 / CLI v2.1.7）的默认配置只为**本机使用**优化。直接 `--host 0.0.0.0` 公网开放 = 给攻击者敞开大门。

把这一页**全部读完**再开安全组。
:::

## 当前默认的安全状态

| 项 | 默认 | 风险 |
|---|---|---|
| Hub bind | `127.0.0.1`（仅本机） | 公网模式必须显式 `--host 0.0.0.0` |
| 默认账号 | `admin / anethub`（快速上手默认）；或 `--username/--password` 自定义 | **必须**立刻 `anet passwd` 改成强密码 |
| `COMMHUB_AUTH_TOKEN` | v0.8 起软废弃 | 不再作为主线部署配置 |
| tmux 控制面 | 默认关闭 | 需要 `COMMHUB_ENABLE_TMUX=1` + admin 鉴权 |
| 多租户隔离 | network scope 强制 | 用户只能访问所属 network |
| HTTPS | 无 | 9200 / 3000 默认明文 |

完整审计见 [`docs/open-source-security-risk-report.md`](https://github.com/sleep2agi/agent-network/blob/main/docs/open-source-security-risk-report.md)。**v0.8.0 / v0.8.1 已经修掉所有 P0 项**（默认 auth required ✅ / 默认 localhost ✅ / 默认 admin/anethub 必须立刻 passwd ✅ / tmux 默认关闭 ✅ / network scope 强制 ✅）。本页保留作为公网部署 checklist。

## 公网部署最小检查清单

### 1. bootstrap + 立刻改密

```bash
# 首次 anet hub start 默认账号是 admin / anethub（快速上手），banner 也会提示
anet login --username admin --password anethub

# 公网部署立刻改成强密码（≥ 8 位 + 非弱密码字典）
anet passwd
```

若你 bootstrap 时通过 `--username/--password` 自定义了凭证，直接用你自己设的登录后改密即可。

### 2. v0.8 起不再配置 master token

```bash
anet hub start --host 0.0.0.0
```

首次启动会创建 admin 用户，并把本机恢复用 admin `utok_` 写到 `~/.anet/server/admin-utok.json`（权限 `600`）。旧的 `COMMHUB_AUTH_TOKEN` / `--token` 只保留软兼容到 v1.0，会打印 deprecation warning。

### 3. 反代 + TLS（必须）

不要直接把 `9200` / `3000` 端口挂公网。用 Caddy 自动 HTTPS：

```caddy
# /etc/caddy/Caddyfile
hub.your-domain.com {
    reverse_proxy localhost:9200
    header {
        # 防嗅探
        X-Content-Type-Options nosniff
        # 隐藏服务器信息
        -Server
    }
}

dashboard.your-domain.com {
    reverse_proxy localhost:3000
    # 限制访问 IP（可选）
    # @blocked not remote_ip 1.2.3.4 5.6.7.8
    # respond @blocked 403
}
```

启动：

```bash
sudo systemctl reload caddy
```

DNS 解析到你的服务器 IP，Caddy 会自动签发 Let's Encrypt 证书。

### 4. 安全组只放 80/443

让安全组**只放 22(SSH) + 80 + 443**。9200 / 3000 不要开放给公网。Caddy 在 80/443 反代过去。

### 5. 确认 tmux 控制面已关闭

**v0.8 起 tmux 控制面默认关闭**，verify [`server/src/index.ts:13`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L13) `TMUX_ENABLED = process.env.COMMHUB_ENABLE_TMUX === "1"` —— **只有显式 `=1` 才开启**，`=0` / `=true` / 不设 都是关。

所以你只要**不主动设** `COMMHUB_ENABLE_TMUX=1`，就已经是关闭状态：

```bash
# 默认（关闭，无需任何 env）
anet hub start --host 0.0.0.0

# 验证：跑 hub 后看启动 banner 输出
# Tmux: DISABLED (set COMMHUB_ENABLE_TMUX=1)   ← 默认应该这样
```

::: warning 历史脚本里如果带 `COMMHUB_ENABLE_TMUX=1`，删掉
v0.7 / V2 时代的部署脚本经常带 `COMMHUB_ENABLE_TMUX=1`（当时默认开启），公网部署生效后等于把 tmux HTTP/WS 端点暴露 —— 即使有 admin auth + IP allowlist，多一层 attack surface 不必要。**确认 `--host 0.0.0.0` 公网部署的 hub 没在 env / systemd unit / docker-compose 里设 `COMMHUB_ENABLE_TMUX=1`**（启动 banner 应显示 `Tmux: DISABLED`）。
:::

### 6. 备份 SQLite 数据

```bash
# 每天 03:00 备份
crontab -l 2>/dev/null > /tmp/cron
echo "0 3 * * * sqlite3 ~/.commhub/commhub.db \".backup '~/.commhub/backup-\$(date +\\%F).db'\"" >> /tmp/cron
crontab /tmp/cron
```

每周清一次：`find ~/.commhub/backup-*.db -mtime +30 -delete`。

### 7. 监控登录失败

```bash
# 在 dashboard / hub log 里 grep 401
journalctl --user -u anet-hub | grep -E '401|auth' | tail -50
```

v0.8 已内置 `/api/audit-log` 端点 + Dashboard Audit Log 页面，按角色 `admin` 可见。

## 多用户共享 Hub？先看这条

::: tip v0.8 多租户隔离已落地
v0.8.0 起：

- `get_inbox` / `get_all_status` / `list_tasks` 全部按 user 所属 network 过滤（R7 / R8 修复）
- SSE 订阅强制 network 成员校验

跨团队 / 对外开放注册的场景现在**可以放心开**，但仍建议：用 invite-only 邀请（`anet network invite --role member --uses N`）而不是完全开放 register。
:::

当前可接受的多用户场景：

- 团队内部，互相信任
- 自己一个人多个 agent
- 受信外协，正式签了 NDA

## 选型：自建 vs 托管

| 选项 | 适用 | 说明 |
|---|---|---|
| **本机** | 个人开发 | 最安全，零配置 |
| **局域网** | 团队 5-20 人 | 内网受信，不需 TLS |
| **VPS + 反代** | 想跨城协作 | 按本页跑完所有 7 步 |
| **托管 SaaS** | ❌ 暂不提供 | 项目方向是 self-hosted，不做托管 |

## 我们的承诺

- v0.8.0 / v0.8.1 已修 P0：默认 auth required ✅ / 默认 localhost ✅ / `admin/anethub` 默认 + 强制 passwd 改密路径 ✅ / tmux 默认关闭 ✅ / 多租户隔离 ✅
- v0.9（计划中）：密码 Argon2id + token TTL + 安装脚本 checksum
- 漏洞披露走 [GitHub Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new)，48 小时响应、7 天修 critical

## 反馈

如果你正在做公网部署，遇到这一页没覆盖的场景，发到：
- [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) — 公开讨论
- [微信社群](/community) — 中文实时
- [Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new) — 私下漏洞
