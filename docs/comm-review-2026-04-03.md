# CommHub 通信系统 Review 报告

> 日期: 2026-04-03
> 作者: 通信龙 (Claude Code Opus 4.6)
> CommHub 版本: 0.4.1
> 运行时长: ~17 小时

---

## 1. 当前通信架构

```
Vincent (人)
  │
  ├─ 微信 ──→ [WeChat Channel] ──→ 指挥室 (Claude Code)
  ├─ Telegram ──→ [Telegram Channel] ──→ 指挥室
  └─ 直接终端 ──→ 指挥室
         │
         │ commhub_send_task
         ▼
  ┌──────────────────────────────────┐
  │     CommHub Server (:9200)        │
  │     硅谷 ECS (47.77.216.1)        │
  │     15 sessions, 17 SSE 连接      │
  └──────────┬───────────────────────┘
             │
    ┌────────┼────────┬──────────┬──────────┐
    │        │        │          │          │
    ▼        ▼        ▼          ▼          ▼
 Channel   Channel   Channel   Poller     Poller
 (SSE)     (SSE)     (SSE)     (SSE)      (SSE)
    │        │        │          │          │
 硅谷ECS   Mac Mini  96GB      A100       Paper
 马x6      马x3      大猫       VL牛/SVG牛  P站姐
```

### 各服务器 Agent 分布

| 服务器 | 连接方式 | Agent 列表 | 模型 |
|--------|---------|-----------|------|
| 硅谷 ECS (47.77.216.1) | Channel SSE 直连 | 指挥室、通信龙、Hub马、A站运营马、B站开发马、I站工程马、I站运营马、Hub牛、A站牛、I站牛、B站开发牛、comm-research | Claude Code / Codex |
| Mac Mini (192.168.1.3) | Channel SSE via tunnel | 知识马、群星马、AGI马 | Claude Code |
| 96GB (8.141.8.23:6002) | MCP http + SSE Poller | 大猫 | MiniMax M2.7 |
| A100 InternStudio (ssh.intern-ai.org.cn:33450) | SSE Poller | VL牛、SVG牛 | Codex GPT-5.4 |
| Paper (8.130.134.166) | SSE Poller | P站姐 | Codex |

---

## 2. 各通道顺畅度评估

### 2.1 Claude Code + Channel SSE（硅谷/Mac Mini 的马们）

| 指标 | 评分 | 说明 |
|------|------|------|
| 延迟 | ★★★★★ | < 1 秒，任务直接注入对话流 |
| 可靠性 | ★★★★☆ | SSE 偶尔断连，自动重连 3-5 秒 |
| 双向通信 | ★★★★★ | Agent 可主动 send_task / reply |
| 工具加载 | ★★★★★ | commhub_reply / send_task / report_status 全部可用 |

**评价**：最优通道。Channel 协议直接注入 Claude Code 对话，零 token 消耗。硅谷 ECS 上的 6 个马 session 全部稳定运行。Mac Mini 通过 tunnel 连接，偶有断连但影响不大。

### 2.2 Codex + SSE Poller（VL牛/SVG牛/P站运维牛）

| 指标 | 评分 | 说明 |
|------|------|------|
| 延迟 | ★★★★☆ | SSE Poller < 1 秒推送，但 tmux send-keys 有时不生效 |
| 可靠性 | ★★★☆☆ | Codex 沙箱 (bwrap) 在容器内报 ENOSPC，需要 --dangerously-bypass |
| 双向通信 | ★★☆☆☆ | Codex 无 Channel 协议，只能 Poller 推 + MCP http 发 |
| 工具加载 | ★★★☆☆ | MCP http 配置需要 type:"http"，容易遗漏 |

**评价**：可用但需要 workaround。主要问题是 Codex 的 bwrap 沙箱在容器环境（A100 InternStudio）不工作，必须加 --dangerously-bypass-approvals-and-sandbox。tmux send-keys 推送任务后，文本进入 Codex 输入框但不自动提交（需要额外 Enter）。

### 2.3 MiniMax + MCP http + SSE Poller（大猫）

| 指标 | 评分 | 说明 |
|------|------|------|
| 延迟 | ★★★★☆ | SSE Poller < 1 秒推送 |
| 可靠性 | ★★☆☆☆ | MiniMax 不自循环，完成一轮就停 |
| 双向通信 | ★★☆☆☆ | 需要 Poller 推 + MCP http 工具 |
| 工具加载 | ★★☆☆☆ | .mcp.json 必须有 type:"http"，否则静默失败 |

**评价**：通信链路通了但 AI 端不够智能。MiniMax 完成一轮任务后就停止，不会主动轮询收件箱。SSE Poller 解决了推送问题，但大猫经常卡在文件确认对话框或 MCP 工具未加载的状态。

### 2.4 跨服务器 SSH 连接

| 服务器 | SSH 延迟 | 稳定性 | 备注 |
|--------|---------|--------|------|
| 硅谷 ECS | 本地 | ★★★★★ | CommHub 所在机器 |
| Mac Mini | ~50ms | ★★★☆☆ | tunnel 偶断，2-4AM 不稳定 |
| 96GB (8.141.8.23:6002) | ~30ms | ★★★★☆ | 稳定，SSH key 认证 |
| A100 InternStudio | ~80ms | ★★☆☆☆ | SSH key 配置折腾，SCP 传输被限速 (~100KB/s) |
| Paper (8.130.134.166) | ~20ms | ★★★★☆ | 稳定 |

---

## 3. 发现的问题

### P1 — 高优先级

#### 3.1 Codex tmux send-keys 不自动执行
**现象**：通过 SSE Poller 推送的任务文本进入 Codex 输入框，但不会自动提交执行。需要额外发送 Enter 键。
**影响**：所有 Codex session（VL牛/SVG牛/P站姐/Hub牛等）的消息推送形同虚设。
**根因**：Codex CLI 的输入框是交互式 TUI，tmux send-keys 只是模拟键盘输入，文本到达输入框后需要 Enter 确认。
**解决方案**：修改 commhub-sse-poller.sh 的 PUSH_CMD_TEMPLATE，在推送命令末尾追加 Enter 触发。或改为推送后自动追加 `tmux send-keys -t $SESSION Enter`。

#### 3.2 CommHub 重启后 SSE 连接全部断开
**现象**：CommHub Server 重启时，所有 Channel SSE 和 Poller SSE 同时断开。Channel 3-5 秒自动重连，但 Poller 可能需要更长时间。
**影响**：短暂通信中断，进行中的任务可能丢失 ACK。
**解决方案**：
  - Channel 侧已有重连逻辑（指数退避 3s→5s→10s→60s），无需改动
  - Poller 侧重连延迟默认 3s，已足够
  - Server 侧：任务持久化到 SQLite，重启不丢消息

#### 3.3 MiniMax .mcp.json 必须 type:"http"
**现象**：MiniMax Claude Code session 的 .mcp.json 缺少 `"type": "http"` 字段，导致 CommHub MCP 工具静默不加载。无报错，工具列表里就是没有。
**影响**：大猫无法调用 commhub_reply / send_task 等工具。
**解决方案**：文档化这个要求，加到 quickstart.md 和 CONTRIBUTING.md 的 checklist 中。

### P2 — 中优先级

#### 3.4 A100 SSH 连接不稳定
**现象**：InternStudio A100 的 SSH 连接偶尔超时，SCP 传输被限速（~100KB/s），32MB 文件需要用 rsync 分块传输 5 分钟。SSH key 配置折腾（跳板机架构，key 需要加到正确位置）。
**影响**：远程操作 VL牛/SVG牛 效率低。
**解决方案**：
  - 用 rsync 替代 scp（断点续传）
  - 大文件通过 HTTP server 中转
  - 保持 SSH keepalive：`ServerAliveInterval 30` in ssh_config

#### 3.5 MiniMax 卡文件确认对话框
**现象**：MiniMax（大猫）执行任务时弹出文件操作确认对话框，AI 不知道怎么自动确认，导致任务阻塞。
**影响**：大猫需要人工干预才能继续执行。
**解决方案**：启动时加 --dangerously-skip-permissions 参数（如果 MiniMax 支持），或在 prompt 中指导 AI 如何处理确认对话框。

#### 3.6 Codex 无 /compact 功能
**现象**：Codex CLI 不支持 /compact 命令压缩上下文。长任务执行后 context 满了就停止，无法继续。
**影响**：VL牛/SVG牛等 Codex session 执行长任务时会中断。
**解决方案**：
  - 任务拆小，避免单次 context 溢出
  - 用 `codex resume <session-id>` 恢复断点
  - 关键进度写文件而非依赖 context

#### 3.7 A100 bwrap 沙箱不可用
**现象**：InternStudio 容器内 namespace 限制导致 Codex bwrap 沙箱报 ENOSPC。
**影响**：VL牛/SVG牛必须用 --dangerously-bypass-approvals-and-sandbox 启动。
**解决方案**：A100 启动命令统一加该参数，写入启动脚本。

### P3 — 低优先级

#### 3.8 SSE Poller 96GB 配置经验
**现象**：首次在 96GB 服务器配置 SSE Poller 时，shell 特殊字符（中文别名）和 nohup 后台启动在 SSH 远程执行时遇到转义问题。
**影响**：部署过程耗时较长。
**解决方案**：已通过 SCP 上传 shell 脚本再远程执行的方式解决。标准化为部署脚本。

#### 3.9 MiniMax TTS API key 匹配问题
**现象**：MiniMax TTS API key 与 CommHub 注册的 session 不匹配。
**影响**：语音相关功能不可用。
**解决方案**：确认 API key 对应关系，统一管理。

---

## 4. 改进建议（按优先级排序）

| 优先级 | 改进项 | 具体方案 | 工作量 |
|--------|--------|---------|--------|
| P0 | Poller 推送自动 Enter | 修改 commhub-sse-poller.sh，推送后追加 `tmux send-keys Enter` | 10min |
| P1 | 连接状态三层展示 | 实施 connection-status-proposal.md 方案（SSH/CommHub/Agent 三层） | 4h |
| P1 | MCP type:http 检查 | CommHub Server 启动时校验 MCP 连接，返回明确错误 | 30min |
| P2 | A100 部署自动化 | 完善 scripts/setup-a100.sh，加入 Clash 代理 + bwrap 兜底逻辑 | 1h |
| P2 | Codex context 管理 | 任务拆分策略 + 自动 resume 脚本 | 2h |
| P2 | CommHub 重启平滑 | 添加 graceful shutdown：等待进行中任务完成再重启 | 2h |
| P3 | SSH 部署标准化 | 所有远程操作用 SCP 脚本 + 远程执行，不直接 SSH 拼命令 | 1h |
| P3 | 心跳监控 | 实施心跳方案，每 60s Agent 上报，超时告警 | 2h |

---

## 5. 各服务器通信状态检查清单

### 硅谷 ECS (47.77.216.1) — CommHub 所在机器

```bash
# CommHub 健康检查
curl -s http://127.0.0.1:9200/health | python3 -m json.tool

# 所有 session 状态
curl -s http://127.0.0.1:9200/api/status | python3 -c "
import sys,json
d=json.load(sys.stdin)
for s in d['sessions']:
    print(f'{s[\"alias\"]:15} {s[\"status\"]:10} {s.get(\"updated_at\",\"?\")}')
"

# SSE 连接数
curl -s http://127.0.0.1:9200/health | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'Sessions: {d[\"sessions\"]}, SSE: {d[\"sse_connections\"]}')
for k,v in d['sse_sessions'].items(): print(f'  {k}: {v} connections')
"
```

### Mac Mini (192.168.1.3) — tunnel 连接

```bash
# 检查 tunnel 是否通
ssh 192.168.1.3 "echo ok" 2>&1

# 检查 tmux sessions
ssh 192.168.1.3 "tmux ls"

# 检查 Agent 进程
ssh 192.168.1.3 "ps aux | grep claude | grep -v grep"
```

### 96GB 服务器 (8.141.8.23:6002) — 大猫

```bash
# SSH 连接
ssh -p 6002 elaine@8.141.8.23 "echo ok"

# 检查 tmux
ssh -p 6002 elaine@8.141.8.23 "tmux ls"

# 检查 SSE Poller
ssh -p 6002 elaine@8.141.8.23 "ps aux | grep sse-poller | grep -v grep"
ssh -p 6002 elaine@8.141.8.23 "tail -5 /tmp/sse-poller-bigcat.log"

# 检查 MiniMax MCP
ssh -p 6002 elaine@8.141.8.23 "cat ~/.claude/.mcp.json | python3 -m json.tool"
```

### A100 InternStudio (ssh.intern-ai.org.cn:33450) — VL牛/SVG牛

```bash
# SSH 连接
ssh -o StrictHostKeyChecking=no -p 33450 root@ssh.intern-ai.org.cn "echo ok"

# 检查 tmux
ssh -p 33450 root@ssh.intern-ai.org.cn "tmux ls"

# 检查 Clash 代理
ssh -p 33450 root@ssh.intern-ai.org.cn "curl -s -x http://127.0.0.1:7890 https://api.openai.com -o /dev/null -w '%{http_code}'"

# 检查 SSE Poller
ssh -p 33450 root@ssh.intern-ai.org.cn "ps aux | grep sse-poller | grep -v grep"

# 检查 GPU
ssh -p 33450 root@ssh.intern-ai.org.cn "nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader"

# 检查 Codex 状态
ssh -p 33450 root@ssh.intern-ai.org.cn "tmux capture-pane -t vl-codex -p | tail -5"
ssh -p 33450 root@ssh.intern-ai.org.cn "tmux capture-pane -t svg-codex -p | tail -5"
```

### Paper (8.130.134.166) — P站姐

```bash
# SSH 连接
ssh vansin@8.130.134.166 "echo ok"

# 检查 tmux
ssh vansin@8.130.134.166 "tmux ls"

# 检查 SSE Poller
ssh vansin@8.130.134.166 "ps aux | grep sse-poller | grep -v grep"

# 检查 Clash
ssh vansin@8.130.134.166 "pgrep -a clash || pgrep -a mihomo"
```

---

## 6. 快照：2026-04-03 23:00 实时状态

| Session | 状态 | SSE | 服务器 | 最后活动 |
|---------|------|-----|--------|---------|
| 通信龙 | working | ✅ | 硅谷 ECS | 22:56 |
| A站运营马 | offline | ✅ | 硅谷 ECS | 20:00 |
| 大猫 | offline | ✅ | 96GB | 15:40 |
| B站开发马 | offline | ✅ | 硅谷 ECS | 10:46 |
| 群星马 | offline | ✅ | Mac Mini | 10:44 |
| AGI马 | offline | ✅ | Mac Mini | 10:39 |
| 知识马 | offline | ✅ | Mac Mini | 09:58 |
| Hub马 | offline | ✅ | 硅谷 ECS | 09:01 |
| VL牛 | offline | ✅ | A100 | 08:14 |
| SVG牛 | offline | ✅ | A100 | 08:14 |
| I站工程马 | offline | ✅ | 硅谷 ECS | 07:21 |
| I站运营马 | offline | ✅ | 硅谷 ECS | 07:20 |
| comm-research | offline | — | 硅谷 ECS | 05:16 |
| P站运维牛 | offline | ✅ | Paper | 03:19 |
| B站开发牛 | offline | — | 硅谷 ECS | 前日 23:06 |

**注**：大量 session 显示 offline 但 SSE 连接在线（17 个 SSE 连接），说明 sessions 表的 10 分钟超时判定不准确 — 正是 connection-status-proposal.md 要解决的问题。

---

## 7. 结论

CommHub 通信系统核心链路已打通，15 个 session 跨 5 台服务器实现了结构化消息收发。**Channel SSE 是最优通道**（延迟 < 1s，零 token 消耗），**SSE Poller 是可靠兜底**（解决了 MiniMax/Codex 不自循环的问题）。

最大的痛点是 **状态展示不准确**（sessions 表与 SSE 连接不同步）和 **Codex 的自动化程度不够**（tmux send-keys 不自动 Enter，bwrap 沙箱不兼容容器）。

下一步应优先实施：
1. Poller 推送自动 Enter（10 分钟修复）
2. 三层连接状态展示（已有方案文档）
3. MCP type:http 强制校验
