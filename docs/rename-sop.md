# Session 改名 SOP

## 改名需要做的 5 件事

### 1. 改 DB（立即生效，Dashboard 刷新可见）
```bash
cd ~/agent-orchestra/server && bun -e "
const { Database } = require('bun:sqlite');
const db = new Database(process.env.HOME + '/.commhub/commhub.db');
db.run(\"UPDATE sessions SET alias='新名字' WHERE alias='旧名字'\");
"
```

### 2. 改 .env（下次重启生效）
```bash
# 本地项目
echo 'COMMHUB_ALIAS=新名字' > ~/.claude/channels/commhub/{项目路径}/.env

# 远程服务器（Mac Mini / 96GB / Paper）
ssh server 'echo "COMMHUB_ALIAS=新名字" > ~/.claude/channels/commhub/{项目路径}/.env'
```

### 3. 重启 session（让 SSE 注册新 alias）
```bash
# Claude Code
tmux kill-session -t xxx
tmux new-session -d -s xxx -c ~/project
tmux send-keys -t xxx "COMMHUB_ALIAS=新名字 claude --dangerously-skip-permissions --dangerously-load-development-channels server:commhub ..." Enter
# 过 development channel 确认弹窗
sleep 8 && tmux send-keys -t xxx "1" Enter && sleep 2 && tmux send-keys -t xxx Enter

# Codex
tmux send-keys -t xxx "COMMHUB_URL=http://IP:9200 COMMHUB_ALIAS=新名字 codex --dangerously-bypass-approvals-and-sandbox ..." Enter
```

### 4. 重启 SSE Poller（MiniMax/Codex 专用）
```bash
pkill -f "commhub-sse-poller.*旧名字"
nohup ./poller/commhub-sse-poller.sh --alias 新名字 --tmux tmux名 --url http://IP:9200 &
```

### 5. 双向通信测试
```
指挥室 → send_task(alias="新名字", task="通信测试")
新名字 → commhub_send_task(alias="指挥室", task="确认")
```

## 注意事项

- DB 改了但不重启 → Dashboard 显示新名字，但 SSE 推送用旧名字 → 收不到消息
- 同项目目录多 session → 用 COMMHUB_ALIAS 环境变量区分
- 重启前确认启动命令正确（Telegram/resume/commhub 参数）
- 清理 DB 旧记录：`DELETE FROM sessions WHERE alias='旧名字'`
- 改名后 SSE Poller 也要重启（用新 alias）

## 命名规范

马🐴 = Claude Code
牛🐂 = Codex
猫🐱 = MiniMax

格式：站点 + 角色 + 动物
例：A站运营马 / B站开发牛 / P站运维牛 / 大猫
