# agent-node 2.5.0-preview.76

`.75` 之后 `agent-node/` 四个提交:

| 提交 | PR | 内容 |
|---|---|---|
| b60b00e4 | #1939 | codex 队列:**所有终态路径都摘 FIFO 行**,不再只有期限那条(#1935) |
| 38fdbc10 | #1937 | 任务在「从未进入 turn」就结束时留一行痕迹 —— 队列标记漏记,计数只是下界(#1935) |
| cf5122fe | #1936 | 公开仓里清掉外部团队的节点别名/主机名/内网地址(注释与文档;本包 bundle 会剥注释,产物内容不变)(#1933) |
| de98dcb5 | #1934 | 补真空断言的阳性对照;索引记录缺 `node_dir` 时跳过而不当幽灵节点;夹具去掉真实别名(#1918) |

## 本版修的是什么

`codex-app-server` 是串行队列。运行时那个文件里有**五条终态路径,此前只有期限那条会把 FIFO 行摘掉**。其余三条(同一 taskId 的幽灵 `task_reply`、排队期间 `task_error`、行已入队后 `submitTask` 才 reject)都走 `finish()`:清掉仍然 armed 的计时器、摘掉全部监听器,**但不碰队列里那一行**。于是行活着,几小时后可能真的被排到并执行,而那时调用方已经死了,**连它自己的 `task_started` 都打不出来** —— 这一族在日志里完全不可见。

判断的支点是一条不变式:**已经告诉发件方的结论,必须与系统随后真正做的事一致。**回了 `failed` 就不能几小时后偷偷跑起来;回了答案就不能再跑一遍(那正是 #1900 的「已终态任务又跑一轮」,而且这次连日志都没有)。只摘「刚刚被报告过终态的那个 taskId 的行」;终态结论若本身是错的(幽灵回件),缺陷在那条回件,不在摘除。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.76
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.100 @sleep2agi/agent-node@2.5.0-preview.76
```

🔴 **两个包要一起升。** 配对是精确的(`.100 ↔ .76`);共享登录态检测那份模块逐字节相同地存在于两个包里,两条启动路径各用各的那份。

## 证据

- 三条静默路径各自:终态报告之后 FIFO 行**已被摘除**(`cancelCalls=1`、队列清空、日志 `queued FIFO row cancelled`);把源码改动回退,这三条 + 新增的「已离开 FIFO」用例转红(2 pass / 5 fail),两条既有对照仍绿。
- 🔴 **从未报告过终态的排队行必须原样保留**:两个并发调用各入队一行,只有一个走到终态;断言被摘的只有它(`["t_ends"]`)、另一行仍在(`["t_stays"]`)、另一个调用之后仍正常回复。把摘除范围放宽,这条在两个方向都会红 —— 把「静默重复执行」修成「静默丢件」是更糟的缺陷。
- 期限路径行为不变:仍只摘一次、只报一次;`!queueDeadlineElapsed` 守卫使新分支不与之重叠(Node 在计时器触发后仍把句柄留成非 null)。
- #1937 那行日志拆成两句,保留可 grep 的 `settled before admission` 前缀:摘成功 ⇒ `queued FIFO row cancelled`;`cancelQueuedTask` 返回 false(start RPC 已在飞) ⇒ `FIFO row already gone and may still execute`,因为那里原来的告警仍然为真。
- agent-node 全套 1872 pass / 0 fail;typecheck 棘轮 81 = 基线;test587/test588 的 30 处 `replaceExact` 锚逐个复核仍各命中一次。
- **未做**:生产上那条「排队 28 小时且无任何标记」的样本**在 main 上复现不出来**(它打了 `task_started`,而那行只有仍活着的调用方才打得出);那台跑的是 `.33` 补丁拷贝,本版不对它下结论。

## 披露

`@sleep2agi/agent-network` 的 `2.3.0-preview.97` 至 `.99`(配对本包 `.73`–`.75`)的 `dist/src/*.d.ts` 注释中含有合作团队的节点别名(去重后分别 9 / 9 / 11 处;按「别名模式命中 + 裸团队名」两个集合相加则为 10 / 10 / 12,其中同一行的 `TMHR狗`+`TMHR` 被重复计数);本对版本起已改为中性表述。本包(agent-node)的 bundle 会剥注释,`.73`–`.75` 的产物内不含。旧版本**不撤包**:撤包会打断所有钉了版本的使用者,代价大于暴露面。

## promote 时的 must_contain

`"version": "2.5.0-preview.76"`
