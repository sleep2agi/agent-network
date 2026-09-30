# 迁移 Hub

「迁移 Hub 后，各个节点是不是只要换一个 Hub 的地址就行了？」

**不是。** 对外地址不变时，节点和客户端都不用改。必须换地址时，改的也只是地址，令牌不用重签。只改地址、不把库和密钥一起搬走，等于连上一台空 Hub。

本页只讲现在的 SQLite Hub。`DATABASE_URL` 以 `postgres://` 或 `postgresql://` 开头时，Hub 不使用下面这份库，这些步骤不适用。**PostgreSQL 支持尚在开发中，目前不可用**：这样配置的 Hub 启动时会拒绝运行（见 [RFC-039](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-039-hub-postgresql-backend.md)）。

## 要搬什么

先停掉 Hub 进程再备份。进程还在时，定时任务仍会写库。

| 要搬 | 默认位置 | 说明 |
|---|---|---|
| 数据库 | `~/.commhub/commhub.db` | 环境变量 `COMMHUB_DB` 若已设置，以它为准 |
| 上传文件 | `~/.anet/server/uploads` | 环境变量 `COMMHUB_UPLOADS_DIR` 若已设置，以它为准。整个目录一起搬，包括里面的 `.index` |
| 保险库主密钥 | 环境变量 `ANET_HUB_SECRET_VAULT_KEY` | 64 位十六进制。启动脚本若从 `~/.commhub/hub.env` 读取（也可用 `HUB_ENV_FILE` 换路径），把这个文件一起搬走，权限保持 `0600` |
| 固化运行时和启动脚本 | 仅当你本来就这样启动 | 见下面 |

用 `anet hub start` 启动的 Hub，没有单独的运行时目录要搬。新机器装好 Bun 和 `anet`，放上库、上传目录和同一把密钥，再启动**一个**进程。常驻方式见 [让 Hub 常驻](/deploy/keep-alive)。

若现在跑的是 [`deploy/hub/hub-daemon.sh`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/hub-daemon.sh) 那份启动脚本，还要搬两样：脚本本身，以及脚本里 `RUNTIME_DIR=` 指向的目录。以正在跑的那份脚本为准，不要假设仓库里的示例路径就是你的。`hub.env` 里的 `BUN_BIN` 如果是旧机器的绝对路径，改成新机器上能执行的 `bun`，否则脚本会拒绝启动。不要搬 `/tmp` 里的 `bunx-*` 缓存，那不是安装目录。

密钥只从 `hub.env` 或进程环境进入 Hub。`anet hub start` **不会**自己去读 `hub.env`。重新生成一把新密钥解不开库里已有的 `network_secrets` / `providers` 密文。

日常备份仍用 [生产部署](/deploy/production) 里的 `sqlite3 .backup`。搬机器用下面这条，打出一份可以单独拷走的文件。不要 `cp` 正在使用的库，也不要把 `-wal` / `-shm` 当成备份。

```bash
umask 077
mkdir -p "$HOME/.commhub/backups"
src="${COMMHUB_DB:-$HOME/.commhub/commhub.db}"
dst="$HOME/.commhub/backups/commhub-migrate.db"
bun -e "new (require('bun:sqlite').Database)(process.argv[1],{readonly:true}).exec(\"VACUUM INTO '\" + process.argv[2] + \"'\")" "$src" "$dst"
bun -e 'const {Database}=require("bun:sqlite"); const db=new Database(process.argv[1],{readonly:true}); const ic=db.query("PRAGMA integrity_check").get(); if(ic.integrity_check!=="ok") throw new Error(JSON.stringify(ic)); for (const t of ["sessions","tasks","nodes","api_tokens"]) console.log(t, db.query("SELECT COUNT(*) AS n FROM "+t).get().n);' "$dst"
```

`integrity_check` 必须是 `ok`。记下这四行数字，和新机器启动后的数字对照。备份里有账号和消息，按敏感数据处理，不要把 `hub.env` 的值贴到别处。

### 不用搬

- 各台机器上的 `.anet/nodes/<节点名>/config.json`。节点令牌的明文在这里，库里只有哈希。
- 节点自己磁盘上的计划（crontab 等）和规则文件。它们不在 Hub 的库里。
- `-wal` / `-shm`、日志、`/tmp/bunx-*`。
- Dashboard 的安装目录。它不保存 Hub 的库，见下面「各端要改什么」。
- 桌面应用自带的 Local workspace。那是这台电脑上的另一个 Hub。
- `~/.anet/server/admin-utok.json`。这是本机 `anet hub start` 存的管理员用户令牌，不是库。新机器上没有它时，`anet hub start` 会再试一次注册；用户名已经在搬来的库里（返回 `username already taken`）就停在「已经存在」，不会改密码。用原来的用户名和密码 `anet login`。

## 令牌还有效吗

有效，只要这份库搬过去了。校验不看机器名，也不看主机名。

三类令牌都在 `api_tokens` 表里，库存的是令牌明文的 SHA-256（`hashToken`），不是明文。`resolveToken` 只用 `token_hash` 查这张表，再看是否过期、是否撤销。SQL 里没有主机名或机器标识。

| 令牌 | 前缀 | 存在哪 |
|---|---|---|
| 用户令牌（登录会话） | `utok_` | `scope = 'user'` 且 `network_id` 为空 |
| 节点令牌 | `ntok_` | `scope = 'network'`。可以绑一个 `bound_node_id`，绑的是库里的节点行，不是某台机器 |
| API 令牌 | `atok_` | `createToken` 写入的 `scope = 'full'` |

密码也在同一份库里，格式是 `scrypt$<N>$<salt>$<hash>`，盐是随机的，不掺机器名。所以原来的用户名和密码还能登录。

用户令牌另外有闲置过期：默认 30 天没使用就失效（`COMMHUB_SESSION_IDLE_DAYS`，`0` 表示关闭）。这和搬不搬机器无关。节点令牌和 API 令牌不走这条闲置过期。

保险库主密钥不参与令牌校验。没有它，上面的令牌仍能通过校验；已加密的网络秘密和供应商配置读不出来。

## 各端要改什么

**对外地址不变（推荐）：什么都不用改。** 域名或反向代理改指向即可。节点、daemon、桌面 / 手机应用、Dashboard 继续用原来的地址。

必须换成新地址时，才逐台改下面这些。令牌字段不要动，也不要 `anet daemon init --force`（那会重新签发节点令牌）。

| 端 | 改哪里 | 只要改地址？ |
|---|---|---|
| 节点 | `.anet/nodes/<节点名>/config.json` 的 `hub`。这一键没有时，用 `~/.anet/config.json` 的 `hub` | 是。改完重启该节点 |
| daemon | 同一份 `config.json` 的 `hub`。daemon 就是 `role` 为 `host_supervisor` 的节点，见 [anet daemon](/deploy/daemon) | 是。改完重启，不要 `--force` |
| 命令行 | 环境变量 `COMMHUB_URL`，或 `anet login --hub <新地址>` | 是。见下面的优先级 |
| 桌面 / 手机应用 | 设置 →「切换账号」→「添加账号」，「服务器地址」填新地址，用原用户名和密码登录，再切到这一行 | 是。旧的那一行仍指向旧地址 |
| Dashboard | 进程环境 `COMMHUB_URL`（未设置时是 `http://127.0.0.1:9200`） | 是。改完重启 Dashboard 进程 |

节点实际连接的地址，优先级是：命令行 `--hub`，然后是环境变量 `COMMHUB_URL`，然后是该节点 `config.json` 的 `hub`，然后是 `~/.anet/config.json` 的 `hub`，最后才是 `http://127.0.0.1:9200`。进程管理器若设了 `COMMHUB_URL`，只改 `config.json` 不会生效。

应用里没有「只改已保存地址」的一栏。添加账号时，「服务器地址」这一标签在当前界面上就是这五个字。说明见 [桌面与手机客户端](/guide/desktop-app)。Local workspace 不用加进去。

Dashboard 的用户登录用的是库里的用户令牌。`COMMHUB_URL` 仍指向这个 Hub（或指向它的反向代理）时，不用重新发令牌。见 [Dashboard](/guide/dashboard)。

## 切换和回滚

1. **停写。** 停掉守护 Hub 的进程管理器，确认没有第二个 Hub 在听。只摘反向代理、留下进程，定时任务还会写旧库。
2. **最后一次备份。** 用上面的 `VACUUM INTO`。`integrity_check` 为 `ok`，记下 `sessions`、`tasks`、`nodes`、`api_tokens` 四行数字。
3. **新机器先私下启动。** 放上这份库、上传目录和同一把 `ANET_HUB_SECRET_VAULT_KEY`。先不要把公网指过来。匿名 `GET /health` 返回 `ok: true`，其中 `sessions_count` 是 `sessions` 表的行数，要和备份一致。`version` 是你打算跑的那个服务端。此时 `sse_connections` 可以是 0，节点还没切过来。
4. **切流量。** 推荐做法：域名或反向代理改指向新机器，对外地址不变。必须换地址时，再按上一节逐台改节点、daemon、应用和 Dashboard。
5. **观察。** 已有的 SSE 会断一次，然后自己重连。节点从约 1 秒开始退避，封顶 30 秒，连续失败超过 1 小时才放弃，连上后会重新注册。桌面和手机应用的事件流从 2 秒加倍到 30 秒后继续重试。Dashboard 默认隔 3 秒再连。`sessions_count` 应保持不变。

**回滚就是把流量切回旧机器。** 先停掉新机器上的 Hub，再启动旧机器上停写时的那份库，然后把反向代理指回去。切到新机器之后新写入的任务和消息，旧库里没有。

地址也改过时，回滚还要把节点、daemon、应用和 Dashboard 的地址改回去。

## 不要两台一起写

- 新旧两台同时对外接收写入，会变成两份库，之后对不齐。SQLite 也不能由两台机器同时写同一个文件。
- Hub 计划的调度器在每个 Hub 进程启动时都会跑。两份库各跑一个进程，就会各派一次。同一份库上的两个进程能靠 `scheduled_task_runs` 的唯一键（`schedule_id` + `scheduled_for`）抢同一次，但这不是搬迁的用法。搬迁期间只留一个 Hub 进程。节点自己机器上的 crontab 等计划不在这个进程里；地址不变就不用动，地址变了就要改节点的 `hub`，否则它们还在访问旧地址。见 [定时任务](/guide/schedules)。
- `hub-daemon.sh` 发现自己的端口已有进程在听时会拒绝启动，就是为了避免两个 Hub 抢同一个库。不要绕过这道检查。`anet hub start` 没有这道检查，所以更不要手工起第二个进程。
