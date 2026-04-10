# CommHub 现状 Review

> 状态：定稿 | 日期：2026-04-10 | 作者：SDK马 + 通信牛 review
> 数据快照时间：2026-04-10 06:54 UTC（~/.commhub/commhub.db, 2.5MB）

---

## 1. 数据库情况

### 表结构

```sql
-- 3 张表
sessions    -- 54 rows (agent 注册信息)
inbox       -- 2596 rows (消息队列)
completions -- 901 rows (任务完成记录)
```

### sessions 表

| 字段 | 类型 | 说明 |
|------|------|------|
| resume_id | TEXT PK | 唯一标识 |
| alias | TEXT UNIQUE | 显示名 / CommHub 别名 |
| tmux_name | TEXT | tmux session 名 |
| server | TEXT | 机器名/hostname |
| ip | TEXT | IP |
| hostname | TEXT | hostname |
| agent | TEXT | 类型：claude-code / agent-node:claude / agent-node:codex / codex-sdk |
| project_dir | TEXT | 工作目录 |
| version | TEXT | 版本（未使用） |
| status | TEXT | offline / idle / working / blocked / error |
| task | TEXT | 当前任务描述 |
| output | TEXT | 最近输出 |
| progress | INTEGER | 进度 0-100 |
| score | REAL | 评分 |
| registered_at | TEXT | 注册时间 |
| updated_at | TEXT | 最后更新时间 |

### inbox 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 消息 ID |
| session_name | TEXT | 目标 session alias |
| type | TEXT | task / message |
| priority | TEXT | high / normal / low |
| content | TEXT | 消息内容 |
| context | TEXT | 上下文（未使用） |
| from_session | TEXT | 发送者 alias |
| acked | INTEGER | 是否已确认 |
| created_at | TEXT | 创建时间 |

### completions 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 完成 ID |
| session_name | TEXT | session alias |
| task | TEXT | 任务 ID |
| result | TEXT | 结果文本 |
| artifacts | TEXT | 附件（未使用） |
| score | REAL | 评分 |
| duration_minutes | REAL | 耗时 |
| completed_at | TEXT | 完成时间 |

## 2. 脏数据分析

### 统计

| 问题 | 数量 | 严重程度 |
|------|------|---------|
| 重复 alias | 0 | ✅ |
| alias 为空 | 0 | ✅ |
| project_dir 为空 | 9/54 (17%) | ⚠ 中 |
| agent 为空 | 7/54 (13%) | ⚠ 中 |
| server 为空 | 9/54 (17%) | ⚠ 中 |
| 未 ack inbox | 378/2596 (15%) | ⚠ 低 |
| 超 7 天未更新 | 1/54 | ✅ |

### 缺字段的 session（9 个）

| alias | agent | server | 原因 |
|-------|-------|--------|------|
| P站MiniMax马 | null | null | 旧版注册，未上报完整信息 |
| B站开发马 | null | null | 同上 |
| SDK测试马 | null | null | 临时测试 |
| 书小生33号 | null | null | 批量实验残留 |
| Codex马 | codex-sdk | null | 缺 server |
| 测试马 | null | null | 临时测试 |
| 通信牛 | null | null | MCP 客户端注册不完整 |
| 通信龙 | null | null | 同上 |

**建议**: 清理临时测试 session（SDK测试马、测试马、书小生*）。通信龙/通信牛的 session 需要补充 agent/server 字段。

### 未 ack inbox（378 条）

| session | 未读 | 原因 |
|---------|------|------|
| Dashboard | 58 | 无 agent 消费 |
| hub | 35 | 系统消息无人 ack |
| SDK测试tsx | 25 | 临时测试 agent 已下线 |
| SDK一号 | 23 | agent 离线后堆积 |
| 书小生14号 | 23 | 实验结束未清理 |

**建议**: 加自动清理——超过 7 天未 ack 的消息自动标记 expired。

## 3. API 接口 Review

### MCP 工具（10 个）

| 工具 | 说明 | 评价 |
|------|------|------|
| report_status | 注册/状态上报 | ✅ 核心，但字段太多可选 |
| report_completion | 完成回报 | ✅ |
| get_inbox | 拉取消息 | ✅ |
| ack_inbox | 确认消息 | ✅ |
| get_all_status | 获取所有 session | ✅ |
| get_session_status | 获取单个 session | ✅ |
| send_task | 发送任务 | ✅ |
| send_message | 发送消息（无任务生命周期） | ⚠ 和 send_task 区别不明显 |
| broadcast | 广播 | ✅ |
| get_completions | 获取完成记录 | ✅ |

### REST 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| /mcp | POST | MCP Streamable HTTP |
| /events/:alias | GET | SSE 推送 |
| /health | GET | 健康检查 |
| /api/status | GET | 所有 session 状态 |
| /api/task | POST | 发送任务（REST） |
| /api/completions | GET | 完成记录 |
| /api/tmux/:name | GET | tmux 输出 |
| /api/tmux/:name/send | POST | tmux 按键 |

### 问题

**数据完整性分层**:

| 层级 | 字段 | 说明 |
|------|------|------|
| 必须 | alias, status, resume_id | 核心标识和状态 |
| 建议 | agent, project_dir, server | restart-all 需要 |
| 辅助 | session_id, config_path, channels, tmux_name, version | 高级功能需要 |

**P1: 缺少字段**
- sessions 表没有 `session` 字段（Claude session ID / Codex thread ID）→ restart-all 无法 resume
- sessions 表没有 `config_path` 字段 → restart-all 无法定位 config.json
- sessions 表没有 `channels` 字段 → 不知道 agent 接了哪些 channel

**P2: 命名不一致**
- MCP 工具用下划线：`report_status`、`get_inbox`
- inbox 表 `session_name` 而不是 `alias`（应该统一）
- completions 表 `session_name` 同上

**P3: send_task vs send_message 区别模糊（待评估）**
- send_task 和 send_message 都往 inbox 写，区别只是 type 字段（task vs message）
- 实际使用中大家只用 send_task
- 待评估：是否合并为 send。合并需考虑向后兼容（保留旧工具名作 alias）

**P4: 无自动清理**
- offline session 永远留着
- 未 ack 消息永远堆积
- completions 无上限

## 4. 建议改进

### 数据库层

| # | 改进 | 优先级 |
|---|------|--------|
| 1 | sessions 加 `session_id` 字段（Claude/Codex session） | **P0** — restart-all 前置依赖 |
| 2 | sessions 加 `config_path` 字段 | **P0** — restart-all 前置依赖 |
| 3 | sessions 加 `channels` JSON 字段 | P2 |
| 4 | inbox 加 `expires_at` 字段，自动清理过期消息 | P2 |
| 5 | 清理临时测试 session（手动或加 TTL） | P1 |
| 6 | `session_name` 统一为 `alias`（需要 migration） | P3 |

### API 层

| # | 改进 | 优先级 |
|---|------|--------|
| 7 | report_status 上报 session_id + config_path | **P0** — 和上面字段配套 |
| 8 | 新增 DELETE /api/session/:alias 清理接口 | P2 |
| 9 | 新增 GET /api/session/:alias/inbox 查看单个 session inbox | P2 |
| 10 | inbox 自动过期（7 天未 ack → expired） | P2 |

### 运维层

| # | 改进 | 优先级 |
|---|------|--------|
| 11 | 定期清理脚本（清僵尸 session、过期 inbox） | P2 |
| 12 | 数据库备份 | P2 |
| 13 | 监控告警（inbox 堆积超阈值） | P3 |

---

**请通信牛 review。文件路径: ~/agent-orchestra/docs/commhub-review.md**
