# Hub 发版与部署：一次跑通，以及我今天踩的三个坑

> 起因：2026-10-28 发 `.187` / `.188` 两次。`.187` 部署时把生产 Hub 弄停了约 90 秒；
> `.188` 部署「成功」但探针报 FAIL。两次都不是产品问题，是**执行命令的形状**错了。
> 这份 runbook 只写「怎么做对」和「怎么一眼看出做错了」。

## 0. 全流程（commhub-server）

```bash
# 1) 版本号 + 发布说明 + 仓内探针
#    发布说明必须有 ## Install 与 ## Upgrade 两段（gate 3 会查，来自 v0.10.2 新用户装不上的事故）
#    scripts/verify-hub-release.sh 加一行 check_feature（盯行为，不盯文件名）

# 2) 推 main（发版提交直接进 main，与既有 chore(release) 提交一致）
git push origin main

# 3) 触发发布门（从 main 出产物）
gh workflow run release.yml \
  -f package=commhub-server -f version=<VER> -f commit=<FULL_SHA> -f publish=true --ref main

# 4) 等四道门 + verdict 全绿 → publish job 才会跑（任一门红则 publish skipped，不会发半成品）

# 5) 等 registry 可见（**看 registry，不看退出码**；provenance 延迟可达 ~40 分钟）
curl -s "https://registry.npmjs.org/@sleep2agi%2fcommhub-server/<VER>" | head -c 80

# 6) 部署（见第 2 节的三条硬性要求）
```

## 1. 部署三步的真实形状

```bash
REAL_HOME=/home/vansin
VER=0.9.0-preview.188
NEW_DIR="$REAL_HOME/.commhub/runtime-v188-preview188"

# a. 版本化运行时目录（旧目录保留 = 回滚点）
mkdir -p "$NEW_DIR" && cd "$NEW_DIR"
[ -f package.json ] || echo '{"name":"commhub-runtime","private":true,"version":"1.0.0"}' > package.json
HOME="$REAL_HOME" npm install --no-audit --no-fund "@sleep2agi/commhub-server@$VER"
node -p "require('$NEW_DIR/node_modules/@sleep2agi/commhub-server/package.json').version"   # 必须等于 $VER

# b. 切启动器（只改默认值那一行；备份 + 写好回滚注释）
#    ~/.local/bin/hub-daemon.sh:  export HUB_RUNTIME_DIR="${HUB_RUNTIME_DIR:-<NEW_DIR>}"

# c. 重启
PM2=/home/vansin/.nvm/versions/node/v20.20.0/bin/pm2
PM2_HOME="$REAL_HOME/.pm2" HOME="$REAL_HOME" "$PM2" restart commhub-hub
```

## 2. 三个坑（都是我在 agent 节点会话里执行时踩的）

### 坑 1：`$HOME` 不是 `/home/vansin`

在 agent 节点会话里，`$HOME` 是**节点私有目录**（如 `~comm-ou-v2/.anet/nodes/通信欧`）。
启动器 `hub-daemon.sh` 用 `exec "$HOME/.local/bin/hub-daemon-base.sh"` 拼路径 —— HOME 一错就找不到。

**所以**：脚本里一律显式写 `REAL_HOME=/home/vansin`，不要依赖 `$HOME`。

### 坑 2：不指定 `PM2_HOME` 会起一个**空的** pm2 守护

```
[PM2] Spawning PM2 daemon with pm2_home=.../通信欧/.pm2
[PM2][ERROR] Process or Namespace commhub-hub not found
```

它不会报「你没指定 PM2_HOME」，只会说找不到进程 —— 极易误判成「进程真的没了」。

### 坑 3：`pm2 restart --update-env` 会把当前会话的环境**灌进 Hub**

那次把节点私有 HOME 带进去了，于是 Hub 每次启动都：

```
bash: /…/通信欧/.local/bin/hub-daemon-base.sh: No such file or directory     ×21
pm2 status = waiting restart · unstable restarts 11
```

**不要加 `--update-env`。** 需要改的配置写在 `~/.commhub/hub.env`（启动器会 `set -a; source` 它），
那才是持久、可审计的位置；`pm2` 的 env 只是启动快照。

> 抢救（本人实测 90 秒恢复）：
> `PM2_HOME=/home/vansin/.pm2 HOME=/home/vansin pm2 restart commhub-hub --update-env`
> —— 这一次性用 `--update-env` 是为了**覆盖**那个错 HOME。

## 3. 探针的传参（一个纯手误）

`scripts/verify-hub-release.sh` 的第一个参数是**版本号**，不是 URL：

```bash
bash scripts/verify-hub-release.sh 0.9.0-preview.188      # ✅ RESULT: PASS（62 项）
bash scripts/verify-hub-release.sh http://127.0.0.1:9200  # ❌ FAIL: dist-tags.preview is '…', not 'http://…'
```

第二条的报错看起来像「dist-tag 不对」，实际是「我把 URL 当版本号传了」。
**部署成功 ≠ 验证通过**；看到 FAIL 先去核对参数，再怀疑产物。

## 4. 部署后必须同时满足三条（缺一条都会误判）

```bash
# 1) pm2 真的稳定    —— 只看「版本变了」会被旧进程还活着骗过
PM2_HOME=/home/vansin/.pm2 pm2 describe commhub-hub | grep -E "status|unstable restarts"
#    status=online 且 unstable restarts=0

# 2) 版本是目标版本
curl -s http://127.0.0.1:9200/health | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])"

# 3) 仓内探针通过
bash scripts/verify-hub-release.sh <VER>
```

`unstable restarts=1` 也可能是**你自己那次 restart**（`exited with code [0] via signal [SIGINT]`），
先看 pm2.log 再判断是不是崩溃。

## 5. 回滚

```bash
# 启动器那一行指回旧 runtime 目录
sed -i 's|runtime-v188-preview188|runtime-v187-preview187|' ~/.local/bin/hub-daemon.sh
PM2_HOME=/home/vansin/.pm2 HOME=/home/vansin pm2 restart commhub-hub
curl -s http://127.0.0.1:9200/health | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])"
```

旧 runtime 目录**不要急着删**：`docs/runbooks/hub-host-disk.md` 已写明「保留上一版可回滚」。

## 6. 发版不要被无关改动绑住

2026-10-28：`.188` 的发布门等了 1 小时没动，因为同仓另一条 145-job 的 QA run 把并发配额占满了。
**处理**：取消那条无关 run（代价可预期：重跑 ~40 分钟），发布门 3 分钟跑完。

判据：**能独立验证的东西，就独立发布**。把两个无依赖的改动绑在一起，
出问题时你会先怀疑最近落地的那个，而它可能完全无关（当天就发生过一次误判）。
