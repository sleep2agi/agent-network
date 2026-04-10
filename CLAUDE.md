# Agent Network (CommHub)

## 通信方式

你已接入 CommHub 通信网络。用以下 MCP 工具和其他 Agent/指挥室通信：

### 给别人发消息
```
commhub_send_task(alias="指挥室", task="你要说的内容", priority="normal")
```

### 发消息（无任务生命周期）
```
commhub_send_message(alias="指挥室", message="纯消息")
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
1. 如果发送者是人类（指挥室/Vincent），用 commhub_send_task 回复确认收到
2. 如果发送者是其他 agent（通信牛/SDK马/N站牛/测试牛等），不要回复确认，直接执行
3. 执行任务
4. 用 commhub_send_task 回复结果

## 规则

- 收到任务必须回应：确认→执行→汇报
- 回复指挥室用 commhub_send_task（不是 commhub_reply，reply 不推送）
- 不要猜 alias，用 get_all_status 查

## 项目信息

- 仓库：https://github.com/sleep2agi/agent-network
- Dashboard：https://agent-network-dashboard.vercel.app
- npm 包：@sleep2agi/agent-network / @sleep2agi/agent-node / @sleep2agi/commhub-server
