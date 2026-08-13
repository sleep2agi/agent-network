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

```
#114  grep tokens_used|input_tokens|total_tokens → 命中 5 个文件
#177  grep channelPlugin|channel-plugin|allowlist → 命中 38 个文件
```

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

## 🔴 不要替 owner 关别人的 issue

给证据、给建议,不代行。关 issue 是外向动作,信号不可逆 —— 而复核者拿到的证据往往只覆盖标题那一句,正文里的细节条款未必逐条对过。

我核 #175 时就明确写了:证据只覆盖「node.team 列存在」,正文里的「详细方案」没有逐条比对。这种情况下关掉它,等于用一个窄证据关掉一个宽承诺。

## 七次复核的结果(可作为样例)

| issue | 结论 | 决定性证据 |
|---|---|---|
| #175 node.team | 已交付 | `db.ts:393` 有 `ALTER TABLE nodes ADD COLUMN team TEXT`;`api-nodes-shape.test.ts` 把 `team` 写进 `/api/nodes` 投影断言 |
| #166 REST fallback 等 | 已交付 | 三个点名端点各注册 1 处;`cli.ts:4273-4310` 在跑运行时前注入 `CURRENT_TASK_ID`、跑完恢复;`tests/test166-task-diagnostics` 在 main |
| #114 token 用量 | 未交付,缺口明确 | 采集已完成(`cli.ts:2363/2373/2742`),但 `completions`/`tasks` 无用量列;`docs/rfcs/RFC-015-token-usage-telemetry.md` 已写明剩余设计 |
| #177 channel plugin | 未交付,前提存疑 | `cli.ts:5038` 仍在 push dev-channel flag;全仓无 `plugin:commhub` 实现;正文的 managed-settings 可行性至今未确认 |
| #332 feishu Layer F sandbox | 未交付 | 全仓 `bubblewrap\|bwrap\|nsjail` 8 个文件命中,无一实现;`feishu-tool-deny.ts:250` 的注释把它标为 follow-up |
| #195 vendor 并发闸 + 429 退避 | 未交付 | 有通用 retry-with-backoff 与 inbox 层 `maxConcurrent=20`,但 `agent-node` 全域 grep `Retry-After` **命中 0** —— 429 只被分类,没被遵守 |
| #207 grok 跨机 artifact | 未交付,但传输层已有 | `cli.ts:3450` 注释自称「P2 follow-up. No fs mutation here.」;而 `tests/qa-222-cross-host-attachments` 证明 `/api/upload` + `/api/files/<id>` 的跨机取文件链路已完成 |

#166 那条还有一个值得学的细节:我本来准备指出「REST fallback 存在 ≠ MCP 没挂载这个根因解决了」,但 `tests/test166-task-diagnostics/run.sh` 里已经断言文档必须写着「不能证明外部模型会话是否挂载了 MCP tools」。**有人已经把这层边界写进文档并用测试钉住了** —— 复核时先看套件断言什么,可能省掉一次重复发现。
