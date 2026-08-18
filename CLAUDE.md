# Agent Network (CommHub)

## 通信方式

你已接入 CommHub 通信网络。用以下 MCP 工具和其他 Agent/指挥室通信：

### 给别人发消息
```
commhub_send_task(alias="指挥室", task="你要说的内容", priority="normal")
```

### 发消息（无任务生命周期）
```
commhub_send_message(alias="指挥室", message="纯消息")
```

### 回复任务
```
commhub_reply(task_id="从消息 meta 里拿", text="回复内容", status="completed")
```

### 上报状态
```
commhub_report_status(status="working", task="正在做什么")
```

### 查看谁在线
```
commhub_get_all_status()
```

## 收到消息

来自 CommHub 的消息会以 `<channel source="commhub" sender="..." task_id="...">` 格式出现在对话中。收到后：
1. 如果发送者是人类（指挥室/Vincent），用 commhub_send_task 回复确认收到
2. 如果发送者是其他 agent（通信牛/SDK马/N站牛/测试牛等），不要回复确认，直接执行
3. 执行任务
4. 用 commhub_send_task 回复结果

## 规则

- 收到任务必须回应：确认→执行→汇报
- 回复指挥室/dashboard 要「对方立即收到」：commhub_reply **必须 status=completed（终态）** 才推送（→ send_reply → new_reply SSE → dashboard 聊天窗口实时显示），或用 commhub_send_task；**status=in_progress 等非终态走 report_status，不推、dashboard 收不到**（返回 ok 也白搭）。详见 [docs/agent-reply-to-dashboard.md](https://github.com/sleep2agi/agent-network/blob/main/docs/sop/agent-reply-to-dashboard.md)
- 不要猜 alias，用 get_all_status 查
- **send_ack / send_message / 非终态 reply 都不推送**（对方看不到，只写库）；要对方立刻看到一律 send_task 或终态 commhub_reply

## 测试规则

- **分层测试，从简单到复杂**：环境→认证→单点通信→完整流程→多用户→安全
- **前一层不过就不跑后面的**：被依赖的原子能力必须先验证可靠
- **所有测试在 Docker 里跑**：不碰本地环境，不改生产
- **不自己跑测试**：通信龙分配任务，测试1-3号执行，通信牛 review
- **不频繁发 preview**：本地源码开发，大版本完成时统一发 npm
- **测试结果保存**：docs/tests/report-testN.txt
- **每个测试套件独立 Dockerfile**：可并行构建和运行

## 复核纪律（四条，全部由 2026-08-18 当天的真实翻车催生）

下面四条**不是提醒，是我今天各踩了两到三次的地方**。它们的共同点：**命令全部成功、
输出看起来完全合理，只是对应的不是你以为的那件事** —— 没有任何东西会报错提示你。

**① 扫仓之前先证明你扫的是哪个 ref。**

```bash
bash scripts/assert-scan-ref.sh || exit 1     # 放在任何审计脚本/审计任务的第一行
```

当天两次：一个检出停在特性分支、落后 `origin/main` **885** 个提交；另一个只落后
**4** 个 —— 后者更小，也更难察觉，它让我报出一条「公开仓里的活泄漏」，而那条早
被清掉了。**一切判据都要带 `origin/main`，别按工作检出。**

**② 退出码不要穿过管道。**

```bash
cmd | tail; echo $?              # ✗ 这里的 $? 是 tail 的
cmd >/dev/null 2>&1; rc=$?       # ✓
cmd || exit 1                    # ✓
```

当天三次。第三次尤其值得记：我正在验证的，**就是上面那个「靠记忆不够、要做成工具」
的工具** —— 三个用例全打印 `rc=0`，真实退出码是 `1/1/0`。
**一个会说谎的退出码，会先骗过写检查的人。**

🔴 **同一天又撞到它的另外两副面孔，都在 `set -euo pipefail` 的脚本里：**

**(a) `… | head -N` 会被 SIGPIPE 打死。** `head` 读够就退出、关掉管道，上游
`sort`/`find` 拿到 SIGPIPE → **退出码 141**，pipefail 传出来，`set -e` 打死脚本。

```bash
VICTIM=$(find "$ROOT/docs-site" -name '*.md' | sort | head -1)   # ✗ 141
_list=$(find "$ROOT/docs-site" -name '*.md' | sort); VICTIM=${_list%%$'\n'*}   # ✓
grep -n -m1 PATTERN file                                          # ✓ 代替 grep|head -1
```

它**平时是绿的**（输出小的时候 `sort` 写完就退出了），红的时候**和真失败长得一样**：
同一个 job 名、同样没有断言输出、同样一个非零退出码。见 #990。

**(b) `if <预期会失败的命令> | grep -q X; then` 会把「命中」判成「没命中」。**
pipefail 让整条管道继承那个非零退出码，于是 `grep` 明明找到了，`if` 仍然走 else。

```bash
if bash "$GATE" bad.log 0 2>&1 | grep -Fq 'never ran'; then   # ✗ 恒 false
out=$(bash "$GATE" bad.log 0 2>&1 || true)                     # ✓ 先收进变量
if printf '%s' "$out" | grep -Fq 'never ran'; then
```

**这一条是我在给「判据要说得清红的是哪一种」写测试时,自己写出来的** ——
跑出 `PASS=25 FAIL=1`，而那条 FAIL 是假的。

🔴 **为什么没有把它做成一道门（量过才决定的）：** 全仓 258 个 `.sh` 里 159 个设了
pipefail，`if … | grep -q` 形态 **22 条**；逐条看完，**没有一条是缺陷** —— 8 条生产者是
`echo/printf`（恒 0），其余 14 条里 `pgrep|grep -q .`、`find … | grep -q .` 这类
「生产者失败」和「grep 没命中」含义相同，行为恰好一致。**唯一真正踩坑的那一条是我
当晚新写的。** 一道 22 条全是误报的门，会在第一周就被人关掉。
**所以这条留在这里靠读，而不是靠门。**

**③ 跑那道门本身，别自造它的判据。**

当天两次把数字数错：用自造的后缀白名单数测试文件（漏了 `.mts`，11 个数成 5 个）；
用裸 `grep` 查混淆产物里的路径（`--string-array-encoding base64`，裸 grep 必然 0）。
**能调那个脚本就调它；非要自己数，就先拿一个已知阳性喂进去，确认它会红。**

补一条当天的方向性观察:**四次自造判据,四次都比真判据更松** —— 自写链接扫描器
报 671 条断链(真实 0)、jq 把进行中的 `""` 当 failing、正则抓 `L1_TESTS` 抓出 4 个
中文注释片段(真实 22)、复现 slug 门时漏了 `SELF_ALLOWLIST`(真实 0 条违规)。
**偏差方向一致意味着:自造判据"看起来发现了问题"这个结果,天生比"看起来没问题"更可疑。**

**④ 合并之前，把「可以合」判成一次、判对一次。**

```bash
python3 scripts/assert-pr-mergeable.py <pr> || exit 1     # 不要让它的退出码穿过管道
```

当天两次:**轮询和 `gh pr merge` 写在同一个命令块里**,轮询最后一行已经打印
`readiness=FAILURE`,合并照样执行 —— dashboard 的 main 因此被我弄红。以及**手写的
jq 判据把「进行中」算成了「失败」**:`gh` 对还在跑的检查返回的是**空串 `""` 不是
`null`**。这次它朝安全方向错,**但同一个形状换个比较方向就会朝「可以合」错。**

判据五条缺一不可:`base==main` / 非 draft / 无 pending / 无 failing(**显式坏值集合,
不用「不等于 SUCCESS」的排除法**) / **检查总数 > 0**(0 个检查和 0 个失败打印出来一样)。

🔴 `mergeable` 单独一格,而且 **`UNKNOWN` 不是「没问题」**,是「还没算完」。当天实测:
`UNKNOWN` 底下两种现实都有 —— 一个 PR 是 `UNKNOWN` 且真 merge 时 12 个文件硬冲突,
另外三个也是 `UNKNOWN` 却干净。
🔴 而且 `MERGEABLE` **从不回答「这些 PR 彼此之间冲不冲突」**:当天 8 个 PR 各自对 main
都是 `MERGEABLE`,其中一对彼此冲突(双向)。要知道那个只能真合一遍。

## 项目信息

- 仓库：https://github.com/sleep2agi/agent-network
- Dashboard：**分三种,别混**(这一层最容易判断错,见 `deploy/tunnel/README.md` 顶部的红字警告)
  1. **项目自营的生产实例**(权威):`公网 ─ Caddy :3000 / frpc :3100 → 127.0.0.1:3001`
     (Next.js,pm2 托管)。拓扑与运维见 `deploy/dashboard/README.md`、`deploy/tunnel/README.md`。
     **要判断「Dashboard 正不正常」,看这个。**
     ⚠️ 但**仓里查不到它的实际地址** —— `deploy/tunnel/caddy.example` 是 `${PUBLIC_DOMAIN}`、
     `frpc.example.toml` 是 `${FRP_SERVER_ADDR}`,都是占位符(仓库政策不写死真实域名)。
     **在部署机上按权威来源查,不要猜、也不要退回那个 Vercel 页:**
     ```bash
     # ⚠ 必须看 status,不能只看名字:停掉/崩掉的应用照样留在 pm2 jlist 里
     pm2 jlist | python3 -c "import json,sys;[print(a['name'],a['pm2_env']['status'],'restarts='+str(a['pm2_env'].get('restart_time',0))) for a in json.load(sys.stdin)]"
     # online 之外,还要看「本次已连续运行多久」—— 重启次数没有时间跨度判断不了任何事
     curl -s http://127.0.0.1:2019/config/apps/http/servers                                       # Caddy admin:实际路由(权威)
     curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001                              # 直连上游,绕开入口层
     ```
     不在部署机上时:**不要凭猜测下结论**,找该机器的负责人要地址。
  2. **自己起的**:`anet hub dashboard`。默认走 `npx @sleep2agi/agent-network-dashboard@<tag>`;
     但 `ANET_DASHBOARD_LOCAL=1` 时改为直接 spawn 全局二进制(`agent-network/bin/cli.ts` 的
     `globalOptIn` 分支)—— **诊断"装的是哪一份"之前先看这个变量**,否则会去查错的产物。
     见 `docs-site/docs/guide/dashboard.md`。绑定地址取 `--ip` → `--host` → `$HOSTNAME` → `127.0.0.1`
     (`agent-network/bin/cli.ts` 的 `dashHost`)。**容器里 `HOSTNAME` 通常有值,会绑到容器主机名而不是回环**
     —— 这是记录在案的发版门坑(`docs/tests/release-gate-playbook.md`「dashboard binds to hostname not 0.0.0.0」)。
     所以别假设任何默认地址,判断前先看 `dashHost` 实际取到什么。
  3. **没有面向外部用户的 SaaS 产品 URL。**
  ⚠️ `agent-network-dashboard.vercel.app` 不属于以上任何一种,别拿它判断线上状态。
  它在 `docs/rfcs/RFC-022` 里被当作现存部署引用,而该 RFC 与其原型自 2026-06-11 起无功能推进(见 #220)。
  实测只有一条:2026-08-13 取到它的 HTTP `Age` ≈ 61 天(**这是缓存年龄,不等于部署年龄**,
  要判断是否停更需查 Vercel 部署记录或产物里的 build id)。
- npm 包：@sleep2agi/agent-network / @sleep2agi/agent-node / @sleep2agi/commhub-server
