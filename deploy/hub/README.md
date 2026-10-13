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

### `.132` 部署候选（2026-10-13）

源码 PR2674 已正常合入 main `c49e9316826a064f1db715319fcc7adbde12527a`，MCP/REST 任务发送方
使用凭据解析出的节点 ID；改名同时核对节点与会话注册表。核心 HTTP、断言
变异、ACK/权限回归及旧 agent-node .110/.121 兼容均通过。
正式 main 发布运行 `38335516515` 仍须四道门、preview 发布及 registry
回读全部成功，不能只认构建任务通过。公开包必须逐字节等于该 main gated 包，
SHA256 `c2e3503a7819032c2e89ef73cfdf6235f0e48573ef5e4a268dc00775f9edf145`。

`provider906/package*.json` 钉 `.132` 及该 main 制品 SRI，传递依赖保持
原 lock；profile 选择 `runtime-v115-preview132`，回滚保留
`runtime-v114-preview131`。本段是部署候选，尚未声明生产已切换。

权威启动脚本、PM2、Bun1.4.0、数据库路径、端口/反代和 owner-only 密钥
来源沿用本 runbook。先以私有 `VACUUM INTO` 备份运行
`tests/test906-hub-upgrade-preflight` 离线预检；原子安装本目录 profile 后仅
重启 `commhub-hub`，保留原 base launcher、环境文件和旧 runtime。
核新进程真实入口、secured health、重启计数与自然心跳/任务事件；失败恢复
原 profile，不把短观察当全舰收发或数据灾难恢复验收。私有数据及密钥不入 Git。

### `.131` 部署（2026-10-13 已激活）

软件实现 main `9fc79fab1d697f665bf3e95d7c420a27e284a4dd`（PR2671），
HTTP/MCP 任务署名按认证身份记录，人类署名与节点回填、隐式父任务保持
分离；SQLite/PostgreSQL 核心和既有传输回归已通过。正式公开/部署
main `e81debac14db091da41ea02272dd2184b3b1744f`（PR2672），运行
`38331511688` 的构建、四道门、preview 发布与 registry 回读全部成功。
`provider906/package*.json` 钉 `.131`，公开包与正式 gated 包
逐字节一致，SHA256
`5384ecb96e40954d2a6d749ab05c5ca2e38827b70e079542cda6e308b26e4dba`。
传递依赖保持精确原 lock，不重新解析。

profile 选择 `runtime-v114-preview131`，回滚保留 `runtime-v113-preview130`。
启动权威仍为本目录 base launcher/profile/ecosystem；Bun1.4.0、PM2
`commhub-hub`、9200 及既有反代/隧道保持。密钥仍由管理员从原
owner-only `~/.commhub/hub.env` 安全供给，不改值或生成新 vault key。

先做 owner-only 一致性 SQLite 备份和完整性核对，在现有 Docker 离线
预检中用实际 Bun1.4 与公开包确认行数/Provider 状态保留。精确 lock
复制到 inactive sibling，用 `npm ci --ignore-scripts --no-audit --no-fund`
安装并核包文件。profile 必须通过 Actions Docker 目录/显式回滚检查，
正常合入 main 后才原子安装为 PM2 入口；只重启 `commhub-hub`，不加
`--update-env`。核真实 PID/入口、health `.131`、自然心跳和追加错误日志。
失败则恢复 `.130` profile，仅重启 Hub；保留两个 runtime 和原 DB。
账号、业务数据、vault key 依赖私有备份/原认证来源，Git 不提供这些
业务状态。灾难恢复、全网 ACK、长期稳定性及真实模型未由此验收。

2026-10-13 09:32:15（东八区）已按上述步骤激活；完整证据见
`docs/tests/report-test696-hub131-activation.txt`。345 个安装包文件
与匿名公开/gated 包相同；一致性备份完整性为 ok，实际 Bun1.4 离线
预检保留 331 sessions / 81384 tasks / 302 nodes 等全部所检表行数。
真实 PID515557、入口 v114-preview131、health131/secured，PM2 restart
88→89；env 元数据及 base launcher 保持，profile 与精确 main 相同。
短窗已见自然心跳、投递和回复，追加日志没有新 vault key 缺失或崩溃
标记。少量投递 stale warning 和既有调度 stuck timeout 另按元数据记账，
不把服务恢复说明成全网任务已经完成。

### #689 `.130` 部署（2026-10-13 已激活）

精确软件 main `7f12230b7eb064aa56131bbc17fc21c944f9a6d0`（PR2668），
正式发布运行 `38326074270` 的构建、四道门、preview 发布与 registry
回读均 SUCCESS；验收见 `report-test689-hub130-activation.txt`。本轮 source
核心 Docker CI SQLite/PostgreSQL 各 36 项通过。

当前目录的 `provider906/package*.json` 将 sibling 输入钉为 `.130`，
包 SHA256 `91fde58a1c8411a1e4d242faa55fea19fb7a9fa844aaa070c3075bdc98976f80`；
部署前必须确认公开下载与正式 main gated 包完全一致。传递依赖没有重新解析。
profile 选择 `runtime-v113-preview130`，回滚保留 `runtime-v112-preview129`。
启动权威仍为本目录 base launcher/profile/ecosystem；Bun1.4.0、PM2
`commhub-hub`、9200 与既有反代/隧道、DB 路径保持。密钥仍由管理员从
原 owner-only `~/.commhub/hub.env` 供给，不改值或新生成 vault key。

先做 owner-only `VACUUM INTO` 一致性备份、完整性核对与现有 Docker
离线迁移预检，再复制精确 lock，以 `npm ci --ignore-scripts --no-audit
--no-fund` 安装 inactive sibling 并逐字节核对公开包。profile 必须通过
Actions Docker 目录/显式回滚验证并正常合入 main，之后才原子安装为
现有 PM2 入口。仅 `pm2 restart commhub-hub`，不加 `--update-env`。
切换后核对真实 PID/入口、health `.130`、心跳与错误日志；失败则恢复
备份的 `.129` profile 并仅重启 Hub。软件无 schema/adapter/dependency
变化；数据、账号与 vault key 仍依赖私有备份/原认证来源，Git 不提供
这些业务状态。本轮不宣称灾难恢复、真实模型或全网 ACK 已验收。

2026-10-13 08:21:23（东八区）已按上述步骤激活，部署源 main
`d8537c633dc3573419c1bd1d8b28ea5c394212c1`（PR2669），软件源仍为
`7f12230b7eb064aa56131bbc17fc21c944f9a6d0`。installed 344 个包文件
与公开/gated 包逐字节相同；生产 Bun1.4.0 的 offline preflight 保留
331 sessions / 81264 tasks / 302 nodes 等全部表计数与 provider 行。
真实 PID459109、parent1613、入口 v113-preview130，health130/secured。
PM2 restart87→88，仅本次手动重启；环境文件元数据与 base launcher
保持。切换后已见自然心跳、投递和回复终态，自有 inbox 读取正常；
日志追加窗 vault_master_key_missing/panic/segfault 为0。未以短观察
替代全网 ACK、长期稳定性、真实账号/模型或节点密钥 metadata 验收。

### #688 / #1075 `.129` 配置（2026-10-13 已激活）

本轮精确软件 main 为 `45a7cff26b389bc9e09301bf1729922d9a6ae052`，
正式发布运行 `38322287810` 的构建、四道门、preview 发布及 registry
回读全部 SUCCESS。匿名完整 tarball 与该 main 的 gated 包逐字节相同：
1,234,902 字节，SHA256
`0dc85276a093caf33f55431969d3cc680c0519a8624cdf34c23447d919fa558c`。
该轮 PR2666 的 `provider906/package*.json` 锁定实际 npm URL、SHA512 integrity；
传递依赖未重新解析或变更。npm latest 渠道保持原值。

profile 选择新 sibling `runtime-v112-preview129`，保留当前
`runtime-v111-preview128` 与旧入口用于回滚。软件包含收件/ACK 调用者
校验和节点密钥能力的心跳 schema 修复；没有 DB/adapter/schema 变化。
常驻启动、Bun、PM2、9200、反代/隧道和原 owner-only `hub.env` 来源保持。
复制精确 lock 后以 `npm ci --ignore-scripts --no-audit --no-fund` 固化安装。
当前一致性 SQLite 备份留在主机 owner-only backups，不能上传至 CI；
现有 Docker 离线 preflight 可通过 `HUB_PREFLIGHT_VERSION` 与
`HUB_PREFLIGHT_INTEGRITY` 指定本次公开包的独立预期值，旧 `.126` 默认仍可用。

profile 必须先通过 Actions Docker 目录选择/显式回滚检查并正常合入
main，才可原子安装为现有 PM2 入口；逐字节核对 Git 与安装副本。
仅 `pm2 restart commhub-hub`，不加 `--update-env`；随后核对真实
监听 PID/包目录、health `.129`、自然节点心跳/ACK 和新增错误日志。
若失败则恢复备份的 `.128` profile 并仅重启 Hub，保留两个 runtime、
DB 和旧状态。内存中未确认的密钥请求会过期/丢失，不能盲重放。

软件发布和 profile 检查不代表已激活或密钥实际读写已验。原 vault
密钥、账号和 DB 内容仍依赖管理员的加密备份或重新认证；Git 只重建
软件和过程，不提供这些数据，也不宣称本轮完成灾难恢复演练。

2026-10-13 07:42:03（东八区）已按上述流程窄切换。部署源 main
`b7993870774ee3477812f16bea74400549f412a2`（PR2666）；软件源仍为
`45a7cff26b389bc9e09301bf1729922d9a6ae052`，入口不是分支构建。
切换前一致性备份完整性通过，旧 `.128` 入口/runtime 保留；公开包和
新安装全部 343 文件字节相同。安装 Git profile 后只重启既有 Hub，
没有 `--update-env`。实际 PID `427293`、父 PM2 `1613`，入口为
`runtime-v112-preview129`；health `.129`/secured/330 会话，SSE 恢复120，
切换后自然心跳115。本人MCP收件可用，不存在验证别名的读取/ACK均被
身份检查拒绝，没有访问其他节点收件或修改真实任务。
截至07:44:38，PM2重启计数86→87只有这次操作；新增日志采集区间内
vault缺失/panic为0。完整证据见 `report-test688-hub129-activation.txt`。
节点密钥已有两个新心跳能力字段落库，合法用户的真实目标元数据回读
仍待原#1075收口；本次不外推密钥实写或所有 runtime 完成。

### #906 的精确版本部署配置

`hub-daemon.sh` 默认值仍对应 CLI 的兼容基线，不是线上最新版本。
以下 `.122` / `.124` / `.125` 段落是已部署历史；`.126` 已激活，
`.127` 的待激活精确配置与回滚见本节末尾。
`hub-provider906.sh` 的历史 `.122` 无密钥部署配置选择
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

### #906 / #907 上一轮 `.124` 配置（2026-10-11 已切换）

上一轮已部署的入口 `hub-provider906.sh` 选择 `runtime-v107-preview124`；原
`runtime-v106-preview122` 保留为回滚目标。包从精确 main
`ad381202cbba00c80efc30522801dedd810fbbea` 的正式运行 `38142238557`
构建，四道门及发布/registry 核实全部通过。匿名下载与正式构建 tarball
SHA256 相同：`e4391276facfcd5908c9e773ee6e0898ce14402247458ca068e8ce4e6b1d9748`。
`deploy/hub/provider906/package*.json` 记录实际 npm URL、完整 integrity 和
传递依赖锁；复制到空 sibling 目录再 `npm ci --ignore-scripts --no-audit
--no-fund`，不覆盖旧安装或使用浮动依赖。

本版本新增 `hub_provider_configs` / `hub_provider_bindings`，保留既有登录
意图及 Provider 状态。切换前按上文生成一致性离线备份，在独立 Docker
中用正式包验证迁移、旧行数及启动/认证读；不将活库或 `hub.env` 挂入测试。
上述预检通过、且部署入口已合入 main 后，才安装 Git 的共享启动器和版本
配置（0700），逐一核对字节，保留原入口备份；只重启 `commhub-hub`，不加
`--update-env`。按实际监听进程、`/health` `.124`、新心跳/ack 和错误日志
核对，而不是只看 PM2 online。端口9200、反代/隧道、DB 路径和权限不变。

密钥仍来自主机管理员的 owner-only `~/.commhub/hub.env`；Hub Provider
vault 要求原 `ANET_HUB_SECRET_VAULT_KEY` 为32字节的64位十六进制值。
仅检查是否符合格式，不输出值、不换身份或新造密钥替换旧密文来源。
DB 和该原始密钥必须通过独立加密备份恢复，具体保险库记录名仍未覆盖，
Git clone 不含数据或登录账号。回滚恢复原入口选择保留的 `.122` 并仅
重启 Hub；保留新增表和待处理状态，软件回滚不撤销已完成的绑定。
2026-10-11 21:40:50（东八区）已按上述流程切换：部署入口来自合入 main 的
`fb2e5c81ac361d5554530af1925dae41542b5039`（PR2604），运行的 npm 包仍是上述
`ad381202` 正式构建。监听9200的实际 Bun PID3094572，父进程为既有 PM2
PID1613；`/health` 返回`.124`、320会话、secured。41秒内SSE恢复113连接，
随后两台Daemon及云盘牛、TMAI狗、客户端牛、TMHR均有新心跳；TMAI负责人
保留升级前的认证故障离线状态，不冒称恢复。自然业务已有两次任务投递和
启动事件，最初观察窗尚无新`task.ack`，这一项需继续观察而不是派生产测试。
启动器备份位于 owner-only `~/.commhub/backups/provider906-p124-s7X783/`。
具体预检与切换边界见 `docs/tests/report-test906-hub124-preflight.txt`；不宣称
真实 vault/模型权益验证、客户端241已发布或空机恢复演练完成。

### #1020 `.125` 配置（2026-10-11 已切换）

本次 `hub-provider906.sh` 默认目录改为
`runtime-v108-preview125`；保留上述已运行 `.124` 的
`runtime-v107-preview124` 作为回滚目标。软件源码已合入精确 main
`519af0236985957bb0ff70685052673bdd0b2373`，正式发布运行是
`38151056880`，构建、四道门及发布/registry 核实均成功。
2026-10-11 23:48（东八区）Docker 匿名下载的正式 npm tarball 与
CI 制品字节摘要匹配：1229363字节、SHA256
`f289b40562f5f2a87f38cb6cf9dc8a439efb23c7b56930375bcb688dc9fac555`。

2026-10-11 23:59（东八区）已按上述流程窄切换。部署配置来自正常合入
main 的 `30f803318a8bcfc3b3737c2b577d9fe5faee1b40`（PR2609），与软件
包源 `519af023` 分别记录；Git 启动器与安装副本逐一 `cmp` 相同，0700。
仅 `pm2 restart commhub-hub`，没有 `--update-env`，未重启 Daemon 或业务节点。
监听9200的实际 Bun PID3216148，父PM2 PID1613，命令行选择上述 `.125`
固化安装；Bun1.4.0 实际二进制摘要与 Docker 预检相同。健康接口返回 `.125`、
321会话及 `security=secured`，28秒自然恢复113条SSE连接；到次日00:00，
两Daemon及云盘牛、TMAI狗、客户端牛、TMHR均有切换后的新心跳。
TMAI负责人保留升级前的认证故障离线状态，不冒称修复。初始观察窗新增日志
中 vault 缺失和 panic 均0，尚无新 `task.ack`，继续观察自然回执，不派生产测试。
PM2 restart计数仅本次人为操作81→82，观察窗没有额外重启。
次日00:04只读回看本网络自然 `task_events`：切换后15次投递、17次启动、
19次回复，最新回复00:04:27；独立 `task.ack` 仍0。前面的日志观察不等于
持久任务事件查询；本次未制造任务、读消息内容或改变任何事件。
一致性DB备份及旧入口位于 owner-only
`~/.commhub/backups/provider1020-p125-SrAkL8/`；旧 `.124` 安装保留。
具体字节、隔离预检和激活证据见
`docs/tests/report-test1020-hub125-preflight.txt`。此升级不宣称解决 #1027
子节点token401，也不代表客户端 `.243` 已发布或生产模型权益验证。
精确 URL、SHA512 integrity 和未变的传递依赖锁已记录在
`provider906/package*.json`；本节不能作为“已经部署”的证据。

`.125` 增加 Provider 对已存 vault 名称的显式引用；不新增本次数据库
迁移，也不自动轮换已分发的密钥副本。第一条已验证适配链是
Codex Responses/API key，不代表所有 runtime 或真实供应商权益。
客户端引用入口要求 Hub `.125`、CLI `.166`、runtime `.132`；
客户端 `.242` 的密钥库入口不等同后合入的引用 UI。

正式切换仍按前述流程：先核对公开 tarball 与发布制品的精确摘要，
更新 `provider906/package*.json` 的实际 URL、integrity 和依赖锁；
生成当前数据库一致性备份，在 Docker 中用离线副本检查包、schema、
启动与认证。只有这些输入落位、部署入口合入 main 后，才可从 Git
安装共享启动器和配置，安装到新的 sibling 目录并窄重启
`commhub-hub`（不加 `--update-env`、不重启业务节点）。随后核对
监听进程实际目录、`/health` `.125`、自然节点心跳/ack 和错误日志。

服务仍用既有 PM2 定义、Bun、9200 端口及前述反代/隧道；DB 路径和
权限不变。密钥继续由主机管理员从原 owner-only `hub.env` 提供，
不能生成替代 vault 密钥。回滚恢复已保留 `.124` 的入口并仅重启
Hub，保留数据库与已分发状态。生产数据库、原 vault 密钥和登录账号
只能从管理员的加密备份或重新认证恢复，不包含在 Git；保险库记录名
未覆盖这一缺口继续保留，不宣称已完成空机恢复演练。

### #1027 `.126` 部署（2026-10-12 已激活）

本次配置选择 `runtime-v109-preview126`，原 `.125` 的
`runtime-v108-preview125` 与原入口保留为回滚目标。正式软件来自 main
`42fcf114a77b7862c55ec32328923eced9b43f22`；发布运行 `38165547126`
的四道门、npm 发布与 registry 核实均 SUCCESS。匿名 Docker 下载的
正式 tarball 与该运行的 gated-tarball 内层包字节相同：1230017 字节，
SHA256 `9ab55f1ff33c1802749ee647998d7d016fc04e81fe0112df282c595436cb3817`。
精确 URL / SHA512 integrity 在 `provider906/package*.json`，传递依赖锁未变。

`.126` 在创建请求回读中补齐 `network_id`，配套 Daemon 要使用 CLI
`2.3.0-preview.167` / runtime `2.5.0-preview.133`；客户端 `.244` 本身
不会升级这些服务。软件发布不代表生产激活或三 runtime 建节点验收。
原 `.125` 的离线一致性备份已完成 `.126` schema/启动/认证核心预检，
见 `docs/tests/report-test1027-hub126-preflight.txt`；旧备份不是当前生产快照。

激活前仍按上文流程重新保存原启动器并生成当前 DB 一致性备份；把本节
精确锁复制到新的 sibling 目录，执行 `npm ci --ignore-scripts --no-audit
--no-fund`。部署配置正常合入 main 后，安装 Git 共享启动器和此 profile，
逐一核对部署副本字节。服务继续使用既有 PM2 `commhub-hub` 定义、Bun、
9200 端口、原反代/隧道、原 DB 路径与 owner-only `hub.env`；不复制或
替换密钥。只重启 Hub，不使用 `--update-env`，不重启业务节点。
随后核对真实监听进程入口、`/health` `.126`、自然心跳/任务回执与错误日志。

失败时恢复原 `.125` 入口并只重启 Hub，保留两个安装目录、DB 与配置备份。
软件回滚不回退节点会话或已分发 Provider 状态。生产 DB、vault 原密钥和
账号仍来自管理员加密备份或重新认证，不包含在 Git；密钥备份保险库记录名
未覆盖的旧缺口保留，未宣称完整空机恢复或现实 OAuth / 模型权益验证。

2026-10-12 03:12:33（东八区）按上述流程窄切换：部署源 main
`b63b844e5766c2fc012757689b62863a83a89977`（PR2627），正式包软件源
仍为 `42fcf114a77b7862c55ec32328923eced9b43f22`。切换前新一致性备份
位于 owner-only `~/.commhub/backups/create1027-p126-YGAMoP/`，旧入口和
共享启动器均保留；新备份的 schema、真实安装包启动与隔离认证读在 Docker
通过后才安装 Git 的两个启动器（0700、逐一 cmp 相同）。仅执行
`pm2 restart commhub-hub`，没有 `--update-env` 或业务节点重启。
实际 Bun PID3381400、父 PM2 PID1613，入口为 `runtime-v109-preview126`；
03:13:44 健康接口为 `.126`、323 会话、114 SSE，新增日志 vault 缺失/panic
均0，PM2 计数83→84仅本次人为操作。Daemon 和业务节点有切换后自然心跳；
初始日志观察未见独立 `task.ack`，不将此项算已验或制造生产测试。
详细证据见 `docs/tests/report-test1027-hub126-activation.txt`。两台 Daemon
的升级及三 runtime 子节点创建验收独立记录，不由本次 Hub 激活外推。

### #1053 / #1045 `.127` 配置（待激活，不是生产已升级）

此 profile 选择新的 sibling `runtime-v110-preview127`，保留已运行
`.126` 的 `runtime-v109-preview126` 与旧入口回滚。正式软件来自 main
`31b0dbdae3192f471c8812574c118795658120f0`，发布运行 `38193173842`
构建、四门及 npm/匿名核实均 SUCCESS。完整公共 tarball 与原 main 制品
逐字节相同：1232566 字节、SHA256
`ef9ed47cff0a1d6b65ef100dbf684f4e2c430e802ee75809bdb4db3c62fc6e54`。
本目录 `provider906/package*.json` 记录精确 npm URL / SHA512 integrity；
传递依赖与 `.126` 完全相同，不重新解析浮动依赖。

`.127` 提供 Daemon/节点环境密钥短期授权请求以及明确配置 HTTP 的
Provider 兼容；配套 CLI `.170` / runtime `.136`，客户端 `.249` 不会
自动升级远程服务或重启节点。从 `.126` 软件 main 到本次 `.127` main
的 `server/src/db.ts`、数据库 adapter 与 schema/migration 没有变化；
新的密钥请求是内存 TTL 状态，Hub 重启会令未确认请求丢失，不能盲重放。
本段及 profile CI 不是实际生产激活、真实密钥消费或数据恢复验收。

安装、原一致性备份、入口字节校验和窄切换沿上面的原操作流程；profile
必须先通过现有 GitHub Actions Docker 启动目录/显式回滚检查并正常合入
main。复制精确 package/lock 到新 sibling 后 `npm ci --ignore-scripts
--no-audit --no-fund`；旧目录、当前 DB 和 owner-only 配置不被覆盖。
新的生产备份应做 integrity/行数核对，不把旧快照冒充当前数据。
软件发行已有独立 Docker 真实启动/认证核心证据；生产数据与 `hub.env`
绝不上传 CI，用户要求测试由 Actions 执行时不另起本地测试容器。
若发现真实 schema/adapter 差异则停在 inactive，另行安排隔离迁移验证。

正常激活仍只重启既有 PM2 `commhub-hub`，不加 `--update-env`；原 Bun、
9200、反代/隧道、DB 路径及主机管理员保管的 `hub.env` 密钥来源不变。
先确认原 vault key 可加载且不换值，再按监听 PID 的真实入口、health
`.127`、错误日志和自然节点心跳/回执核验，不能只看 PM2 online。
失败恢复备份的 `.126` 入口并仅重启 Hub，不回退用户会话或删除 DB。
Git 负责软件、配置结构与过程；生产 DB、vault 原密钥、账号仍需独立
加密备份或重新认证。原保险库记录名 NOT COVERED 的缺口保留，未做新
空机演练，不能声称 clone 就能恢复数据或本次已完成全链恢复。

### #1075 `.128` 配置（2026-10-12 已激活）

`.127` 的实际激活记录在 `docs/tests/report-test1053-hub127-profile.txt`；
16:54+08 实读生产 `/health` 仍为 `.127`、secured、330 会话。
本次 profile 选择新 sibling `runtime-v111-preview128`，保留已运行的
`runtime-v110-preview127` 和原入口作回滚。软件来自完整 main
`e83cfc7d3b949a8751c43ee2f1c0614a2315dcf4`，正式发布运行
`38225130040` 的构建、四门、npm 发布与 registry 回读均 SUCCESS。
匿名完整 tarball 与该 main 制品相同：1233005 字节，SHA256
`b75ebaa668249148dfa26c4fc8c93d87bc8bfb34ee2fd163fe497b1dd8a096c1`。
`provider906/package*.json` 锁定真实公开 URL 和 SHA512 integrity，
传递依赖不变。不要从分支安装启动器或用浮动依赖重建此版本。

`.128` 增加无 Daemon 节点的环境密钥授权请求；节点以自身身份 pull/ack，
需节点 runtime `2.5.0-preview.137` 上报明确能力，客户端 `.251` 提供入口。
现有 Daemon 请求通道、旧身份令牌、账号和会话保持不变。从已部署 `.127`
的软件 source 到 `.128`，DB/schema/migration 文件没有变化。新请求是
Hub 内存 TTL 状态；重启会丢失未确认请求，不盲重放。节点私有密钥文件不在
Hub 数据库中；仅升级 Hub 不等于旧节点已获得新能力或真实模型权益已验证。

常驻入口继续由现有 PM2 `commhub-hub` 使用本目录 Git 权威 launcher；
启动、固化安装、当前一致性 `VACUUM INTO` 备份与安装字节检查按上文执行。
本 profile 的 Actions Docker 检查验证目录、显式回滚和 feature flag，
是假执行器，不冒实际数据迁移测试；另复用本版本的正式安装门和 #1075
注册工具→节点私有持久存储→实际 runtime 子进程使用的 Actions Docker 核心。
先通过检查并正常合入 main，再复制 package/lock 安装新 sibling，部署 Git
launcher（0700、逐一 cmp），只重启 Hub，不带 `--update-env` 或重启业务节点。
用监听进程、`.128` 健康读数、自然心跳/任务事件和错误日志核真实生效。

反代、隧道、9200 端口、PM2 定义和数据库路径不变。密钥从原 owner-only
`hub.env` 安全加载；不读取/传播值、不新生成 vault 主密钥。回滚恢复保留的
`.127` 入口，只重启 Hub，保留 live DB、私有安装和节点会话，不回退用户数据。
Hub DB、vault 原密钥及节点私有密钥须由管理员的独立加密备份恢复；Git clone
不含这些数据或账号。主密钥保险库记录名仍 NOT COVERED，不宣称空机恢复
演练完成。软件公开、本 profile 入库与生产激活三个门分别记录。

17:02:34（东八区）已按本流程激活。部署配置来自正常 main 合入
`1224c5e194cd7c9acf91c6a592655d034462b5bb`（PR2649，10 required 和
Hub deployment profile Docker SUCCESS），软件 source 仍为上面的
`e83cfc7d`。私有 sibling 安装100包、未运行安装脚本；旧 profile/base
及一致性 `VACUUM INTO` 备份保存在 owner-only
`~/.commhub/backups/node-secrets1075-p128.uXNwN6/`。备份756965376字节、
0600，integrity ok、330sessions/79568tasks；不是离机灾备恢复演练。
Git profile 与部署副本 cmp 相同，base 未变。仅重启 `commhub-hub`，
无 `--update-env`、Daemon/业务节点或账号变更。实际 Bun PID4014410
（旧3775153），入口为 v111/128；健康 `.128`、secured、330会话，
SSE自然恢复126且抽查八节点都有切换后新心跳。初始新增日志区段中
vault主密钥缺失/panic/segfault匹配0，PM2人为85→86；未执行专门
SSE协议/模型/生产密钥测试，独立 `task.ack` 未计PASS。负责人原身份
认证HOLD独立保留，心跳不是其登录验收。目标无绑定节点仍需升级
runtime137，客户端251构建独立记录，不由Hub激活外推。

## 混版风险(必读)

`docs/release/versioning-and-compatibility.md` 的 **C2 契约**:
Hub 协议(注册 / SSE 事件 key / task envelope / `protocolVersion`)是
agent-node ↔ commhub-server 的耦合面,**改协议要 bump `protocolVersion` + hub 加向后兼容**。

所以升 Hub 时节点通常还是旧版 —— **这是预期状态,不是事故**,但必须验:
升级后节点侧 `task.ack` 事件要继续产生,且不出现「任务卡在 running/delivered 超过 5 分钟」。
