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
- 回复指挥室/dashboard 要「对方立即收到」：commhub_reply **必须 status=completed（终态）** 才推送（→ send_reply → new_reply SSE → dashboard 聊天窗口实时显示），或用 commhub_send_task；**status=in_progress 等非终态走 report_status，不推、dashboard 收不到**（返回 ok 也白搭）。详见 [docs/agent-reply-to-dashboard.md](https://github.com/sleep2agi/agent-network/blob/main/docs/sop/agent-reply-to-dashboard.md)
- 不要猜 alias，用 get_all_status 查
- **send_ack / send_message / 非终态 reply 都不推送**（对方看不到，只写库）；要对方立刻看到一律 send_task 或终态 commhub_reply

## 测试规则

- **分层测试，从简单到复杂**：环境→认证→单点通信→完整流程→多用户→安全
- **前一层不过就不跑后面的**：被依赖的原子能力必须先验证可靠
- **所有测试在 Docker 里跑**：不碰本地环境，不改生产
- **不自己跑测试**：通信龙分配任务，测试1-3号执行，通信牛 review
- **不频繁发 preview**：本地源码开发，大版本完成时统一发 npm
- **测试结果保存**：docs/tests/report-testN.txt
- **每个测试套件独立 Dockerfile**：可并行构建和运行

## 项目信息

- 仓库：https://github.com/sleep2agi/agent-network
- Dashboard：**自托管,没有官方托管入口**。`anet hub dashboard` 拉起
  （CLI 走 `npx @sleep2agi/agent-network-dashboard@<tag>`,见 `docs-site/docs/guide/dashboard.md`）。
  **默认只绑回环**:绑定地址取 `--ip` → `--host` → `$HOSTNAME` → `127.0.0.1`
  （`agent-network/bin/cli.ts` 里 `dashHost` 一行)。所以默认情况下**别的机器连不上**,
  也别默认它是 `http://<服务器IP>:3000` —— 要远程访问得显式 `--ip 0.0.0.0` 或走反代。
  注意 `$HOSTNAME` 在链上:**实际绑到哪,随环境变**,判断前先看 `dashHost` 实际取值。
  ⚠️ `agent-network-dashboard.vercel.app` **不是产品形态** —— 它能打开、标题也对,
  但 CDN 缓存年龄约 61 天(2026-08-13 实测),即约两个月未重新部署。
  它在 `docs/rfcs/RFC-022` 里被当作现存部署引用,而该 RFC 与其原型自
  2026-06-11 起无功能推进(见 #220)。**别拿它判断「Dashboard 正常不正常」。**
- npm 包：@sleep2agi/agent-network / @sleep2agi/agent-node / @sleep2agi/commhub-server
