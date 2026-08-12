# 生产 Hub 换版本

对应 `AGENTS.md` §19。与 `deploy/dashboard/` 同一套「固化安装 + 指针切换」模式,
但 Hub 是**全网唯一**的,所以每一步的代价更高。

🔴 **这份文档标注为「已演练」** —— 2026-08-13 真跑过一次
(`0.9.0-preview.27 → 0.9.0-preview.29`),证据见 `docs/tests/report-hub-upgrade-preview29.txt`。
这是 `deploy/` 下目前唯一不是「未演练」的一份。

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
