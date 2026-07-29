# 让 hub 常驻：进程守护

hub 是整个网络的单点。它挂了，所有节点一起掉线。

但"把它跑起来"和"让它一直跑着"是两件事。本文讲后者，以及几个**看着是绿的、其实没在工作**的坑——每一个都是在生产上真踩过的。

::: tip 适用范围
自建 hub（`anet hub start` / `commhub-server`）的长期运行。
只是本地开发跑一下不需要这些。
:::

## 为什么裸跑 `nohup` 不够

最常见的起法是：

```bash
nohup commhub-server > hub.log 2>&1 &
```

这能跑，但有两个问题：

1. **进程一旦没了，没有任何东西会把它拉回来。** 崩溃、OOM、误杀都一样，只能靠人发现。
2. **误杀比想象中容易。** 如果机器上同时跑过测试实例，一条 `pkill -f commhub-server`
   会把生产和测试**一起**杀掉——它们进程名是同一个模式。

第 2 点值得单独强调，因为它的排查判据很干净：**同名进程全灭、而其他服务毫发无伤**，
基本可以断定是按名字批量 kill，而不是 OOM（OOM 只挑一个）或崩溃（只死一个）。

**结论：清理进程只按精确 PID，永远不要 `pkill -f` / `killall`。**

## 坑一：你的 hub 可能正在从 `/tmp` 里跑

如果启动命令是 `bunx`/`npx` 加一个钉死的版本：

```bash
bunx --bun @sleep2agi/commhub-server@0.9.0-preview.14   # ⚠️
```

那么**真正执行的二进制在 `/tmp` 的缓存目录里**：

```
/tmp/bunx-<uid>-@sleep2agi/commhub-server@0.9.0-preview.14/node_modules/.bin/commhub-server
```

查一下自己是不是这样：

```bash
tr '\0' ' ' < /proc/<hub-pid>/cmdline    # 路径里出现 /tmp 就中招了
```

**这是一种只在下次重启才暴露的故障。** 当前进程一直好好的，`/health` 一直 200，
任何"看当前状态"的检查都发现不了。等 `/tmp` 被清掉（系统重启、tmpwatch、手工清盘），
下一次启动直接失败——而那通常正是你最需要它起来的时候。

**改成固化安装**，把启动路径从 `/tmp` 和网络上摘下来：

```bash
mkdir -p ~/.commhub/runtime && cd ~/.commhub/runtime
cat > package.json <<'EOF'
{
  "name": "commhub-runtime",
  "private": true,
  "dependencies": { "@sleep2agi/commhub-server": "0.9.0-preview.14" }
}
EOF
npm install
```

之后直接 exec 装好的入口即可。附带好处：**启动不再需要联网**，registry 挂了也能重启。

换版本 = 改 `package.json` 的版本号 + `npm install` + 重启，
然后**必须 `curl /health` 确认版本号真的变了**。

## 启动脚本：四道 fail-closed 预检

在真正启动前挡住这几种情况，每种都把原因写进日志：

| 情况 | 行为 | 理由 |
|---|---|---|
| 找不到运行时（bun/node） | 拒绝启动 | — |
| 固化安装缺失 | 拒绝启动 | 提示去重跑 `npm install` |
| 密钥缺失或为空 | **拒绝启动** | 带空密钥起来会让密文静默解不开，比起不来更难查 |
| 端口已被监听 | **拒绝启动** | 绝不允许第二个 hub 抢同一个数据库 |

最后一条尤其重要：两个 hub 进程指向同一个 SQLite 库，是能"跑起来"的，
问题会以极难复现的方式在别处冒出来。

预检失败时建议 `sleep 30` 再退出（**慢速失败**），给进程管理器的退避留时间。
有服务因为立即失败 + 立即重启，一夜重启了三万多次，整晚在锤 registry。

::: warning 端口和数据库路径必须可以被环境变量覆盖
否则任何"验证这个脚本能不能跑"的尝试，都会跑去抢生产端口——
既验证不了什么，还会造出一个不停重启的失败条目。

要验证的必须是**这个脚本本身**，而不是一个长得像它的副本。
:::

## 坑二：pm2 不认 `.cjs` 配置文件

用 pm2 托管时，配置文件名有讲究。给它一个 `hub.ecosystem.cjs`：

```bash
pm2 start hub.ecosystem.cjs      # ⚠️ 不会按配置解析
```

pm2 **不会把它当配置**，而是**当普通脚本执行一遍**，然后：

- 进程名显示成文件名（`hub.ecosystem`），**不是**配置里写的 `name`
- 状态显示 `online`
- **端口没人监听，服务根本没起**

这是一个带着绿勾的空跑。判据是 `pm2 jlist` 里的 `name` 和配置里写的对不上。

**配置文件必须命名为 `*.config.js` / `*.json` / `*.yaml`。**

## 坑三：`min_uptime` 必须和失败路径配套

`min_uptime` **只存在于 ecosystem 配置文件里，pm2 命令行不认这个参数**。
所以用 CLI 起的服务，这个值一直是缺的（默认 1 秒）。

配上前面说的"慢速失败"（`sleep 30; exit 1`）就会出事：
30 秒 > 默认的 1 秒 → pm2 认为这次**已经稳定启动过**，于是把指数退避的延迟**重置**了。
结果是每次失败都从头退避，**以恒定的高频率无限重启**。

实测（失败路径 5 秒、`max_restarts: 3`，两个 app 只差 `min_uptime` 一项）：

| | `min_uptime: 1000`（低于失败路径） | `min_uptime: 15000`（高于失败路径） |
|---|---|---|
| 3.5 分钟内重启次数 | **15 次，还在涨** | **2 次，不动了** |
| 退避是否真的生效 | 否，每次被重置 | 是，间隔迅速拉长 |

**规则：`min_uptime` 要大于启动脚本失败路径的耗时。** 失败路径 sleep 30 就设 45000。

::: warning 设了 exp_backoff_restart_delay 就别指望 errored 状态
上面两个实测 app **谁都没有进入 `errored`**，哪怕 `max_restarts` 只设了 3。
设置 `exp_backoff_restart_delay` 之后，pm2 用**指数退避取代**了"到达 max_restarts 就停手"的行为——
它会一直重试下去，只是间隔越来越长。

所以 `min_uptime` 的价值不是"失败够多次就停下来报错"，而是**让退避真正生效**。
如果你需要"服务挂了要有人知道"，必须靠**外部监控**（比如定时探 `/health`），
不能指望 pm2 自己进入 `errored` 来提醒你。
:::

一份可用的配置：

```js
// hub.ecosystem.config.js —— 注意文件名后缀
const SHARED = {
  script: '/path/to/hub-daemon.sh',
  interpreter: 'bash',
  autorestart: true,
  min_uptime: 45000,               // 大于失败路径的 sleep
  max_restarts: 20,
  exp_backoff_restart_delay: 200,  // 指数退避，别空转
  kill_timeout: 10000,             // 留时间收尾 SSE 连接和 WAL
  max_memory_restart: '2G',
};

module.exports = {
  apps: [
    { ...SHARED, name: 'commhub-hub',
      env: { HOST: '0.0.0.0', PORT: '9200' } },
    // 只用来验证 pm2 是否真的接受上面每一个选项，验完就删
    { ...SHARED, name: 'commhub-hub-selftest',
      env: { HOST: '127.0.0.1', PORT: '19200',
             COMMHUB_DB: '/tmp/selftest/hub.db' } },  // 绝不指向生产库
  ],
};
```

`selftest` 那个条目和生产条目**共用同一份 `SHARED` 选项**。
跑通它 = 真的验证了生产条目的选项集，而不是验证了一个"长得像它"的副本。

## 密钥不要交给进程管理器

如果 hub 需要 vault 密钥（`ANET_HUB_SECRET_VAULT_KEY`），
**不要写进 ecosystem 配置**。pm2 会把 env 存进 `~/.pm2/dump.pm2`，
那个文件的权限比你想要的松。

把密钥放进独立文件、权限收到 `600`，由启动脚本在运行时读入：

```bash
umask 077
echo "ANET_HUB_SECRET_VAULT_KEY=<你的密钥>" > ~/.commhub/hub.env
chmod 600 ~/.commhub/hub.env
```

启动脚本里这样加载：

```bash
set -a
source ~/.commhub/hub.env
set +a
```

::: danger 不要用 export $(grep ...) 这种写法
`export $(grep KEY file | xargs)` 在 grep 没命中时会退化成裸 `export`，
把**整个环境**打印出来——包括其他 token。
:::

改完之后逐个文件确认密钥没有外泄（只看计数，不要打印值）：

```bash
grep -c 'ANET_HUB_SECRET_VAULT_KEY' ~/.pm2/dump.pm2 hub.ecosystem.config.js *.log
# 期望全是 0
```

## 验证：必须真的杀一次

配置写完不等于守护生效。**在 selftest 实例上真杀一次**：

```bash
kill -9 <selftest-pid>
# 然后轮询
curl -sf 127.0.0.1:19200/health
```

两个判据都要满足：

- `/health` 恢复 200
- **PID 变了**（否则只是没死透，不是被拉起来了）

正常应该几秒内回来。验完记得 `pm2 delete` 掉 selftest。

::: warning 多道闸门的红测，要各自报出各自的原因
测那四道预检时，只断言"跑完之后端口没有监听"是不够的——
任何一种提前失败都能满足它。

实测踩过：四个用例**全部卡在第一道闸门**（运行时路径写错了），
后三道一次都没被执行到，而断言全绿。

让每道闸门输出可区分的原因文字，红测里各自 grep 各自那条。
四条原因互不相同，才算四道都验过。
:::

## 和 cron 看门狗共存

如果之前还有一个 cron 看门狗脚本在拉 hub，**它必须检测到 pm2 已经托管就让路**：

```bash
if pm2 jlist 2>/dev/null | grep -q '"name":"commhub-hub"'; then
  echo "由 pm2 托管，看门狗不介入"
  exit 0
fi
```

否则会裸起一个 pm2 不认识的进程，变成"pm2 起的 + 看门狗起的"两个实例抢同一个库。

看门狗自己也要有两条约束：**连续多次探测失败才动作**（避免瞬时抖动误重启），
**动作前确认端口确实没人监听**（端口还在 = 慢而不是死，不该再起一个）。

## 开机自启

pm2 需要一条 root 权限的命令才能在系统重启后自动拉起：

```bash
sudo loginctl enable-linger <user>
pm2 save
```

不跑也能正常用，只是服务器重启后要手动 `pm2 resurrect`。

::: warning pm2 save 要放在最后
确认服务真的起来了再 `pm2 save`，否则会把坏状态固化进开机自启。
:::

## 换配置时的顺序

最后一条，也是代价最惨痛的一条：

**永远先验证新的能起来，再动旧的。**

不要 `pm2 delete <旧>` 然后 `pm2 start <新参数>`——
`delete` 是不可逆的一步，`start` 是可能失败的一步（比如用了 CLI 不认的参数）。
把不可逆的放在可能失败的前面，等于把生产押在"我猜这些参数都对"上。

用 ecosystem 文件的话可以直接原子替换，不必先删：

```bash
pm2 startOrReload hub.ecosystem.config.js --only commhub-hub
```

## 相关

- [生产部署 / 公网部署安全](/deploy/production)
- [干净服务器从零部署](/deploy/clean-server)
