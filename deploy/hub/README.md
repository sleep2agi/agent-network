# 生产 Hub 换版本

> 面向用户的守护说明（PM2 入口、`min_uptime` 怎么定、自动恢复四项验证）在文档站
> [部署 / 让 Hub 常驻](https://anet.sh/deploy/keep-alive)。本目录是那一页所引用的 **Git 权威**。

对应 `AGENTS.md` §19。与 `deploy/dashboard/` 同一套「固化安装 + 指针切换」模式,
但 Hub 是**全网唯一**的,所以每一步的代价更高。

🔴 **这份文档标注为「已演练」** —— 2026-08-13 真跑过一次
(`0.9.0-preview.27 → 0.9.0-preview.29`),证据见 `docs/tests/report-hub-upgrade-preview29.txt`。
这是 `deploy/` 下目前唯一不是「未演练」的一份。

## Git 权威副本与空机安装

生产机上的 `~/.local/bin/hub-daemon.sh` 是**部署副本**；权威源是本目录的
[`hub-daemon.sh`](./hub-daemon.sh)。PM2 的非敏感进程定义在
[`ecosystem.config.cjs`](./ecosystem.config.cjs)。换版本时必须在同一个变更里更新 Git
副本的 `RUNTIME_DIR` 和变更历史，不能只改服务器孤本。

```bash
# 0. bun —— hub-daemon.sh 对它是硬依赖,缺了会 fail-closed 停在
#    「找不到 bun」。这一步此前只写在脚本注释里,不在步骤里(#778)。
#
#    当前生产用 nvm 的 npm 安装,所以 binary 落在当前 node 的 bin 下；换
#    node 版本后通常要重装。若采用其它布局,必须让 command -v bun 可见,
#    或在 hub.env 显式设置可执行的 BUN_BIN。
BUN_VERSION=1.4.0   # 2026-09-04 改:1.3.14 在 .45 上三次 uWS panic;1.4.0 生产跑满 24 h(31.5 h,restarts 不变)后钉过来
npm i -g "bun@$BUN_VERSION"
BUN_BIN="$(command -v bun)"
test -x "$BUN_BIN"
test "$("$BUN_BIN" --version)" = "$BUN_VERSION"  # 版本不符即停,不拿 future latest 冒充当前运行时
#    (不要用 `curl … | bash` 一行流:管道退出码只反映 consumer,
#     curl 失败会被吞掉 —— 见 #729 / #733 / #743。)

install -d -m 700 "$HOME/.local/bin" "$HOME/.commhub"
install -m 700 deploy/hub/hub-daemon.sh "$HOME/.local/bin/hub-daemon.sh"

# 部署后必须证明机器副本等于 Git 权威；不是只看 bash -n。
test "$(git hash-object deploy/hub/hub-daemon.sh)" = \
     "$(git hash-object "$HOME/.local/bin/hub-daemon.sh")"
bash -n "$HOME/.local/bin/hub-daemon.sh"
```

### Bun 版本与 panic(#1769)

- **事实**:2026-09-02 生产 hub 升到 commhub-server `.45` 后,Bun **1.3.14** 在 `uWS HttpContext::onClose`
  连续 panic 三次(`Segmentation fault`,pm2 自动拉起,restart_time 10 → 13)。当晚 23:03 只换 bun 不换 hub:
  `~/.commhub/hub.env` 追加 `BUN_BIN=<nvm node v24>/bin/bun`(**1.4.0**),`pm2 restart commhub-hub`
  (不加 `--update-env`),之后再无重启。启动器 `_resolve_bun` 先看 `BUN_BIN`,再看 PATH。
- **上面的 `BUN_VERSION=1.4.0` 就是生产实际跑的版本**(2026-09-04 06:31 复核:自 09-02 23:03 起 31.5 h 无重启,pm2 restarts 停在 13),钉与生产对齐。
- **稳定性判据只认两个数**,不要数错误日志里的 panic 行(pm2 日志会轮转,2026-09-03 复核时那份日志已经找不到了):

  ```bash
  pm2 jlist | python3 -c "import json,sys,time;[print(a['name'],a['pm2_env']['status'],'restarts='+str(a['pm2_env'].get('restart_time',0)),'up_h=%.1f'%((time.time()*1000-a['pm2_env'].get('pm_uptime',0))/3.6e6)) for a in json.load(sys.stdin) if a['name']=='commhub-hub']"
  # 判据:restart_time 不变 + up_h 单调增长;真跑的 bun 用 /proc/<pid>/exe 看,不看 `bun --version`
  ```

- **回滚**:删掉 hub.env 里的 `BUN_BIN` 行(或恢复 `hub.env.bak-bun1314-20260902-230319`)+ `pm2 restart commhub-hub`。

### secret 与数据不在 Git

`$HOME/.commhub/hub.env` 必须是 owner-only（建议 `0600`），至少提供非空的
`ANET_HUB_SECRET_VAULT_KEY`。**只记录变量名，不把值提交到仓库、PM2 配置或日志。**
它是解密既有 vault 密文所需的恢复材料：空机恢复必须从独立加密备份或由网络 owner
安全交付**原值**；若只重新生成一个新值，旧密文不会恢复。该恢复材料的具体保险库记录名
目前仍是 NOT COVERED，补齐前不得宣称数据恢复闭环。

生产 SQLite 内容同样不在 Git。用本 runbook 的 `VACUUM INTO` 一致性备份恢复，或接受
空库后重新注册节点；不得把活跃 WAL 库当普通文件 `cp`。

### 从空 PM2 恢复进程定义

先完成 sibling runtime 安装、`hub.env`/DB 恢复和上面的 launcher 安装，再执行：

```bash
pm2 start deploy/hub/ecosystem.config.cjs --only commhub-hub
pm2 save
```

当前生产定义的非敏感坐标是：`bash` interpreter、fork mode、autorestart、
`min_uptime=20000`、`max_restarts=20`、指数退避起点 `200ms`、cwd=`~/.commhub`。
环境值由 launcher 的 `hub.env` 加载，不复制进 ecosystem 文件。

恢复后仍必须跑下文五条验证；`pm2 online` 不是恢复成功判据。

## 拓扑

```
pm2 app  commhub-hub
  └─ script  ~/.local/bin/hub-daemon.sh   (bash)
       └─ RUNTIME_DIR="$HOME/.commhub/runtime-vNN-<label>"   ← 版本切换点,只此一行
            └─ exec bun <RUNTIME_DIR>/node_modules/@sleep2agi/commhub-server/bin/commhub.ts
```

启动脚本自己维护一份变更历史,每次切换都追加「从哪到哪 + 回滚目标」。**照做,别省。**

## 为什么不用 `bunx`

脚本注释里写了:`bunx --bun @sleep2agi/commhub-server@<版本>` 执行的二进制落在
`/tmp/bunx-*/node_modules/.bin/`,**任何 `/tmp` 清理都会让生产在下次重启时起不来**。
固化安装把运行时从缓存目录里摘出来。

## 换版本(实测顺序,一步都别省)

```bash
# 1. 回滚坐标三件套 —— 先记下来
pm2 describe commhub-hub | grep -E 'script path|pid'
readlink /proc/<pid>/cwd
grep '^RUNTIME_DIR=' ~/.local/bin/hub-daemon.sh
curl -s localhost:9200/health          # 记下当前 version

# 2. 备份:启动脚本 + 一致性 DB 备份(不要 cp,WAL 在写)
cp ~/.local/bin/hub-daemon.sh ~/.local/bin/hub-daemon.sh.bak-<旧版本>-$(date +%Y%m%d-%H%M%S)
bun -e "new (require('bun:sqlite').Database)('<db>',{readonly:true}).exec(\"VACUUM INTO '<备份路径>'\")"
# 验备份:PRAGMA integrity_check 必须 ok,并记下 sessions/tasks 行数

# 3. sibling 固化安装(不动正在跑的那个目录)
mkdir -p ~/.commhub/runtime-vNN-<label> && cd $_
printf '{"name":"commhub-runtime","private":true,"version":"1.0.0","dependencies":{"@sleep2agi/commhub-server":"<新版本>"}}' > package.json
npm install

# 4. 🔴 旁路验证 —— 备用端口 + DB 的【副本】,绝不碰生产库
COMMHUB_DB=/tmp/verify.db PORT=9291 HOST=127.0.0.1 \
  bun ~/.commhub/runtime-vNN-<label>/node_modules/@sleep2agi/commhub-server/bin/commhub.ts &
curl -s localhost:9291/health                     # 版本对不对
curl -s -H "Authorization: Bearer <verify-token>" localhost:9291/api/status   # 真实数据读得出来吗
# 验完按精确 PID 停掉,删掉验证库

# 4b. 🔴 #1493 fail-closed 迁移预检(升到含 user_inbox NOT NULL 迁移的版本时)
#   若存量 user_inbox 有 network_id IS NULL 行,迁移会 **warn + 跳过**(列暂保持可空)、
#   hub 照常启动(fail-safe,不停机——SDK马/通信龙 复核:NOT NULL 只是 belt-and-suspenders,
#   代码级三闸已挡新 NULL,不该为冗余保险带打死全舰 hub)。⇒ step 4 旁路 boot 的日志里若出现
#   `[migrate #1493] ... 已跳过 ... network_id IS NULL`,说明生产库有 NULL 孤儿(与三闸矛盾、
#   可能更早漏洞):**先查孤儿来源、清理后下次启动幂等自动完成迁移,别盲清**。想升级前显式确认可对 DB 副本跑:
COMMHUB_DB=/tmp/verify.db bun -e "console.log(new (require('bun:sqlite').Database)('/tmp/verify.db',{readonly:true}).query('SELECT COUNT(*) AS n FROM user_inbox WHERE network_id IS NULL').get())"
#   (生产背景:hub 当前 .38、user_inbox 是 .41 才建表 #1495,现在根本没这张表 → 直接建成
#    NOT NULL 新表、无迁移;经过 .41+ 才有行但代码级三闸从 .41 就在、行应非 NULL → 风险低。)

# 5. 原子替换:只改 RUNTIME_DIR 一行 + 追加变更历史
# 6. 🔴 pm2 restart commhub-hub    —— 【不要】带 --update-env
```

🔴 **`--update-env` 会丢掉 pm2 saved-env 里的 `ANET_HUB_SECRET_VAULT_KEY` 等**,
之后所有 vault 操作会抛 `vault_master_key_missing`。验证方式:重启后 grep 日志里
该关键字的出现次数必须是 **0**。

## 验证:这五条都要过

```bash
# ① 真跑的是哪个安装(权威,不看 pm2 状态)
tr '\0' ' ' < /proc/$(ss -ltnp | grep :9200 | grep -oP 'pid=\K[0-9]+')/cmdline

# ② 版本 + 数据量
curl -s localhost:9200/health          # version 与 sessions_count

# ③ 监听进程是 pm2 后代,不是孤儿(追祖先链,不是看一层 ppid)
# ④ vault 报错 0 行、unstable restarts 0
# ⑤ 🔴 舰团真的回来了:近 5 分钟心跳数 vs 升级前,以及节点侧 task.ack 是否继续产生
```

**第 ⑤ 条最重要** —— 前四条只证明「进程是新的」,只有它证明「舰团没被搞崩」。

## 回滚

把 `RUNTIME_DIR` 指回上一个目录,`pm2 restart`。**旧目录一律不删。**

### #906 的精确版本部署配置

`hub-daemon.sh` 默认值仍对应 CLI 的兼容基线，不是线上最新版本。
`hub-provider906.sh` 当前是 `.122` 的无密钥部署配置：选择
`~/.commhub/runtime-v106-preview122`，保留目标 Hub 原本开启的 side-thread
功能（显式设置 `COMMHUB_ENABLE_SIDE_THREADS=0` 仍有效）。不能只覆盖启动器
而未安装这个精确 runtime。发布源是 main
`231bf8c9711aacd9b2f78afce7c58a1873f3d280`，包是
`@sleep2agi/commhub-server@0.9.0-preview.122`；正式运行 `38121256184`
已完成 npm 发布与 registry 回读。锁文件使用同字节 GitHub 原包：
`commhub-server-v0.9.0-preview.122/sleep2agi-commhub-server-0.9.0-preview.122.tgz`，
SHA256 `a47a12d03db41fbf5bd2a95a0c0f4a2107d771c17aa3487c58c490fb000c553a`。
来源和新增表/字段的离线迁移结果见
`docs/tests/report-test906-hub122-preflight.txt`。预检通过不代表已部署。
此前 `.121` 的历史证据保存在 `report-test906-hub121-preflight.txt`，不能当作 `.122` 验收。

该部署的完整 npm 输入锁在 `deploy/hub/provider906/package*.json`，包括发布包
的 GitHub URL 与 integrity。空目录安装时复制这两个文件到上述 sibling
runtime，然后在该目录执行 `npm ci --ignore-scripts --no-audit --no-fund`。
不要只按版本重新解析浮动的传递依赖；保留旧 runtime 和密钥来源不变。

完成上述一致性备份、精确包固化安装和 Docker 旁路验证后，将合入 main 的
`deploy/hub/hub-daemon.sh` 安装为 `~/.local/bin/hub-daemon-base.sh`，将
`deploy/hub/hub-provider906.sh` 安装为既有 PM2 入口
`~/.local/bin/hub-daemon.sh`（均 0700）。逐一核对部署副本与 Git 文件字节一致。
PM2 定义、端口、反代、数据库路径与 `hub.env` 密钥来源不变，不使用
`--update-env`。按上文五条核对真实运行版本、心跳和 ack，再记录实际切换。

本次回滚目标是已保留的 `runtime-v105-preview121`。切换前备份原启动脚本；
需要回滚时恢复该备份并仅重启 `commhub-hub`，不删除 runtime 或数据库表。
软件回滚不撤销已应用的 Provider 配置；数据库内容和 vault 原始密钥仍需要
独立加密备份，Git 不含这些材料。此配置不改变 CLI `PINNED_SERVER_VERSION`，
也不升级任何 Daemon 或节点。

`.122` 比 `.121` 新增 `daemon_provider_logins` 意图表和
`node_create_requests.clone_json` 字段；OAuth token 仍只留在 Daemon，
不写 Hub 数据库。切换前将当前 SQLite 做一致性 `VACUUM INTO` 备份，
只向隔离 Docker 挂载离线备份副本，保留原库、vault 密钥及旧 runtime。
服务启动入口和共享启动器如上；继续使用既有 PM2 `commhub-hub` 定义、
9200 端口与原反代/隧道（不修改拓扑），原 `~/.commhub/hub.env` 是
由该主机管理员安全保管的密钥源，不得提交 Git 或拷贝其他节点身份。
实际切换只重启该 Hub；随后以 `/health` 的 `.122`、监听进程命令行、
近期节点心跳/任务 ack 校验真实生效。回滚恢复原启动器并只重启 Hub，
保留新增状态；存在未终结登录意图时先确认 Daemon 侧结果，不直接重放。
生产数据、vault 密钥和账号不由 clone 仓库恢复，必须从管理员的加密备份
或重新认证获取。备份策略和路径沿用本 runbook 前述生产备份步骤。

## 混版风险(必读)

`docs/release/versioning-and-compatibility.md` 的 **C2 契约**:
Hub 协议(注册 / SSE 事件 key / task envelope / `protocolVersion`)是
agent-node ↔ commhub-server 的耦合面,**改协议要 bump `protocolVersion` + hub 加向后兼容**。

所以升 Hub 时节点通常还是旧版 —— **这是预期状态,不是事故**,但必须验:
升级后节点侧 `task.ack` 事件要继续产生,且不出现「任务卡在 running/delivered 超过 5 分钟」。
