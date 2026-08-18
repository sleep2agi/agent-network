# 陈旧 issue 怎么复核

写这份的直接原因:仓里 79 个 open issue,**30 个超过 30 天没动,而这 30 个没有一个被任何 open PR 引用**。我手工核了其中七条(#175 / #166 / #114 / #177 / #332 / #195 / #207),各花十几分钟,而方法没留下来 —— 剩下 23 条又得从头想一遍。

这份文档不是流程规范,是那几次的做法加上踩到的坑。

## 为什么「陈旧」本身不是判据

一个 issue 三个月没人说话,可能是:

- 早就做完了,没人回来关;
- 做了一半,而正文读起来像一件事;
- 前提根本不成立,永远做不了;
- 真的还没排到。

**这四种在 issue 列表里长得一模一样。** 时间、label、评论数都区分不了它们 —— 区分它们的唯一办法是回到代码里取证。

所以「清理陈旧 issue」不能靠批量关。批量关会把上面第 2、3 种一起埋掉,而那两种恰恰最值得写清楚。

## 步骤

### 1. 先读正文要什么,而不是先去搜代码

标题经常和正文不是一回事。

- #114 标题是「支持一下每个 Agent 的 Token 使用量」,听起来是从零开始。正文只有两句,第二句是「要考虑 token 的价格」。
- #166 标题写着「MCP 工具缺失时提供一等 REST fallback」,正文实际列了**四件**独立的事(REST 端点、`parent_task_id` 链路、任务诊断、MCP 可用性本身)。

**只按标题去搜,会把「四件事里做了三件」判成「做完了」。**

### 2. 逐条对 `origin/main` 取证,不是对本地工作树

```bash
git fetch origin main
git grep -n '<符号>' origin/main -- 'server/src/*.ts'
git show origin/main:server/src/db.ts | grep -n 'ADD COLUMN <列名>'
git ls-tree -d --name-only origin/main tests/<套件名>
```

**为什么强调 `origin/main`:** 我有一次在一个老分支上 grep `server/src`,那儿只有 20 个 `.ts`,而 main 上是 106 —— 结论建立在了另一份代码上。检出目录的名字不告诉你它是哪个分支。

### 3. 计数只是候选,不是判定

最容易骗自己的一步。

```bash
# 🔴 范围和 flag 必须记全,否则这两个数没人能复现 —— 这一条是被审查抓出来的:
#    同样的模式在全仓跑分别是 26 和 123,不是 5 和 38。
git grep -lE 'tokens_used|input_tokens|output_tokens|total_tokens' \
  origin/main -- 'server/src/*.ts' 'agent-node/src/*.ts' | wc -l     # → 5
git grep -lE 'channelPlugin|channel-plugin|allowlist' \
  origin/main -- 'server/src/*.ts' 'agent-node/src/*.ts' | wc -l     # → 38
```

(`-lE` 区分大小写;换成 `-liE` 第二条会变成 39 —— 多出来的是
`agent-node/src/runtime/readable-attachment-prompt.ts`。**flag 也算范围。**)

这两个数当时看起来都像「做了」。实际:

- #114 那 5 个文件全是**日志与测试**,数据采到了就丢,`completions` / `tasks` 两张表一个用量列都没有;
- #177 那 38 个命中里没有一个是 `plugin:commhub` 实现,唯一提到它的地方是另一份 RFC 的对照表。

**判定必须落到一个具体断言上**:某张表有没有那一列、某个路由注册了几处、某个 flag 还在不在被 push。

顺带一个反例:`db.ts` 里 grep `cost` 有 6 处命中,全部是 **scrypt KDF 的 cost 参数**,和钱无关。词对了,意思完全不是一回事。

### 4. 找「它要退役的东西还在不在」

比「新东西做了没」更快、更硬的一个判据。

#177 的目标是让 #176 的 capture-pane workaround 退役。查下来:

```
agent-network/bin/cli.ts:5038   仍在 push("--dangerously-load-development-channels", ch)
agent-network/bin/cli.ts        capture-pane workaround 仍在
```

**旧东西还在跑 = 新东西没上。** 这条不需要理解新方案怎么实现的。

### 5. 检查正文里有没有「待确认」的前提

#177 的范围第 2 条写着:

> 需先确认 Claude Code 的 managed-settings 机制对自定义/本地 plugin 是否可用。

这个确认到今天没有结论。**如果它不可用,这条 issue 不是「还没排到」,是「走不通」** —— 两者对读者的意义完全不同,而挂在那里的样子一样。

带「待确认前提」的 issue,复核结论应该是**先去做那个确认**,而不是给它排期。

### 6. 查代码里有没有指向这条 issue 的注释

很多陈旧 issue 不是被遗忘的 —— **代码里留着指针**,只是没人回来更新 issue。

```bash
git grep -nE '#(<issue 号>)\b' origin/main -- '*.ts' '*.sh' '*.yml'
```

对这 30 条跑一遍:**6 条被源码按编号引用**(#31 / #166 / #182 / #191 / #246 / #338)。

🔴 **但 6 是下界。** #332 和 #207 也被代码引用,却抓不到 —— 因为它们的注释是描述式的、不带编号:

```
agent-node/src/feishu-tool-deny.ts:250   … a bubblewrap sandbox follow-up tracks the …
agent-node/src/cli.ts:3450               … Cross-machine artifact distribution is a P2 follow-up.
```

所以这一步要两样都做:**按编号 grep**,再**读你正在核的那块代码的注释**。只做前者会漏掉「代码知道、但没写号」的那些 —— 而那些恰恰是最该保留的:它们证明这条 issue 还活着,不是没人管。

### 7. 判不了就写明判不了

#177 的可行性要实机试 Claude Code 的 managed-settings 行为,仓库里验证不了。**这种时候写「我没能力从仓库验证这一点」,比给一个软判断有用。**

## 结论怎么写

四种结论,措辞不要含糊:

| 结论 | 写法 |
|---|---|
| 已交付 | 列出决定性证据(哪张表哪一列 / 哪个文件哪一行 / 哪条测试钉住了它),**建议关闭** |
| 未交付,缺口明确 | 说清「已有的」和「缺的」各是什么,指向已存在的设计(如果有) |
| 未交付,前提存疑 | 点出那个未验证的前提,建议先做确认再定去留 |
| 判不了 | 写明缺什么才能判,不给软结论 |

## 🔴 这份文档的第一版自己违反了它写的规则

审查(#846)提了五条,其中三条是**样例表在示范本文警告的错误**,值得原样留在这里:

1. **#175 我标成「已交付」,而结论表把「已交付」等同于「建议关闭」** —— 可上文第 2 段刚说过证据只覆盖标题那一句。**这正是「用窄证据关闭宽承诺」。** 已改成「部分核验」。
2. **#166 我标成「已交付」,而上文刚警告过「四件事里做了三件会被判成做完了」** —— 我列的恰好是三项证据。已改成「四项中三项已交付」,并写明第四项的实际状态。
3. **#114 我用错了判据。** 我拿「`completions`/`tasks` 没有用量列」当决定性证据,但 RFC-015 设计的是**独立的 `agent_token_usage` 表**,根本不改那两张表 —— 也就是说**即使将来完全按 RFC 实现,我那条证据依然成立,却会把它误判成未交付**。改成核验 RFC 点名的三个符号(结论不变,证据换了,而且更硬)。

第 3 条尤其值得记:**判据要对着「做完之后会长什么样」设计,不是对着「我猜它会改哪里」。** 我当时没读 RFC-015 的存储设计就选了判据,而那份 RFC 就在仓里。

另两条是:计数示例没记范围与 flag(已补,见上文第 3 步),以及本仓要求所有改动跑 Docker E2E —— 这一条见下。

## 这份文档的行号引用有一道门看着

`AGENTS.md` 要求所有改动先跑 Docker E2E。#846 的审查提了这一条,当时我的回答是「可以像 `tests/test831-doc-source-pins` 那样把它变成门,但那是独立改动」。现在补上了。

`tests/test846-doc-claims` 会读下面这个清单,逐条打开那个文件的那一行,确认它包含声称的子串。行号一漂就红。

<!-- 🔴 这三条 agent-node/src/cli.ts 原本是行号式，三天里漂了两次：
       #950  在 ~:462 插了 12 行 → 三条整体 +12（3468→3480 / 4291→4303 / 2388→2400）
       #984  对 cli.ts 净 +1 行   → 同样三条被打散成 3480→3481 / 4303→4302 / 2400→2401
     第二次尤其说明问题：**一个净 +1 行的改动，让三条本来正确的引用同时变错，
     而且两个方向都有**（增删发生在不同位置）。而漂掉之后的红，和「文档说错了」
     的红在输出上长得一样。
     所以这三条改成**两列式**：靠子串唯一定位，不写行号（见 scripts/check-doc-claims.py
     头部）。`total_cost_usd` 在 cli.ts 里有 3 处，所以加长成 `totalCostUsd: m.total_cost_usd`
     —— 顺带说明行号式掩盖了什么：一个不唯一的子串，本来就没钉住任何地方。
     🔴 2026-08-19（第三次）：`agent-network/bin/cli.ts :: 5151` 又漂了 —— 这次是 #853 那条
     诊断改动往 cli.ts 加了 16 行。**它正是上一轮我留着没改成两列式的那一条**，理由当时
     写的是「它的子串本来就唯一」。唯一不代表不漂：唯一性解决的是「指得准不准」，
     行号解决的是「指得到指不到」，**两者是两个问题**。这一条也改成两列式了；
     子串加长成整行 `claudeArgs.push("--dangerously-load-development-channels", ch)`，
     因为裸的 `dangerously-load-development-channels` 在该文件里有 4 处。
     🔴 收尾（同一个 PR 里）：不再等第四次，剩下三条也改成两列式 ——
     feishu-tool-deny.ts / tools.ts / server.ts。理由就是上面第三次那条:
     **唯一性解决「指得准不准」，行号解决「指得到指不到」，这是两个问题**，
     上一轮把它们混成一件，于是留下了一颗三天内第三次爆的雷。
     加长的两条：`list_providers` 在 tools.ts 里 2 处、`addNetworkScope` 在
     server.ts 里 **24 处** —— 后者尤其说明行号式掩盖了什么：一个出现 24 次的词
     本来就没钉住任何地方，行号只是让人看不出来。
     **只留 db.ts 那一条仍是行号式**，因为 tests/test846-doc-claims/run.sh 的
     drifted 变异打的就是它；改它等于顺手改动那道门的判据，属于另一条。
     ⇒ 清单里恰好保留一条行号式，它同时是那道门的 witnessed-red 夹具。
     其余几条保持行号式：它们的子串本来就唯一，而且 test846 的 drifted 变异打的就是
     清单里 db.ts 的那一条（`ADD COLUMN team`）。
     🔴 这段注释第一版把那条清单行**逐字抄了一遍**，于是同一个串在文档里出现两次，
     而 test846 的变异是 `t.count(old) == 1` + `replace(..., 1)` —— 它会打中我这段
     注释而不是清单，变异静默失效、门照绿。是我自己跑变异③时它没红才发现的。
     **写注释引用一条被机器匹配的行时，不要逐字复制它。** -->
```doc-claims
server/src/db.ts :: 393 :: ADD COLUMN team
agent-network/bin/cli.ts :: claudeArgs.push("--dangerously-load-development-channels", ch)
agent-node/src/cli.ts :: video_gen
agent-node/src/cli.ts :: Expose CURRENT_TASK_ID
agent-node/src/cli.ts :: totalCostUsd: m.total_cost_usd
agent-node/src/feishu-tool-deny.ts :: bubblewrap
server/src/tools.ts ::     "list_providers",
server/src/server.ts :: import { addNetworkScope, canRestWriteNetwork
```

### 为什么是显式清单,不是从正文正则抽

正文里的引用是**裸文件名**:`cli.ts:3450`、`db.ts:393`。而 `cli.ts` 在
`agent-network/bin/` 和 `agent-node/src/` 各有一个 —— 正则抽出来根本不知道该开哪个文件。
第一版我想直接从正文抽,试到这里才发现。

代价说清楚:**清单和正文可能各写各的。** 门检查的是清单。加条目时顺手核一下正文里确实引用过它。

### 🔴 这道门不检查什么

- **不检查正文的结论对不对。** 「`db.ts:393` 有 `ADD COLUMN team`」成立,不代表「#175 已交付」成立 —— 后者要人读 issue 正文。
- **不检查引用之外的散文。**

和 `scripts/check-doc-source-pins.py` 的边界同类:**门缩小了错误的种类,没有消灭错误。**

## 🔴 不要替 owner 关别人的 issue

给证据、给建议,不代行。关 issue 是外向动作,信号不可逆 —— 而复核者拿到的证据往往只覆盖标题那一句,正文里的细节条款未必逐条对过。

我核 #175 时就明确写了:证据只覆盖「node.team 列存在」,正文里的「详细方案」没有逐条比对。这种情况下关掉它,等于用一个窄证据关掉一个宽承诺。

## 七次复核的结果(可作为样例)

| issue | 结论 | 决定性证据 |
|---|---|---|
| #175 node.team | **部分核验** | `db.ts:393` 有 `ALTER TABLE nodes ADD COLUMN team TEXT`;`api-nodes-shape.test.ts` 把 `team` 写进 `/api/nodes` 投影断言。**只覆盖标题那一句;正文的「详细方案」未逐条比对,因此不建议据此关闭** |
| #166 REST fallback 等 | **四项中三项已交付** | 三个点名端点各注册 1 处;`cli.ts:4273-4310` 注入并恢复 `CURRENT_TASK_ID`;`tests/test166-task-diagnostics` 在 main。**第四项「MCP 可用性本身」没有交付证据** —— 仓库改不了外部会话的工具面板,现状是把这条边界写进文档并用测试钉住(见文末) |
| #114 token 用量 | 未交付,缺口明确 | 采集已完成(`cli.ts:2363/2373/2742`);**RFC-015 指定的 `agent_token_usage` 表 / `usage_event_id` / `token_usage_delta` 三个符号在全仓各只命中 1 个文件 —— 就是 RFC 自己**,即设计一行未落 |
| #177 channel plugin | 未交付,前提存疑 | `cli.ts:5038` 仍在 push dev-channel flag;全仓无 `plugin:commhub` 实现;正文的 managed-settings 可行性至今未确认 |
| #332 feishu Layer F sandbox | 未交付 | 全仓 `bubblewrap\|bwrap\|nsjail` 8 个文件命中,无一实现;`feishu-tool-deny.ts:250` 的注释把它标为 follow-up |
| #195 vendor 并发闸 + 429 退避 | 未交付 | 有通用 retry-with-backoff 与 inbox 层 `maxConcurrent=20`,但 `agent-node` 全域 grep `Retry-After` **命中 0** —— 429 只被分类,没被遵守 |
| #207 grok 跨机 artifact | 未交付,但传输层已有 | `cli.ts:3450` 注释自称「P2 follow-up. No fs mutation here.」;而 `tests/qa-222-cross-host-attachments` 证明 `/api/upload` + `/api/files/<id>` 的跨机取文件链路已完成 |

#166 那条还有一个值得学的细节:我本来准备指出「REST fallback 存在 ≠ MCP 没挂载这个根因解决了」,但 `tests/test166-task-diagnostics/run.sh` 里已经断言文档必须写着「不能证明外部模型会话是否挂载了 MCP tools」。**有人已经把这层边界写进文档并用测试钉住了** —— 复核时先看套件断言什么,可能省掉一次重复发现。
