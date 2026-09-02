# Agent Network (CommHub)

## 通信方式

你已接入 CommHub 通信网络。用以下 MCP 工具和其他 Agent/指挥室通信：

### 给别的 agent 发消息
```
commhub_send_task(alias="<用 get_all_status 查到的真实 alias>", task="内容", priority="normal")
```
🔴 名册里**没有**叫「指挥室」或「admin」的会话；「总指挥」是一个 claude-code 协调 agent，**不是 Vincent 本人**。

### 发消息（无任务生命周期）
```
commhub_send_message(alias="<真实 alias>", message="纯消息")
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

1. 🔴 **`sender="admin"` = Vincent 本人**（他从桌面端/Dashboard 聊天窗以 admin 用户身份发言，**没有对应的会话 alias**）。
   回复他的**唯一**可达路径：
   ```
   commhub_reply(task_id="<他这条消息的 task_id>", text="...", status="completed")
   ```
   status 必须是终态 `completed` 才会推送进他的聊天线程；`send_task(alias="总指挥")` 发到的是协调 agent，**Vincent 看不到**（2026-08-27 实测教训：连续多轮回错收件人）。
2. 发送者是其他 agent（通信牛/SDK马/N站牛/测试牛等）：不要回确认，直接执行，结果用 send_task 回给该 agent。
3. 执行任务 → 汇报。

## 规则

- 收到任务必须回应：确认→执行→汇报（对 admin/Vincent 的每一步回应都走终态 commhub_reply 回他的 task_id）
- 回复指挥室/dashboard 要「对方立即收到」：commhub_reply **必须 status=completed（终态）** 才推送（→ send_reply → new_reply SSE → dashboard 聊天窗口实时显示），或用 commhub_send_task；**status=in_progress 等非终态走 report_status，不推、dashboard 收不到**（返回 ok 也白搭）。详见 [docs/agent-reply-to-dashboard.md](https://github.com/sleep2agi/agent-network/blob/main/docs/sop/agent-reply-to-dashboard.md)
- 不要猜 alias，用 get_all_status 查
- **send_ack / send_message / 非终态 reply 都不推送**（对方看不到，只写库）；要对方立刻看到一律 send_task 或终态 commhub_reply

## 测试规则

- **分层测试，从简单到复杂**：环境→认证→单点通信→完整流程→多用户→安全
- **前一层不过就不跑后面的**：被依赖的原子能力必须先验证可靠
- **所有测试在 Docker 里跑**：不碰本地环境，不改生产
- **测试可以自己跑**（早期"测试1-3号"分工已撤销；新增套件必须注册进 CI，见 check-test-suite-registration）
- **发版一律走 GitHub Actions**（Vincent 2026-08-27 定：本机只开发不发包）：`release-gate (v0)` 发 preview，`promote to latest` 升 latest（要 owner ACK）
- **对外发布一律从 main 分支出**（Vincent 2026-08-27 定）：npm 包、exe/安装包等所有对外产物必须由 main 分支构建发布；其他分支只做测试验证、只出测试性产物，不得对外发布。（当日教训：latest 曾被一次本地手工 `npm publish` 未带 `--tag preview` 顶上去——工作流 + main-only 双约束堵住这类事故）
- **测试结果保存**：docs/tests/report-testN.txt
- **每个测试套件独立 Dockerfile**：可并行构建和运行

## 复核纪律（八条，前五条由 2026-08-18、第六条由 2026-08-27、第七第八条由 08-30 / 09-02 的真实翻车催生）

下面六条**不是提醒，是真实翻车催生的**：前五条来自 2026-08-18 那一天（我各踩了两到三次），
第六条来自 2026-08-27。它们的共同点：**命令全部成功、输出看起来完全合理，
只是对应的不是你以为的那件事** —— 没有任何东西会报错提示你。

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

**⑤ 一道门有两层：判据，和取集。绿的时候它们长得一模一样。**

当天同一个形状撞了三次，三次都是**判据完全正确**：

| | 判据 | 取集 | 结果 |
|---|---|---|---|
| #996 | `pkill`/`killall` 认得，`kill -9 $(pgrep -f …)` 不认 | 对 | 判据的洞 |
| #997 | 对 | `PUBLIC_DIR.glob("*.sh")` 不递归 | `public/community/evil.sh` 里的 `pkill -f` 隐身 |
| #999 | 对 | `server/src/glob("*.ts")` 不递归 | `server/src/shared/` 整个在安全棘轮外 |

后两条的输出是：

```
scanned 6 public script(s): agent-only.sh, hub-only.sh, …
0 findings across 6 script(s).                              rc=0
```

**和真绿逐字相同，连分母都没变** —— 因为分母是从**同一个有洞的 glob** 算出来的。
一个从「打算扫什么」算出来的分母永远自洽，也永远看不见自己外面。

所以：

```bash
# 写门的时候，两层分开自检
python3 <gate> --selftest      # 判据：给它一行，看它报不报
                               # 取集：造一棵目录树，看「该收的收进来了没有」
```

实测这两层测的**不是同一件事**：把 `rglob` 退回 `glob`，`collect-selftest 5/7` 红，
而 `selftest 18/18` **仍然全绿**。

🔴 **但「递归一律更安全」是错的判断。** 同一次审计过了 12 个守卫脚本，
`action-pins` / `workflow-structure` / `qa-trigger-coverage` 用非递归 glob 是**对的** ——
GitHub Actions 自己就不递归（`.github/workflows` 下 0 个子目录，顶层 20 == 递归 20）；
`check-published-build-paths` 的 `*.tgz` 来自 `npm pack`，产物是平的。
**取集方式要匹配被扫对象的真实语义。**

🔴 盲区几乎总在「怎么拿到要判的东西」，不在判据：未跟踪的新文件、`.gitignore`、
子目录、后缀白名单。**本地跑门之前先 `git add`** —— `git ls-files` 看不见未跟踪文件，
表现为绿。（这道门是文件系统 glob，`git add` 与否都一样，但那一点是**量出来的**，
不是假设的。）

**⑥ 一个查得到的事实，外面接一个没查的推论 —— 整句读起来像都验证过了。**

2026-08-27 一天里三个人各中一次，形状完全相同：

| 真前提（查过、往往是刚亲手量的） | 接上的推论（没查） | 实际 |
|---|---|---|
| 新套件 `run` 只要 **11s** | 「所以可以进 L1」 | L1 的 build 是**串行**的、job 预算 5 分钟且已用掉 141–148s；而该套件**冷构建 244s**，进去必爆 |
| #1273 的 `start_node` 用 `child_node_id` | 「所以趁它没合，是统一命名的最后窗口」 | 它卡在两处 CI，不会马上合 —— 窗口存在，但不紧 |
| `grep` 到 test638 用 `bun.sh/install` | 「所以那是规范写法，可以照抄」 | 它是棘轮门的**存量豁免**；照抄等于把债搬进一个新文件，而这类门只罚新增者 |

**为什么它比一个纯粹的错更难自曝**：前半句是真的，而且常常是刚刚亲手量出来的。
那份新鲜的确信会顺着「所以」淌到后半句上 —— 读的人（**包括写的人自己**）把已验证
那一半的信心，借给了没验证的那一半。上面三条，没有一条读起来像猜测。

**做法**：说出「因为 A 所以 B」时，把它拆成两个独立的问题分别回答 ——
**A 查过吗？B 查过吗？** 不要问「这句话对吗」：那个问法会被前半句的真实性带跑。

🔴 **为什么这条也是靠读、不做成门**：三个实例分别是一句群消息、一段 PR 正文、
一条派工指令 —— 没有共同的语法可扫。**它们唯一的共同点在推理里，不在文本里。**
（同 ② 和 ③ 一样，做不成门的那些，只能靠每次会话都读到。）

**⑦ 一个工具给你的数字/状态，回答的可能是**旁边那个**问题。**

2026-08-30 一天里我在这个形状上栽了**五次**，五次的命令全部成功、输出全部合理：

| 我读到的 | 它其实在回答 | 后果 |
|---|---|---|
| 名册 `updated_at` 减 `datetime.now()` → **8.3 小时** | 字段是 **UTC**，`now()` 是本地(+8) | 12 分钟的现象报成 8 小时事故 |
| `gh pr checks` 说某项 **fail** | 那条 link 指向的 run 是 **另一个 SHA 的排队项** | 把已修好的 PR 说成"仍红" |
| pin 门说 `` `send_ack` 现在在第 2072 行 `` | 那是**该词最早出现处**(一句注释)，不是符号处 | **照着修 → 门变绿、文档指向注释**(#1561) |
| `grep -l 'from "\./cli'` → 3 个测试 | 前缀命中了 `./client` | 差点用错判据推翻队友的正确结论 |
| `grep -c anet_bin_unclassified` → 1 | 那 1 处在**注释**里，是刻意留的说明 | 差点把一条防御报成"没改干净" |
| 跑一道门得到 `rc=2` | 我**把脚本文件名编错了**(真名 `check-no-memory-slugs.py`) | 一个**没跑起来**的检查和一个**失败**的检查，退出码都非 0 |
| `git grep -c … -- dashboard/` → **0 命中** | **这个仓里没有 `dashboard/`**(0 个被跟踪文件) | 对不存在的路径 grep，`0` 和「存在但没命中」逐字相同 |


**上表后三行是同一个子形状：`grep`/退出码描述的对象不是我以为的那个。** 补一条最省的前置：

```bash
git ls-tree -r <ref> --name-only -- <path> | wc -l    # 先证明分母不是 0
git grep -c <pattern> <ref> -- <path>                 # 再谈命中数
```
**一个 0 计数，必须先证明分母不是 0。** 我因为跳过这一步，在两个 issue 里引用了
一个对**不存在的路径**做出的 grep 结果 —— 那一半论据是空的（另一半 `agent-network/`
是实的，281 个被跟踪文件，所以结论本身没塌）。

🔴 **第七次不在表里，因为它不是"读错输出"，是"我提供的证据被原样用了"**：
我在讨论「别把家目录上报到 hub」时，为了让论据具体，**原样粘了本机真实路径**
`/home/<我>/.nvm/…/dist/bin/cli.js`。队友把它当测试夹具用了 —— 完全合理，
那是我给的"真实长相"。于是它从一条聊天消息变成了**公开仓里的一个新文件**，
被 `home-path-baseline` 拦下。**讨论"别泄露家目录"的那次对话，本身泄露了一次。**
⇒ **粘进消息里的证据会被人原样用进代码。** 举例时就用占位符(`/home/user/…`)，
   哪怕当时只是"给你看一眼真实长相"。

🔴 **而修这次泄露的动作，又当场制造了第八个实例 —— 这一个最值得记。**
把夹具里的 `/home/<我>/…` 换成 `/home/user/…` 之后，同一个文件里的泄露断言

```ts
expect(blob).not.toContain("vansin")      // ← 夹具里已经没有 "vansin" 了
```

**变成恒真。** 一条永远成立的泄露断言，和"确实没有泄露"**在测试输出里逐字相同**。

**「改夹具让门变绿」和「改夹具让断言失效」是同一个动作的两面** ——
门只管你有没有把真路径拿掉，**它不会告诉你拿掉之后还有没有测试在测东西**。
（这是 通信SDK马 修完之后自己顺手核到的；只跑门、看见 rc=0 就推的话，
那条断言会以**绿**的形式留在仓里。）

**做法**：改夹具之后，回头看**引用过那个夹具值的每一条断言** ——
把断言改成钉夹具里**仍然真实存在**的片段，并补一条**正控**证明它们不是恒真：
```ts
for (const frag of ["/", "chmod", "node_modules", ".nvm"]) expect(detail).toContain(frag);
```

**共同点**：工具没有出错，**它回答的问题和我问的问题差一格**。而这一格在输出里**不可见** ——
`8.3` 和 `0.2` 长得一样、`fail` 和 `fail(旧 SHA)` 长得一样、`第 2072 行` 和 `第 2074 行` 都是数字。

🔴 **最危险的一次是 pin 门那条**：它的输出**诱导出一个会让门变绿的错误修法**。
一个红能把你引向假绿，比一个直接的假绿更难防 —— 因为你此刻正处在"门红了、想赶紧修绿"的状态，
**最不适合做消歧的时刻**。（挡住它的是队友的怀疑，不是我的复核。）

**做法（每条都是几秒钟）**：
```bash
date -u                       # 拿时间戳算时长前，先与名册 max(updated_at) 对一眼
                              #   两者应只差几秒;差出整数小时 = 时区错了
gh api …/runs/<id> --jq .head_sha    # 判断一个红是不是当前的:它等于 PR 的 headRefOid 吗
grep -n '"send_ack"' file            # 门给了行号也要自己看一眼那一行**是什么**
grep -nE 'from "\./cli(\.|")'      # 模式要钉边界,别让 cli 命中 client
```

**再加一句判据**：当一个数字支持"事情比我以为的更严重"时，**它同样需要复核**。
上面第一条(8.3 小时)之所以两轮没被发现，正是因为它朝**"更严重"**方向错 ——
一个"发现了事故"的测量不会有人去质疑它。**朝哪个方向错，不改变它是否需要验。**


**⑧ 本地跑门，用 CI 那一行的命令和参数；填给闸的判据，用闸自己的命令量。**

2026-09-02 一天四次，形状相同：**同一道门/同一个串，我这边绿，CI 红**。

| 我跑的 | CI/闸跑的 | 结果 |
|---|---|---|
| `check-doc-symbol-pins.py`（无参） | `… . --doc-root docs-site` | 无参 rc=0；带参抓到 `logAudit` 行号 pin 漂了 |
| `qa.sh --list` 里看见新条目 | `qa.sh --l0` 真跑 | L0 写死 `cd server`，agent-node 路径被当过滤器匹配 0 个文件 |
| `check-hub-launcher-pin.py` 没跑 | CI 跑了 | `PINNED_SERVER_VERSION` 改了、启动器 `RUNTIME_DIR` 没跟 |
| `grep -F '[rules-file] doorbell received'` 两向都对 | 闸 4 `grep -rq -- '<串>'`（**无 -F**） | `[rules-file]` 成字符集 ⇒ 0 命中 ⇒ promote 拒 |

四次都不是判据错，是**我量的那条命令和门跑的那条不是同一条**。无参默认往往取「较小的集合」，
输出格式逐字相同，读不出区别。

```bash
grep -rn '<脚本名>' .github/workflows/*.yml | grep run     # 先抄 CI 那一行,原样跑
bash scripts/qa.sh --l0                                    # 登记完要真跑,看自己那条打 ✓,不是看 --list
# must_contain:避开 [ ] ( ) . * + ? ^ $ | \ { },并用闸原样命令(不加 -F)在目标版和上一版各跑一次
```

## 项目信息

- 仓库：https://github.com/sleep2agi/agent-network
- **通信团队维护的仓库与对外产物（2026-09-02 Vincent 问「写进 CLAUDE.md 了吗」—— 之前没写）**：

  | 仓库 | 对外产物 | 发布方式 | 近 7 天合并 PR（09-02 量） |
  |---|---|---|---|
  | `sleep2agi/agent-network`（本仓） | npm `@sleep2agi/agent-network`(anet CLI) / `@sleep2agi/agent-node` / `@sleep2agi/commhub-server`；文档站 anet.sh（`docs-site/`） | `release-gate (v0)` 发 preview → `promote-latest` 升 latest（owner ACK）；anet.sh **不是**合 main 自动部署，要按 `docs/sop/methodology.md` 从 `docs-site/` 跑 `vercel deploy --prebuilt --prod --scope <vercel-team>` | 100 |
  | `sleep2agi/agent-network-app` | 桌面端（Tauri，macOS `.dmg`/Windows `.exe`+`.msi`，自带更新） | `release-desktop-auto-update`（`commit` 必须 40 位 main sha；产物是 **draft** release，最后「发布 draft」在 GitHub 页面点） | 41 |
  | `sleep2agi/agent-network-dashboard` | npm `@sleep2agi/agent-network-dashboard`（`anet hub dashboard` 用）；生产实例见下面「Dashboard 分三种」 | 该仓自己的发布流程 | 3 |

  生产 hub（DEV 机 `127.0.0.1:9200`，pm2 `commhub-hub`）换版本照 `deploy/hub/README.md`「换版本」六步，
  **以机器上的 `~/.local/bin/hub-daemon.sh` 为准判断当前版本**（09-02 实测：仓里写 preview44，机器跑的是 preview38）。
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
