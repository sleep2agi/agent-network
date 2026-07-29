# opencode 会话忙闲信号 — 实测记录

日期：2026-07-29
环境：独立服务器（4 核 / 14G，专用于该实验），opencode-ai 1.17.13，免费模型 `opencode/deepseek-v4-flash-free`

## 背景

opencode 人机共存的拓扑决策卡在一个前提上：**外部能否知道某个会话正在生成中**。
此前的探测结论是"没有可用的状态端点"，据此倾向于选择成本较高的方案（自建一层终端仲裁）。

## 实测结论：信号存在，之前的探测方式错过了它

`/event` 是一条 **SSE 推送流**，其中 `session.status` 事件带 **per-session 的忙闲状态**：

```json
{"type":"session.status","properties":{"sessionID":"ses_…","status":{"type":"busy"}}}
{"type":"session.status","properties":{"sessionID":"ses_…","status":{"type":"idle"}}}
```

单次生成期间共捕获 224 条事件，类型分布（节选）：

| 事件类型 | 条数 |
|---|---|
| `message.part.delta` | 68 |
| `message.part.updated` | 14 |
| `message.updated` | 10 |
| `session.status` | 6 |
| `step-start` / `step-finish` | 2 / 2 |

`session.status` 完整覆盖了 **busy → idle** 的转换。

## 之前为什么判成"没有"

1. 只探测了**主动查询**类端点（`/session/:id/state`、`/status` 等），这些确实不存在；
2. 唯一探到 `/event` 的那次，**读取超时设为 2 秒，仅收到 89 字节即断开**，没有读到流内容。

**信号是推送式的，不是拉取式的**——探测方法与信号形态不匹配，因此得出了假阴性。

## 对共存设计的影响

- 外部程序**可以**订阅 `/event`、按 `sessionID` 跟踪忙闲，从而在会话忙时不发送自己的消息；
- 这使"轻量方案（订阅事件 + 自我串行）"重新可行，无需自建终端仲裁层。

## 必须同时记住的边界

该信号**只能约束我们自己**，**约束不了人**。

同一环境下已复现：当第二条消息真正落在第一条的生成窗口内（以时间戳证明重叠），两条消息会被**合并为同一条回复**（相同 message id、同时返回）。人类随时可能手动输入，不受程序协调。

因此订阅事件的真实价值是：

1. 我们自己**永远不制造冲突**；
2. 检测到忙时可以**提示或排队**，而不是无声合并。

## 复现方法

1. `opencode serve --hostname 127.0.0.1 --port <port>`
2. 订阅：`curl -sN -H 'Accept: text/event-stream' http://127.0.0.1:<port>/event`
3. 另一路发送一次会话消息，观察 `session.status` 的 busy/idle 转换

**合并现象的复现要点**：必须先用时间戳证明第二条消息确实落在第一条的生成窗口内。若第一条已结束才发第二条，两条会得到不同的 message id，从而得出"不会合并"的错误结论。
