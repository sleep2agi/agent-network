# Dashboard 生产部署 —— 从空机重建

这份文档和同目录的 `dash-start.sh` 存在的理由只有一个:

> **任何一台服务器被夷平后,只凭这个 repo 就要能把现在在跑的东西重建出来。**

在此之前,生产 dashboard 的启动器只存在于机器上的 `~/.local/bin/dash-start.sh`,
下面这套拓扑只存在于口口相传里。机器没了,这些就都没了。

数据不在此列:Hub 的 SQLite 内容无法从 repo 复现,要么来自备份,要么重新注册。
本文档只保证**软件与运行方式**可复现。

---

## 一、拓扑(这层最容易猜错)

```
公网 ─┬─ Caddy :3000  ──TLS 终结──┐
      │                           ├──►  127.0.0.1:3001   (Next.js, pm2 托管)
      └─ frpc 隧道 :3100 ─────────┘
```

三件事必须知道:

1. **公网入口不止一个。** 除了 Caddy,还有一条 `frpc` 隧道把另一个域名的 `:3100`
   打到**同一个** `127.0.0.1:3001`。曾经因为不知道这条隧道,
   在"部署完成但用户仍看到旧界面"上判断错方向 —— 以为是另一台机器上的另一套部署。
   判据:比对两个入口返回的同一个静态文件的 `Last-Modified`,
   如果精确到秒相同,那就是同一份磁盘上的同一个文件,不可能是两台机器各自安装的。

2. **进程由 pm2 托管**,app 名 `anet-dashboard`,script 指向持久路径下的
   `dash-start.sh`。`COMMHUB_TOKEN` 等环境变量由 pm2 的 saved-env 注入 ——
   **`pm2 restart` 不要带 `--update-env`**,带了会丢。

3. **启动器必须放在持久路径。** 它曾经在 `/tmp/dash-start.sh`,
   任何 `/tmp` 清理都会让 dashboard 在下一次重启时彻底起不来。

## 二、`dash-start.sh` 里有两个版本位,它们不是一回事

这是这套部署最容易踩的坑,**改错了会得到一个"看起来成功"的假部署**:

| 变量 | 作用 | 改它会怎样 |
|---|---|---|
| `VERSION=` | **仅用于预检** —— `npm view "$PKG@$VERSION"` | 改了它,预检通过,但跑的还是旧的 |
| `RUNTIME_BIN=` | **真正 `exec` 的目标** | 只有改这个才真的换版本 |

两者是**故意解耦**的:runtime 指向一份固化安装目录
(`~/.commhub/dashboard-runtime-vNN/`),而不是 `npx` 的缓存目录。
原因见脚本注释 —— `npx` 从 `~/.npm/_npx/<hash>/` 执行,
**任何人一条 `npm cache clean --force` 就能删掉线上服务的运行目录**。

🔴 **只改 `VERSION=` 的后果**:`pm2` 重启成功、pid 变了、restart 计数 +1、
服务正常响应 —— 但 `exec` 的还是旧安装。只看 pm2 状态和 `curl /` 会报告"已上线",
而且是错的。

## 三、换版本(完整顺序,缺一步都可能出事)

```bash
# 1. 发布并等传播 —— 抢跑会让 pm2 拿到 ETARGET、:3001 空、公网 502
npm publish --tag preview
until [ "$(npm view "$PKG@$NEW" version)" = "$NEW" ]; do sleep 5; done

# 2. 建 sibling 固化安装(不要动正在跑的那个目录)
mkdir -p ~/.commhub/dashboard-runtime-v<NEW>
cd ~/.commhub/dashboard-runtime-v<NEW>
printf '{"name":"anet-dashboard-runtime","private":true,"version":"1.0.0","dependencies":{"%s":"%s"}}' "$PKG" "$NEW" > package.json
npm install

# 3. 🔴 旁路验证:在非生产端口先跑通,再动生产
PORT=3009 HOST=127.0.0.1 ./node_modules/.bin/agent-network-dashboard &
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3009/login   # 期望 200

# 4. 备份 + 同时改两处
cp dash-start.sh dash-start.sh.bak-<旧版本>-$(date +%Y%m%d-%H%M%S)
#    VERSION="<NEW>"   且   RUNTIME_BIN=".../dashboard-runtime-v<NEW>/..."

# 5. 重启(不带 --update-env)
pm2 restart anet-dashboard
```

## 四、验证:只有这几条算数

版本号是自报的,pm2 状态证明不了换没换。要看:

```bash
# ① 真正在跑的安装目录 —— 这条最权威
PID=$(ss -ltnp | grep 127.0.0.1:3001 | grep -oP 'pid=\K[0-9]+')
readlink /proc/$PID/cwd          # 必须含 dashboard-runtime-v<NEW>

# ② 本次改动真在服务出去的产物里(比版本号硬)
curl -s <入口>/<页面> | grep -oE '/_next/static/chunks/[^"]+\.js' \
  | while read c; do curl -s "<入口>$c" | grep -q '<本次新增的字符串>' && echo "$c"; done

# ③ 构建溯源
cat <安装目录>/.next/BUILD_COMMIT     # 应等于发版 commit

# ④ 监听进程是 pm2 的后代,不是孤儿(见下)
```

## 五、两类孤儿进程,症状完全不同

**A. 孤儿占着 LISTEN** —— pm2 新进程 `EADDRINUSE` 永远起不来,
真正服务的是跑旧版的孤儿。曾导致 pm2 重启 34494 次。
判据:追监听 pid 的祖先链,出现 pm2 的 pid 才正常,直接到 systemd 就是孤儿。

```bash
P=<listen_pid>; while [ -n "$P" ] && [ "$P" != 1 ]; do
  echo "$P $(ps -o comm= -p $P)"; P=$(ps -o ppid= -p $P | tr -d ' '); done
```

**B. 孤儿交出了 LISTEN 但攥着 ESTAB** —— 新连接走新版本,
但**已经打开的浏览器标签仍由旧进程服务,仍是旧界面**。
所以宣布部署完成时**必须带一句"请强刷 Ctrl/Shift+R"**,
否则对方看到旧 UI,会合理地认为部署失败了。

🔴 这类孤儿**有活连接时不要 kill** —— 杀掉就是打断正在看页面的人。
等它自然排空;确实要立刻生效时再按**精确 PID** 终止(绝不用 `pkill -f`)。

## 五点五、从空 PM2 恢复进程定义

README 里其它地方写的是 `pm2 restart anet-dashboard` —— 那**假定 app 已经存在**。
空机上它不存在,所以要先从仓里把定义建出来:

```bash
pm2 start deploy/dashboard/ecosystem.config.cjs --only anet-dashboard
pm2 save
```

🔴 该文件**只含非敏感定义**。`COMMHUB_TOKEN` 等由 PM2 的 saved-env 注入,
不在仓里 —— 所以恢复后仍需按上文补回环境变量,且
**`pm2 restart` 不要带 `--update-env`**(带了会丢 saved-env)。

(这一步是 #778 纸面演练在 dashboard 链上发现的缺口:hub 有 `ecosystem.config.cjs`,
dashboard 此前没有。)

## 六、回滚

把 `VERSION=` 和 `RUNTIME_BIN=` **两处**改回上一版即可 ——
旧的固化安装目录只要没被清理就还在。

🔴 **不要 `npm unpublish`。**

## 七、清理固化安装目录

历史版本目录会累积(每个约 380MB)。删之前必须确认没有进程持有它的 cwd:

```bash
for p in /proc/[0-9]*; do readlink $p/cwd 2>/dev/null | grep -q dashboard-runtime-vNN && echo "占用: $p"; done
```

保留:**当前在跑的** + **上一版(回滚用)**。其余可删。
曾实测发现一个 11 天前起的、监听在另一个端口上的旧实例仍持有某个目录 ——
所以这一步不能凭目录名判断,必须实际扫 cwd。

---

## 八、这份 runbook 哪些实测过、哪些没有

规则要求「未经演练,不宣称可恢复」。以下如实标注,**不要把未演练的部分当成已验证**。

### ✅ 已实测(2026-08-12,发布 `0.6.3-preview.55` 时真跑过)

第二、三、四节里**从已发布 npm 包到一个可用实例**这一段是端到端验证过的:

```
mkdir ~/.commhub/dashboard-runtime-v55 + package.json 钉版本 + npm install
  → node_modules/@sleep2agi/agent-network-dashboard/package.json = 0.6.3-preview.55
PORT=3009 HOST=127.0.0.1 ./node_modules/.bin/agent-network-dashboard
  → /login 200   /scheduled-tasks 200   footer 自报 preview.55
  → .next/BUILD_COMMIT == 发版 commit
换版后:readlink /proc/<listen_pid>/cwd 含 dashboard-runtime-v55
       服务出去的 chunk 里 grep 到本次新增的字符串
       监听 pid 追祖先链到 pm2 当前 pid(非孤儿)
```

第五节两类孤儿进程也是实测的 —— 当天两种都遇到了,包括那个只攥 `ESTAB`
继续给已打开标签页发旧 bundle 的,正是它造成了「部署完成但用户看到旧界面」。

### ❌ 尚未演练(**不要据此宣称可恢复**)

- **从一台空机器完整重建** —— 未做。Caddy 配置、frp 隧道配置、pm2 app 的创建与
  saved-env 注入,**这三样目前都不在 repo 里**,本 PR 只覆盖了启动器本身。
  也就是说:照现在的 repo,你能把 dashboard 进程跑起来,
  **但配不出那两个公网入口**。
- **数据恢复** —— 完全未覆盖。Hub 的 SQLite 内容不在 repo,依赖独立备份,
  且备份恢复流程本身也没演练过。
- **回滚** —— 第六节的步骤是按当前脚本结构推出来的,**没有真正执行过一次回滚**。

### 下一步(补齐的顺序)

1. 把 Caddy / frp / pm2 的配置模板收进 repo(**只放变量名与占位符,不放任何值**)
2. 在隔离环境(Docker 或一台空机)按本文档从零走一遍,把过程与结果记进 `docs/tests/`
3. 演练一次真实回滚
4. 单独演练数据恢复,并明确 RPO/RTO

**在第 2 步完成之前,本文档的地位是「已知正确的操作手册」,不是「已验证的灾难恢复方案」。**
