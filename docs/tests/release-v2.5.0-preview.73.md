# agent-node 2.5.0-preview.73

`.72` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| 7d627ef5 | #1919 | ① 长回合心跳:turn 开着时每 30–60 s 写一行 `in-flight: loop=N, elapsed=Xm Ys, last=<最近动作>`(仅 `grok-build-acp` / `grok-build-cli` —— 只有这两个运行时现成有活动信号,其余不硬造);② stderr 按运行时降噪:已知无害的模式不再逐条升成 WARN,而是整回合折成一行 INFO `known-benign stderr this turn: N (<kind> N)`,表里当前两条都是 grok 的(`path outside Grok runtime cwd`、`tool_error: tool_output_error`),表外一律维持原有 WARN/DEBUG 分流;③ 新增 `ANET_LOG_LEVEL`,并且非法值会告警(#1917) |

## 这一版带给用户什么

**「看着不动」不再和「真的卡住」长得一样。** 一个 16.4 分钟的 grok 回合,节点日志只写 11 行(其中 8–9 行还是同一条 stderr 重复),而 grok 自己的日志同窗写了 224 行;当天该节点最长静默 4492 秒。从节点日志你只能看出回合**开始了**和**结束了**,中间一片空白。现在中间有心跳,带已跑时长和最后一个动作名。

**真告警不再被噪声淹掉。** 旧规则是 stderr 里出现 `error|fail|cannot|denied|enoent|not found` 任一词就升 WARN,于是 grok 沙箱按 cwd 拒绝真实路径这类**已知无害、不影响任务成败**的事件(某天 12 次)会刷满日志,把同日真正的 SSE 断连挤下去。注意折的是**一行 INFO 不是零**——把 12 行折成 1 行是降噪,折成 0 行是藏。

**一格更正,写在这里免得误导:** #1917 原文说「没有 log level 旋钮」——**半对**。`--log-level`、`LOG_LEVEL`、`config.logLevel` 一直都能用,你现在就能调密,不必等这一版。真正缺的是 (a) 一个 `ANET_` 前缀的名字(运维都往那儿找,本产品其它旋钮都在那儿),(b) 值写错时**一声不吭**——旧表达式结尾是 `?? 1`,所以 `LOG_LEVEL=quiet` 静默等于 `info`,人的心智模型会一直错到别的东西炸掉为止。本版补上别名与告警;读不懂的旋钮不会阻止节点启动,告警一次后按默认继续。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.73
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.97 @sleep2agi/agent-node@2.5.0-preview.73
anet node stop <name> && anet node start <name>   # 重启才加载新运行时
```

## 证据

- 两向见证是这次的重点:12 行 `path outside Grok runtime cwd` 折成**恰好一行**且级别不是 warn;`Settings fetch failed` / `connection refused` / `ENOENT` / `permission denied` **仍然 warn**;混合回合里真故障立即出、其余才折叠。**阳性对照**:同一行路径越界喂给 `codex`(表里没有它)仍然 warn —— 证明是表生效,不是正则被改松。
- 心跳:5 分钟静默回合出 5 行、elapsed 严格递增、loop 连号;`stop()` 之后再模拟 10 分钟出 **0 行**且句柄已清;短于一个间隔的回合 0 行。
- `ANET_LOG_LEVEL`:warn 时 info 行消失、debug 时出现、垃圾值走默认并告警一次。
- agent-node 全套 1846 pass / 0 fail;typecheck 棘轮 81 = 基线;doc-symbol-pins 两种 CI 参数形式、doc-source-pins、version-claims 全 rc=0;无 `tests/*/run.sh` 的 sed 锚落在改动行上;打包后四条面向运维的新字符串在压缩产物里仍在。
- 🔴 一格自曝:第一版降噪测试照 #1917 正文,把 `SSE error: terminated` 等三条断言成「必须仍是 WARN」,**红了而且红得对** —— 那三条是 agent-node **自己 `warn()` 打的**,根本不经过 stderr 分类器。量错了对象;现另有一条测试专钉这个边界。

## promote 时的 must_contain

`"version": "2.5.0-preview.73"`
