# 让 Hub 常驻：进程守护

生产 Hub 需要进程守护；裸跑 `nohup ... &` 在崩溃、重启或误杀后不会自动恢复。

::: warning 只允许一个守护者
PM2、systemd、cron 看门狗不能同时管理同一个 Hub。多个守护者可能拉起两个进程，
让它们争用同一个端口和 SQLite 数据库。
:::

## 推荐入口

守护 `anet hub start`，不要在配置里钉死 `commhub-server` 的 preview 版本。
`anet` 会选择与当前 CLI 配套的 Server 版本。

先取得真实路径：

```bash
command -v anet
command -v bun
```

下面以 PM2 为例。把 `script` 换成 `command -v anet` 返回的绝对路径：

```js
// hub.ecosystem.config.js
module.exports = {
  apps: [{
    name: 'commhub-hub',
    script: '/absolute/path/to/anet',
    args: 'hub start',
    interpreter: 'none',
    env: { HOST: '127.0.0.1', PORT: '9200' },
    autorestart: true,
    min_uptime: 45000,
    exp_backoff_restart_delay: 200,
    kill_timeout: 10000,
    max_memory_restart: '2G',
  }],
};
```

文件名必须是 `*.config.js`、`*.json` 或 `*.yaml`。PM2 会把普通 `.cjs`
文件当脚本执行，界面可能显示 `online`，但 Hub 根本没有监听。

启动并核验：

```bash
pm2 start hub.ecosystem.config.js --only commhub-hub
pm2 status commhub-hub
curl -fsS http://127.0.0.1:9200/health
```

不要只看 PM2 的绿色状态；`/health` 才证明服务真的响应。

## 安全边界

- 默认保持 `HOST=127.0.0.1`。公网或局域网部署先完成[生产安全配置](/deploy/production)。
- 生产环境不要使用 `--dev-open`。
- 不要把 token 或 vault key 写进 ecosystem 文件；PM2 会持久化环境变量。
- 不用 `pkill -f` 或 `killall` 清理进程。先取得精确 PID，再停止目标进程。
- 启动失败时保留退避，避免缺依赖或 registry 故障造成高频重启。

如果必须传入敏感环境变量，把它放进权限为 `600` 的独立文件，由一个最小启动脚本
读取；验证日志、PM2 dump 和配置中都没有该值。不要使用
`export $(grep ...)`，匹配为空时它可能打印整个环境。

## 验证自动恢复

在维护窗口内测试一次，而不是等真正故障时才发现守护无效：

1. 用 `pm2 pid commhub-hub` 记录精确 PID。
2. 对这个 PID 发送 `SIGTERM`，不要使用名称匹配批量 kill。
3. 再次检查 `/health` 返回 200。
4. 确认 PID 已变化。

四项缺一不可：旧 PID 没变化，只能证明进程没有退出；新 PID 存在但 `/health`
失败，只能证明 PM2 拉起了一个坏进程。

## 开机自启

```bash
pm2 startup
```

该命令只会打印需要以 root 执行的 systemd 命令。按提示执行后，确认 Hub 健康，
最后再保存：

```bash
pm2 save
ls /etc/systemd/system/pm2-*.service
```

只运行 `loginctl enable-linger` 不会创建 PM2 的 systemd unit。

## 更新配置

先验证新配置，再替换旧配置；不要先 `pm2 delete` 再尝试未知参数。

```bash
pm2 startOrReload hub.ecosystem.config.js --only commhub-hub
curl -fsS http://127.0.0.1:9200/health
```

已有 cron 看门狗时，应先禁用它，再交给 PM2。守护权不明确时停止操作，先确认
哪个进程管理器拥有 Hub。

## 相关

- [生产部署 / 公网部署安全](/deploy/production)
- [升级指南](/guide/upgrade)
- [故障排查](/troubleshooting)
