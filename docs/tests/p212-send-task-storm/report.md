# #212 A站Grok send_task storm — root cause + dedup guardrail evidence

> **任务来源**: 通信龙 P0 dispatch task_id `ac6c79d7` ([issue #212](https://github.com/sleep2agi/agent-network/issues/212)) — A站Grok 节点 2026-06-10 向 A站负责人 重复派发同一任务 50+ 次, 无视 3 次 STOP 回复, 节点已 anet node stop 止血。
> **方法**: 只读分析 grok session JSONL (`/home/vansin/.grok/sessions/.../019ea1e9-.../updates.jsonl`, 8.7 MB), 不起任何节点, 不连 prod hub。
> **作者**: 通信SDK马
> **日期**: 2026-06-10

## TL;DR

| 维度 | 数值 |
|---|---|
| 总 `commhub_send_task` 工具调用 | **65** |
| 发给 A站负责人 | 55 |
| 发给 总指挥 | 9 |
| 发给 安站负责人 (typo) | 1 |
| **同 (target, content-hash) 调用 ≥2 次** | **2 组共 54 个调用** |
| 最严重一组: "Claude Fable 5 推文" 任务 | **51 次 identical 给 A站负责人**, 14.8 min 内, 中位 gap 17s |
| 次严重一组: "video upload" 任务 | 3 次 identical |
| 第一次/最后一次跨度 | 220k 秒(61.2h) — 跨多个 resume 窗 |

**护栏验证 (#212 ship 的 `SendDedup`, 默认 5min 窗)**: 51 次 burst 里 50 个 inter-call gap **全部 <60s**, 即使 1-min 窗口都能拦下全部 50 次重发。当下 default 5-min 窗口 **保护倍数 ≥300×**。

## 根因 — 不是单条 bug, 是两个 anti-pattern 叠加

### Anti-pattern A: LLM 自身缺乏 outgoing-call 自检

51 次 burst 来自单一 LLM "turn series" 里的 14.8 min 窗口, 中位 17s 一次。看 transcript 的 LLM 行为:

1. 第 1 次发: 正常 dispatch
2. 第 2 次发: LLM 大概率没意识到第 1 次已发(没看 inbox / 没等 reply)就再发
3. 第 N 次发: 即便 STOP reply 进 inbox, LLM turn 还没消费完不会立即响应; 或者 reply 进入上下文了 LLM 也没改"重发该任务"的决策

**→ LLM 行为不可信。任何 anet runtime / commhub-server 层都必须假设 LLM 会无限循环, 自带护栏**。

### Anti-pattern B: resume 老 session 把"未闭环派发"带回上下文

session JSONL 的时间戳跨度证实 resume 路径:

- 第 1 个 send_task: ts 1780832963 (大约一天半前)
- 第 11 个之后有 **35.4 小时 gap**: 1780924915 → 1781052199
- 第 51 个 burst 全部发生在 gap 之后, 即 resume 重启后的新 turn 范围里

resume 时 grok 把上次 session 的全部对话历史(包括"已派 task 1d1dc39c 等回复")当作上下文恢复, 但当时 reply 并未在历史里(因为节点之前停掉了, reply 来不及消费)。LLM 看到"我之前承诺要派活但没看到结果", 自然又派一次, 再派一次, 滚雪球。

→ resume 行为本身合理(不能丢上下文), 但**未闭环 dispatch 应该在 resume 前注入合成 reply / 截断 / 至少 prompt-level 提示**, 避免 LLM 误判"还得再派一次"。这是 follow-up issue 的工作。

### Sanity check: ignored STOP replies

LLM 在 burst 里 14.8 min 收到至少 3 次 A站负责人 STOP 回复 — 但 LLM turn 里调 send_task 的频率(中位 17s)远高于 grok agent 重新消费 inbox 的频率, 所以 STOP reply 即便到了也来不及打断已经在 streaming 中的 LLM turn。再次印证 anti-pattern A。

## 护栏设计 (本 commit ship)

新 `server/src/send_dedup.ts` 提供 process-wide `SendDedup` 单例 + `buildDuplicateSendPayload`:

- **Key**: `${from_session}|${target_alias}|sha256(content)`
- **Window**: `COMMHUB_SEND_DEDUP_WINDOW_MS` env, default `300000` (5 min), `0` = 全禁
- **State**: in-memory Map, opportunistic 过期 evict + maxKeys 上限(default 4096) oldest-first cap
- **存数**: 只存 hash, 不存原内容(在内存里 sniff-safe)
- **失败保护**: `record(...)` 在 inbox/tasks 事务**成功后**才落, 失败 send 不污染 dedup index

接入点(both transports):
- `server/src/tools.ts` `send_task` MCP 工具(grok / claude / codex via MCP)
- `server/src/index.ts` `POST /api/task` REST 端点(dashboard dispatch 按钮 / 脚本)

被 reject 时返回结构化错误(MCP wrap 进 `content[0].text` JSON; REST 直接返回 + HTTP 429):

```json
{
  "ok": false,
  "error": "duplicate_send",
  "message": "同内容任务 5 分钟内已发给 A站负责人, 如确需重发请改写内容或等待。 (Last sent 12345ms ago)",
  "details": {
    "from": "A站Grok",
    "target": "A站负责人",
    "age_ms": 12345,
    "window_ms": 300000,
    "hint_zh": "同内容任务 5 分钟内已发给 A站负责人, ...",
    "hint_en": "Same task content already sent to A站负责人 within the last 5 min — change the content or wait. ..."
  }
}
```

LLM 看到这个结构化 error 后, 中文 hint 可以直接 reason / rewrite 任务内容或退让。

## 验证 — 单元测试

`server/src/send_dedup.test.ts` 13 个测试, 覆盖:

- `readDedupConfig` env 解析 + clamp + 默认
- `SendDedup` 重复检测 / 跨 sender / 跨 target / 跨 content 不互扰
- 窗口过期允许再发
- `windowMs=0` 全禁短路
- 过期 evict + maxKeys 上限 oldest-first eviction
- key 形态(`from|to|sha256(64hex)`, 不含原始内容)
- `buildDuplicateSendPayload` Chinese hint + 分钟舍入 + 双语 details

跑测: `cd server && bun test src/` → **74 pass / 0 fail** (61 原 + 13 新)。

## resume 风险 (follow-up issue 建议)

当前 anet `grok-build-acp` runtime 在 `runtime.ts` 调 `session/load` 拉回老 sessionId, grok agent 把完整历史 replay 进 LLM 上下文。无任何"已派 task 仍未闭环"层面的提示或截断。

**建议 follow-up** (单独 issue, 不在本 commit 范围):

1. **检测层** — agent-node `cli.ts` 在 `node start` resume 时查 commhub `list_tasks?from=<self>&status=delivered,started`, 把仍未闭环的 dispatch 列出来
2. **温和方案 (推荐先)** — 在传给 grok 的首个 prompt 里附 "以下 N 个 task 在你停机前已派出仍未收到 reply: [list]; 不要再次派发同样内容, 必要时主动 send_message 询问对方进度"
3. **激进方案 (高风险, 后续)** — 给每个未闭环 task 注入合成 system message "[task X 已 timeout, 视为失败]" 进 grok 上下文, 让 LLM 主动重派或放弃

短期内 #212 ship 的 server-side dedup 已经能拦下绝大多数 resume-driven 重发(本 burst 50/50 都会被 1-min 窗口拦), 不阻塞 A站Grok 恢复; resume 层面优化是质量提升, 不是阻塞 fix。

## 不做的事 (per 红线)

- ❌ 不本机起测试节点(红线:测试节点不在宿主上起 —— 它拿到的是真 HOME 和真工作树)
- ❌ A站Grok 保持停机不动
- ❌ 不连 prod hub
- ❌ 不擅自改 grok session 状态文件
- ❌ 不修改 PINNED_SERVER_VERSION (per 通信龙 提醒, 这是 工程马 release ops 范围)

## 后续

| ID | 类型 | 谁 |
|---|---|---|
| **#212 dedup ship** | 本 commit | 通信SDK马 |
| **agent-network cli.ts PINNED_SERVER_VERSION bump** | 跟 commhub-server preview 同步 | 工程马 |
| **本机 hub preview 升级 + Vincent 协调重启** | release ops + 通信龙 | 通信龙 + Vincent |
| **resume 层未闭环 dispatch 提示** | follow-up issue | 待派 |

## 数据来源

- `/home/vansin/.grok/sessions/%2Fhome%2Fvansin%2F.anet%2Fnodes%2Fn_19af86cc%2Fgrok-cwd/019ea1e9-9cdd-7062-8401-8e376f4404c4/updates.jsonl` (8.7 MB, 只读分析)
- A站Grok 节点日志 `2026-06-10` 段(由通信龙 dispatch 引用)

---

**Author-Agent**: 通信SDK马
