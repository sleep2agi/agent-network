# 生产 Hub 换版本

> 面向用户的守护说明（PM2 入口、`min_uptime` 怎么定、自动恢复四项验证）在文档站
> [部署 / 让 Hub 常驻](https://anet.sh/deploy/daemon)。本目录是那一页所引用的 **Git 权威**。

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
BUN_VERSION=1.3.14
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

## 混版风险(必读)

`docs/release/versioning-and-compatibility.md` 的 **C2 契约**:
Hub 协议(注册 / SSE 事件 key / task envelope / `protocolVersion`)是
agent-node ↔ commhub-server 的耦合面,**改协议要 bump `protocolVersion` + hub 加向后兼容**。

所以升 Hub 时节点通常还是旧版 —— **这是预期状态,不是事故**,但必须验:
升级后节点侧 `task.ack` 事件要继续产生,且不出现「任务卡在 running/delivered 超过 5 分钟」。
