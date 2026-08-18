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
- Dashboard：**分三种,别混**(这一层最容易判断错,见 `deploy/tunnel/README.md` 顶部的红字警告)
  1. **项目自营的生产实例**(权威):`公网 ─ Caddy :3000 / frpc :3100 → 127.0.0.1:3001`
     (Next.js,pm2 托管)。拓扑与运维见 `deploy/dashboard/README.md`、`deploy/tunnel/README.md`。
     **要判断「Dashboard 正不正常」,看这个。**
     ⚠️ 但**仓里查不到它的实际地址** —— `deploy/tunnel/caddy.example` 是 `${PUBLIC_DOMAIN}`、
     `frpc.example.toml` 是 `${FRP_SERVER_ADDR}`,都是占位符(仓库政策不写死真实域名)。
     **在部署机上按权威来源查,不要猜、也不要退回那个 Vercel 页:**
     ```bash
     # ⚠ 必须看 status,不能只看名字:停掉/崩掉的应用照样留在 pm2 jlist 里
     pm2 jlist | python3 -c "import json,sys;[print(a['name'],a['pm2_env']['status'],'restarts='+str(a['pm2_env'].get('restart_time',0))) for a in json.load(sys.stdin)]"
     # online 之外,还要看「本次已连续运行多久」—— 重启次数没有时间跨度判断不了任何事
     curl -s http://127.0.0.1:2019/config/apps/http/servers                                       # Caddy admin:实际路由(权威)
     curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001                              # 直连上游,绕开入口层
     ```
     不在部署机上时:**不要凭猜测下结论**,找该机器的负责人要地址。
  2. **自己起的**:`anet hub dashboard`。默认走 `npx @sleep2agi/agent-network-dashboard@<tag>`;
     但 `ANET_DASHBOARD_LOCAL=1` 时改为直接 spawn 全局二进制(`agent-network/bin/cli.ts` 的
     `globalOptIn` 分支)—— **诊断"装的是哪一份"之前先看这个变量**,否则会去查错的产物。
     见 `docs-site/docs/guide/dashboard.md`。绑定地址取 `--ip` → `--host` → `$HOSTNAME` → `127.0.0.1`
     (`agent-network/bin/cli.ts` 的 `dashHost`)。**容器里 `HOSTNAME` 通常有值,会绑到容器主机名而不是回环**
     —— 这是记录在案的发版门坑(`docs/tests/release-gate-playbook.md`「dashboard binds to hostname not 0.0.0.0」)。
     所以别假设任何默认地址,判断前先看 `dashHost` 实际取到什么。
  3. **没有面向外部用户的 SaaS 产品 URL。**
  ⚠️ `agent-network-dashboard.vercel.app` 不属于以上任何一种,别拿它判断线上状态。
  它在 `docs/rfcs/RFC-022` 里被当作现存部署引用,而该 RFC 与其原型自 2026-06-11 起无功能推进(见 #220)。
  实测只有一条:2026-08-13 取到它的 HTTP `Age` ≈ 61 天(**这是缓存年龄,不等于部署年龄**,
  要判断是否停更需查 Vercel 部署记录或产物里的 build id)。
- npm 包：@sleep2agi/agent-network / @sleep2agi/agent-node / @sleep2agi/commhub-server
