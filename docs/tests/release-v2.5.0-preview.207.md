# agent-node 2.5.0-preview.207

Since `.206`：把 **control 消息的处理并发化**。`.206` 已经让带 `control` 的 `new_message` 唤醒工作通道，
但工作通道是**串行 lane**，会被正在跑的回合占住（await 整个 model turn）⇒ interrupt 要等回合跑完才被取到，
实测 `interrupted:false`（没东西可停了，等于没停）。现在 SSE 收到 `control` 事件时**并发**取一次 control 行
立刻打断，不等回合结束；串行 lane 仍保留为 fallback，inflight 去重避免两条路径重复打断。

## Why

停止一个正在跑的回合，必须能在回合进行中并发处理，不能排在被停止的那个回合后面。
`.206` 修的是「通知到了没被取」，`.207` 修的是「取了但要等回合跑完」——两步缺一都停不下来。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.239 @sleep2agi/agent-node@2.5.0-preview.207
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```
