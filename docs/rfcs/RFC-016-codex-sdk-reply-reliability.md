# RFC-016 — #168 codex-sdk 完成回执可靠性 (ACK/retry + artifact metadata)

**作者**: 通信SDK马
**状态**: Draft v1 (待 通信牛 review + 通信龙 ack + Vincent confirm)
**关联 issue**: #168 (P0 tracker), 串轨 #166 / #167 / #158 umbrella
**关联 ship**: codex-sdk runtime 修复轨 — **不进 v0.10.9**(scope 锁死 #157 RC#2),候选 v0.10.10 / v0.11.0
**红线**: runtime 级改动 — ship 前留 Vincent confirm 窗口 + Docker smoke gate,不许跳

---

## 1. 背景

codex-sdk 节点(海报设计师 1-5 号 / GPT-Image2)完成任务、产物落盘 `/tmp` 后,完成回执经常 silent-lost,派单方误判节点卡住。2026-05-21 5-20 日报封面单三方实证一致(海报设计师 4/5 号 07:52/07:57 已落盘,回执未达 A站运营马)。

本 RFC 给出 root-cause audit + 修复方案设计。

## 2. Root-cause audit

读 `agent-node/src/cli.ts` 回执发送路径,定位 **5 个 silent-lost 向量**。codex-sdk runtime 的完成回执链路:

```
SSE new_task → processInbox() → getInbox() → 每条 msg:
  ackMessage(msg.id)              ← cli.ts:1149
  → processTask() → think() → processWithCodex()
  → 低价值过滤                     ← cli.ts:1165
  → sendReply() → callCommHub("send_reply")  ← cli.ts:1170-1175 / 469
```

### RC-A — 低价值过滤吞掉短完成文本 (`cli.ts:1165`)

```ts
if (!failed && isLowValueText(result, true)) { log(`skip reply: low-value`); continue; }
```

`LOW_VALUE_PHRASES` 含 `done` / `ok` / `ack` 等;`isLowValueText` 还吞纯 emoji。codex-sdk 图像节点完成时的文本回执常常很短("Done." / "✅" / "图已生成")→ 整条回执被 `continue` 跳过,**只有本地一行 `log()`,派单方零感知**。

### RC-B1 — callCommHub retry 耗尽只在本地 warn (`cli.ts:393-431` + `1170-1175`)

`callCommHub` retry 3 次后 `throw lastErr`;`processInbox` 的 catch:

```ts
} catch (e: any) { warn(`reply failed: ${e.message}`); }
```

retry 耗尽后异常只写进 agent-node 本地日志文件。**没有 `failed` 回执到 commhub,派单方的 task 永远停在 open**,节点看起来"完成了任务却没回执"。

### RC-B2 — callCommHub 把 HTTP-200 + JSON-RPC error 当成功 (`cli.ts:413` / `418-422`)

```ts
if (!res.ok && attempt < retries) { ... retry ... }   // 只对 !res.ok retry
const data = match ? JSON.parse(match[1]) : JSON.parse(raw);
const text = data?.result?.content?.[0]?.text;
return text ? JSON.parse(text) : data;                // 不查 data.error / result.isError
```

server 端 send_reply 被拒(task 已关闭 / 目标离线)时返回 **HTTP 200 + JSON-RPC `error` 信封 或 `result.isError`**。`callCommHub` 既不 retry 也不抛 — resolve 成功。`processInbox` 照常 `log(→ [from])` 当作已送达。**server 端拒绝在客户端看起来是成功送达** —— silent success。

### RC-C — ackMessage 抢在 processTask 之前 (`cli.ts:1149`)

`await ackMessage(msg.id)` 在 `processTask()` **之前**执行。inbox 消息在任务处理 / 回执确认之前就被 ack 移除。进程中途崩溃、或回执发送失败 → 消息已不在 inbox,**无重投**,任务永久丢失。

### RC-D — 落盘无结构化事件

`processWithCodex` 只返回 prose 文本。产物写到 `/tmp` 后没有任何 `task.artifact.ready` / `task.completed` 携带文件路径的事件。即便文本回执被 RC-A 吞 / RC-B 丢,产物在 `/tmp` 里**零线索**。

### RC-E — 节点先翻 idle,回执后发 → "健康"假象 (`cli.ts:1083`)

`processTask` 的 `finally` 里 `reportStatus("idle")` —— 但 `sendReply` 在 `processInbox` 里、`processTask` **返回之后**才调用。时序:

```
任务完成 → reportStatus("idle")  [finally]
         → sendReply()           [processInbox,之后]  → 失败,只 warn()
```

节点在回执还没发、甚至发失败时就已经翻 `idle`。派单方 `get_all_status` 看到节点 **idle/健康/空闲** —— 比"卡住"更隐蔽:节点看起来随时可接活,而它派出去的 task 还 open。且 `report_status` 不带任何 `last_*` 字段,派单方**无处可直查**完成态。

> **核心洞察**: silent-lost 不是单点 bug,是 *吞 (A) + 丢不报 (B1) + 假成功 (B2) + 不可重投 (C) + 无产物信号 (D) + 健康假象+不可查 (E)* 六层叠加。修复必须分层覆盖。

## 3. 修复方案

按 #168 修复清单 P0 ①②③ + P1 ④⑤⑥,标注 lane 边界。

### Lane 划分

| Lane | 范围 |
|---|---|
| **SDK马**(本 RFC owner) | agent-node:`callCommHub` 错误识别、`sendReply` ACK/retry/escalate、ack 重排、artifact diff+emit、`last_*` 上报、body 校验 |
| **通信牛** | commhub-server:接收 artifact/completed 事件、持久化 `last_*` + artifact 列、task 状态查询 API、task 信封带 body 长度/hash、确认 get_inbox 重投语义 |
| **N站马** | Dashboard ⑥ `artifact ready, reply missing` 状态渲染 |

### P0-① 可靠 ACK + retry + retry 耗尽显式 reply_failed (SDK马)

1. **callCommHub 正确识别失败**(修 RC-B2):解析后检查 `data.error`、`result.isError`、以及 commhub tool payload 里的 `ok:false` → 视为失败,纳入 retry;retry 耗尽仍 throw。HTTP-200-假成功堵死。
2. **sendReply 返回结构化结果**:不再 fire-and-forget。成功时确认 commhub 回执里带 reply/message id;返回 `{delivered:true,reply_id}` 或抛。
3. **retry 耗尽 escalate**(修 RC-B1):`processInbox` 里 sendReply 抛出后 ——
   - (a) `report_status` 写 `last_reply_status="failed"` + `last_reply_error`(见 P0-③);
   - (b) 降级 fallback:`send_message` 给派单方 + 一条 `failed` 状态,至少让人看见;
   - (c) 写本地持久化 retry-queue(`.anet/nodes/<alias>/pending-replies.json`),下个 SSE tick / 重启时重发,而不是丢。
4. **ack 重排**(修 RC-C):`ackMessage` 移到回执成功送达**之后**(或写入 retry-queue 之后)。依赖 commhub `get_inbox` 重投语义 —— **需 通信牛 确认**:未 ack 的消息是否会被 get_inbox 重投?是 → 干净;否 → 由 (c) 本地 retry-queue 兜底。

### P0-② 落盘后 emit task.artifact.ready / task.completed (SDK马 emit + 通信牛 accept)

- agent-node:`processWithCodex` / `processWithCodexStdio` 跑任务**前后** snapshot 一个产物目录(`ANET_ARTIFACT_DIR`,默认节点 workdir;codex-sdk 设计节点配 `/tmp` 或专用目录),diff 出新增文件 = `artifact_paths`。比解析 prose 里的 `/tmp/...` 路径更稳。
- emit `task.artifact.ready` —— **独立于文本回执**,即便 RC-A 吞了文本,artifact 事件照样落:

```json
{ "event": "task.artifact.ready", "task_id": "...", "alias": "海报设计师4号",
  "artifact_paths": ["/tmp/...png"], "completed_at": "2026-05-21T07:52:00+08:00" }
```

- server 端(通信牛)新增 commhub tool / endpoint 接收该事件并落库。

### P0-③ task/session 层 last_* 字段 (SDK马 上报 + 通信牛 持久化)

- agent-node:`report_status` payload 扩 `last_output_path` / `last_completed_at` / `last_reply_status` / `last_reply_error`。payload 本就可扩(Zod 默认 drop 未知键,见 `cli.ts:438-442` 注释)→ 加字段即可、无需双边协调发版。
- **修 RC-E 时序**:任务完成后不要立刻无条件翻 `idle`。终态 `report_status` 带真实 `last_reply_status`;回执确认送达 / 入 retry-queue 之后才翻 idle。
- server(通信牛):session/task 行加列,持久化。

### P1-④ task body 完整性校验 (SDK马 verify + 通信牛 envelope)

- server(通信牛):task 信封带 body 长度或 hash。
- agent-node:收到 task 后校验长度/hash。不匹配 → 显式 `failed` 回执"task body 截断",不静默执行半截 brief(同源历史:hero B / 小红书节点收不到 brief)。

### P1-⑤ task 状态查询 API (通信牛)

`get_session_status`(已存在,`commhub-mcp.ts:170`)扩字段:`current_task` / `inbox_pending` / `last_delivery` / `last_reply_attempt` / `last_reply_error` / `last_completed_at`。纯 server 端增强。

### P1-⑥ Dashboard artifact ready, reply missing (N站马)

读 P0-③ 新字段;当 `last artifact 存在 + last_reply_status ∈ {failed,missing}` 时渲染独立告警态。

## 4. 串轨 #166 / #167 / #158

- **#167**(send_task 日志可观测性):P0-① 的 sendReply start/ack/delivered/failed log 正是 #167 要的回执侧日志;同一 log 范式扩到 `send_task` 即覆盖 #167 大半。
- **#166**(MCP 缺失 REST fallback):RC-B2 的"正确解析 server 响应"对 REST fallback 路径同样适用。可靠 ACK 契约应 **transport-agnostic**(MCP / REST 一致)。
- **#158** umbrella:三件共构 codex-sdk runtime task fallback + logging + reliability 排障链。

## 5. 测试 (Docker smoke gate — 不许跳)

`node:24-alpine` + `agent-node@preview` + `commhub-server@preview`,容器内:

1. codex-sdk 节点收 task → 产物落盘 → 验 `task.artifact.ready` 事件 + `artifact_paths` 非空。
2. 模拟回执失败:断 commhub `/mcp` 后让节点完成任务 → 验 `last_reply_status=failed` + `last_reply_error` 上报 + retry-queue 落盘 + 恢复后重发成功。
3. server 返 HTTP-200 + JSON-RPC error → 验 callCommHub 识别为失败、不再假成功。
4. ack 重排:回执失败时消息不被提前 ack(或 retry-queue 兜底),验任务不丢。
5. body 截断 → 验显式 `failed` 回执。

## 6. Ship 路径

1. 通信牛 review 本 RFC(scope / lane 边界 / get_inbox 重投语义确认)。
2. 通信龙 ack + Vincent confirm(runtime 级改动红线)。
3. SDK马 实施 agent-node 侧;通信牛 实施 server 侧;并行。
4. Docker smoke gate 全 5 case PASS + transcript。
5. preview 发版 → Vincent 亲测 → promote。

**Status**: Draft v1,待 通信牛 review。

**作者**: 通信SDK马 · 2026-05-21
