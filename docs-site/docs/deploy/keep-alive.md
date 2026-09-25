# 让 Hub 常驻（pm2 / systemd）

生产环境的 Hub 需要进程守护。裸跑 `nohup anet hub start &` 在崩溃、重启或误杀后不会自动恢复。
本页用 PM2 守护 `anet hub start`，也给出等价的 systemd 写法。

::: tip 要找的是 `anet daemon`？
`anet daemon` 是另一件事：在一台机器上起一个能被 Dashboard 远程指挥、代你创建节点的
`host_supervisor` 节点，见 [`anet daemon`：在远程机器上建节点](/deploy/daemon)。
:::

::: warning 只允许一个守护者
PM2、systemd、cron 看门狗不能同时管理同一个 Hub。多个守护者可能拉起两个进程，让它们争用同一个端口和
SQLite 数据库。
:::

## 先决条件 {#prereqs}

- Bun ≥ 1.2，且 `bun` 和 `bunx` 都在守护进程的 PATH 上。`anet hub start` 用 `bunx` 启动配套版本的
  commhub-server，缺 `bunx` 时会报错退出。
- 先在前台跑通一次 `anet hub start`，确认 `curl -fsS http://127.0.0.1:9200/health` 返回成功，再交给守护者。

## 推荐入口：PM2 守护 `anet hub start` {#pm2}

守护 `anet hub start`，不要在配置里钉死某个 `commhub-server` 版本；`anet` 会选择与当前 CLI 配套的
Server 版本。

先取得真实路径：

```bash
command -v anet
command -v bun
```

::: warning 用绝对路径，不要用 `bunx` / `npx` 当守护入口
守护者不会读取你交互 shell 的 PATH，所以入口要写 `command -v anet` 返回的绝对路径。用
`npx @sleep2agi/agent-network hub start` 之类的写法当入口，每次重启都可能解析到不同版本，而且依赖当时
能访问 npm registry。
:::

把 `script` 换成 `command -v anet` 返回的绝对路径：

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
    // 必须大于一次失败启动走到退出所需的时间，见下文 min_uptime 一节。
    min_uptime: 45000,
    // 只配退避、不配 max_restarts：失败进程会一直重试。需要上限就加 max_restarts。
    exp_backoff_restart_delay: 200,
    kill_timeout: 10000,
    max_memory_restart: '2G',
  }],
};
```

文件名要让 PM2 认出这是配置而不是脚本：`*.config.js`、`*.config.cjs`、`*.json`、`*.yaml` 都可以。
文件名不符合这些形态时，PM2 会把它当普通脚本执行，界面可能显示 `online`，但 Hub 根本没有监听。

启动并核验：

```bash
pm2 start hub.ecosystem.config.js --only commhub-hub
pm2 status commhub-hub
curl -fsS http://127.0.0.1:9200/health
```

PM2 显示绿色不代表服务可用，`/health` 返回成功才算。

Hub 的数据库默认在运行用户的 `~/.commhub/` 下，用哪个用户启动 PM2，就用的是哪个用户的数据库。

## `min_uptime` 怎么定 {#min-uptime}

`min_uptime` 必须大于一次失败启动走到退出所需的时间。小于它时，PM2 会把失败当成启动成功：
`max_restarts` 不累加，`exp_backoff_restart_delay` 不触发，崩溃循环看起来就像正常重启。

这个时间取决于被守护的命令在失败路径上等多久。守裸 `anet hub start` 时失败通常很快；本仓的
[`deploy/hub/hub-daemon.sh`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/hub-daemon.sh)
在预检失败时先 `sleep 30` 再 `exit 1`，守它就需要 `min_uptime` 大于 `30000`。示例里的 `45000` 对两种入口都够。

核对守护配置时看 `pm2 describe commhub-hub` 里的 `unstable restarts`：进程在反复失败，而这个数一直是 0，
说明 `min_uptime` 设小了，退避从未生效。只看 `restarts` 分辨不出来。

## 验证自动恢复 {#verify-recovery}

在维护窗口内测试一次，不要等真正故障时才发现守护无效：

1. 用 `pm2 pid commhub-hub` 记录精确 PID。
2. 对这个 PID 发送 `SIGTERM`，不要按进程名批量 kill。
3. 确认 `/health` 重新返回 200。
4. 确认 PID 已变化。

四项缺一不可：PID 没变，只能说明进程没退出；PID 变了但 `/health` 失败，只能说明 PM2 拉起了一个坏进程。

## 开机自启 {#boot}

```bash
pm2 startup
```

该命令只打印需要以 root 执行的 systemd 命令，不会自己执行。按提示执行后，确认 Hub 健康，最后再保存进程列表：

```bash
pm2 save
ls /etc/systemd/system/pm2-*.service
```

只运行 `loginctl enable-linger` 不会创建 PM2 的 systemd unit。

## 用 systemd 代替 PM2 {#systemd}

不想装 PM2 时，可以用 systemd 守护 `anet hub start`，unit 示例见[干净服务器从零部署 · 持久化](/deploy/clean-server#_8-持久化-systemd-tmux)。守护进程不读你的 shell profile，要在 unit 里显式写好 `bun` / `bunx` 所在目录的 `PATH`。同一个 Hub 只能交给一个守护者，不要让 PM2 和 systemd 同时管理它。

## 安全边界 {#security}

- 默认保持 `HOST=127.0.0.1`。公网或局域网部署先完成[生产安全配置](/deploy/production)。
- 生产环境不要使用 `--dev-open`。
- 不要把 token 或 vault key 写进 ecosystem 文件或 unit 文件；PM2 会持久化环境变量。
- 不要用 `pkill -f` 或 `killall` 清理进程。先取得精确 PID，再停止目标进程。
- 保留重启退避，避免缺依赖或 registry 故障造成高频重启。

如果必须传入敏感环境变量，把它放进权限为 `600` 的独立文件，由一个最小启动脚本读取；验证日志、PM2 dump
和配置里都没有该值。不要使用 `export $(grep ...)`，匹配为空时它可能打印整个环境。

## 更新配置 {#update-config}

先验证新配置，再替换旧配置；不要先 `pm2 delete` 再尝试未验证过的参数。

```bash
pm2 startOrReload hub.ecosystem.config.js --only commhub-hub
curl -fsS http://127.0.0.1:9200/health
```

已有 cron 看门狗时，先禁用它，再交给 PM2。不确定是谁在守护 Hub 时先停手，查清楚哪个进程管理器拥有它。

## 更完整的参考配置 {#reference-config}

本仓 [`deploy/hub/`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub) 里有一套带预检的守护配置，
可以作为加固时的参考：

- [`ecosystem.config.cjs`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/ecosystem.config.cjs)：PM2 进程定义（不含密钥）
- [`hub-daemon.sh`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/hub-daemon.sh)：被守护的启动脚本，
  启动前检查 bun、固化安装、vault 密钥和端口占用，任何一项不满足都拒绝启动
- [`README.md`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/README.md)：Hub 换版本流程

它按本项目自己的目录布局写成，照搬前请替换其中的路径。

## 相关 {#related}

- [`anet daemon`：在远程机器上建节点](/deploy/daemon)
- [生产部署 / 公网部署安全](/deploy/production)
- [升级指南](/guide/upgrade)
- [故障排查](/troubleshooting)
