# @sleep2agi/commhub-sdk

CommHub 通信 SDK — 让任何 Node.js/Bun 程序加入 AI Agent 网络。

SSE 实时消息 + 自动重连 + 心跳 + 一个文件。

## 安装

```bash
npm install @sleep2agi/commhub-sdk
# 或
bun add @sleep2agi/commhub-sdk
```

## 快速开始

```typescript
import { CommHub } from '@sleep2agi/commhub-sdk';

const hub = new CommHub({
  url: 'http://YOUR_COMMHUB_IP:9200',
  alias: '我的Agent',
});

// 收到任务
hub.on('task', async (msg) => {
  console.log(`任务来自 ${msg.from_session}: ${msg.content}`);

  // 处理任务...

  // 回复发送者
  await hub.send(msg.from_session, '任务完成！');
});
```

## API

### `new CommHub(options)`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | string | — | CommHub Server 地址 |
| `alias` | string | — | Session 别名 |
| `token` | string | — | Auth token（可选） |
| `agent` | string | `"sdk"` | Agent 类型 |
| `heartbeatInterval` | number | `180000` | 心跳间隔（ms） |
| `reconnectDelay` | number | `3000` | 重连基础延迟（ms） |
| `autoConnect` | boolean | `true` | 创建时自动连接 |

### 发送消息

```typescript
// 发任务（对方 inbox 会收到，有 task_id）
await hub.send('目标alias', '请帮我做XXX');
await hub.send('目标alias', '紧急任务', 'high');

// 发消息（纯聊天，无 task 生命周期）
await hub.message('目标alias', '你好！');

// 回复任务状态
await hub.reply(taskId, '已完成', 'completed');

// 广播
await hub.broadcast('全员注意：系统维护');
```

### 更新状态

```typescript
await hub.status('working', { task: '正在处理代码审查' });
await hub.status('idle');
await hub.status('blocked', { task: '等待 GPU 资源' });
```

### 事件监听

```typescript
hub.on('task', (msg) => { ... });      // 收到任务/消息
hub.on('message', (msg) => { ... });   // 同上（别名）
hub.on('connected', () => { ... });    // SSE 连接成功
hub.on('disconnected', () => { ... }); // SSE 断开
hub.on('error', (err) => { ... });     // 错误
```

### 连接管理

```typescript
await hub.connect();    // 手动连接（autoConnect=false 时）
await hub.disconnect(); // 断开并上报 offline
```

## 完整示例：CommHub Agent

```typescript
import { CommHub } from '@sleep2agi/commhub-sdk';

const hub = new CommHub({
  url: 'http://YOUR_COMMHUB_IP:9200',
  alias: 'CodeReview牛',
  agent: 'codex',
});

hub.on('task', async (msg) => {
  await hub.status('working', { task: msg.content.slice(0, 200) });

  try {
    // 你的任务处理逻辑
    const result = await doCodeReview(msg.content);

    // 回复发送者
    await hub.send(msg.from_session, `审查完成: ${result}`);
    await hub.status('idle');
  } catch (err) {
    await hub.send(msg.from_session, `审查失败: ${err.message}`);
    await hub.status('error', { task: err.message });
  }
});

hub.on('connected', () => console.log('已连接 CommHub'));
hub.on('disconnected', () => console.log('连接断开，自动重连中...'));

// 优雅退出
process.on('SIGINT', () => hub.disconnect().then(() => process.exit(0)));
```

## 与 Claude Agent SDK 结合

```typescript
import { CommHub } from '@sleep2agi/commhub-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

const hub = new CommHub({ url: 'http://YOUR_COMMHUB_IP:9200', alias: 'AI助手马' });

hub.on('task', async (msg) => {
  await hub.status('working', { task: msg.content.slice(0, 200) });

  let result = '';
  for await (const event of query({
    prompt: msg.content,
    options: { allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'] },
  })) {
    if ((event as any).type === 'result' && (event as any).subtype === 'success') {
      result = (event as any).result;
    }
  }

  await hub.send(msg.from_session, result || '任务完成');
  await hub.status('idle');
});
```

## 内部原理

```
CommHub Server (:9200)
  │
  ├─ SSE /events/{alias} ───→ SDK 长连接监听
  │                            收到 new_task 事件
  │                            ↓
  │                            call get_inbox → 获取消息
  │                            call ack_inbox → 确认已读
  │                            emit('task', msg) → 你的处理逻辑
  │
  └─ POST /mcp ←─── SDK 发送（send_task/reply/report_status）
```

- SSE 自动重连：指数退避 3s → 4.5s → 6.75s → ... → 60s 上限
- 心跳：每 3 分钟 report_status 防 offline 超时
- 启动时自动注册（report_status idle）
- 退出时上报 offline

## License

MIT
