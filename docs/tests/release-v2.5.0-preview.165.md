# 2.5.0-preview.165

> agent-node 这一版带两条**都是"等待"相关的浪费/丢失**：一边少打 5900 次轮询，一边把等到超时的结果捞回来。

## 1. 轮询纪律写进提示词（`#3237`）

实测一个节点在空闲等待里以约 13 次/分钟连续拉了 8 小时 `get_task`（约 6000 次），
每次都是一整轮 LLM —— 成本全花在"看有没有好"。

现在提示词里写明：

```
· get_task 两次之间至少隔 60 秒
· 子任务的最终结果会自动通过 parent_task_id chain 回上游，不盯着不会丢
· 新增【轮询纪律】小节，附实测数字
```

抽成 `poll-discipline-guidance.ts` 并可被断言（照 `sse-recovery-guidance` 的做法），
否则以后改回"轮询直到完成"测试仍绿、行为退回。

## 2. 超时之后这一轮才结束时，把结果补回来（`#3249` / `#3071`）

```
现场：289 条「仍在 TUI 会话里运行…等待回复已达 30 分钟上限」的失败任务，
      thread/turn 全为 null；全库迟到结果只有 4 行
⇒ 那一轮跑完了，但没人在听，结果直接蒸发
```

Hub 侧接收端已能收（commhub-server `.213`），这一版补发送端：

```
超时后不 await 地启动 watchLateReply：
  继续轮询会话历史 → 这一轮结束时 send_reply(in_reply_to, thread_id, turn_id)
边界：不阻塞收件循环 / 60 分钟硬上限 / 只补一次 / provider 报错也补（status=failed）
```

## 测试

```
late-reply-3071.test.ts：6 pass
copresence 目录：237 pass（1 条 undici 未安装的既有失败，与改动无关）
preflight 54 passed
```

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.165
```

## Upgrade

```bash
# 节点侧：升级 agent-node 后重启节点
npm i -g @sleep2agi/agent-node@2.5.0-preview.165
anet node stop <alias> && anet node start <alias>
# 或直接用配对好的 CLI：@sleep2agi/agent-network@2.3.0-preview.200
```
