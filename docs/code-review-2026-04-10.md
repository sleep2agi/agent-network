# 代码仓库系统 Review

> 日期：2026-04-10 | 团队：SDK马 + 通信牛 + N站牛 + 通信龙

## 一、CommHub Server（通信牛 review）

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| 1 | 🔴 严重 | /mcp 接口无鉴权，任何人可调全部工具 | server/src/index.ts L95-109 |
| 2 | 🔴 高危 | tmux 远程控制暴露（send-keys + WebSocket） | server/src/index.ts L209,L231,L293 |
| 3 | 🔴 高危 | 先 ack 再执行，崩溃丢任务 | agent-node/src/cli.ts L502-526 |
| 4 | 🟡 中高 | 任务完成无法关联原 task（无 task_id 外键） | channel/commhub-channel.ts L237, server/src/db.ts L49 |
| 5 | 🟡 中高 | alias 互踢（同 alias 删旧 session） | server/src/tools.ts L37-40 |

## 二、agent-node（SDK马 review）

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| H1 | 🔴 | 单文件 764 行，无模块拆分 | agent-node/src/cli.ts |
| H2 | 🔴 | callCommHub 无错误处理/重试 | agent-node/src/cli.ts |
| H3 | 🔴 | think 失败后 lastReplyTime 仍设了 | L515 |
| H4 | 🔴 | Codex retry 缺完整 developer_instructions | L419 |
| M1 | 🟡 | 全局变量 ~30 个，难测试 | 全文件 |
| M2 | 🟡 | writebackSession 吞错误 | L177 |
| M3 | 🟡 | getInbox limit 写死 5 | L295 |
| M4 | 🟡 | Codex 实例 retry 重复 new | L360,L419 |
| M5 | 🟡 | Telegram drainQueue 不 await | L696 |
| M6 | 🟡 | 心跳间隔写死 3 分钟 | L759 |
| L1 | 🟢 | 中英文混合日志 | 全文件 |
| L2 | 🟢 | import 散落文件中间 | L243 |
| L3 | 🟢 | PKG_VERSION 硬编码 | L23 |

## 三、Dashboard（N站牛 review）

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| 1 | 🔴 高危 | 登录密码复用 CommHub token | dashboard-auth.ts L25,L31 |
| 2 | 🔴 高危 | 每 5 秒重复注册 CommHub | page.tsx L23,L43,L64 |
| 3 | 🔴 高危 | cookie 没 secure，等价长期 bearer | login/route.ts L18,L20 |
| 4 | 🟡 中高 | 登录无限流、无审计 | login/route.ts L8 |
| 5 | 🟡 中高 | API route 不检查 upstream res.ok | hub/session/route.ts L15 |

## 四、P0 紧急修复清单

按优先级排序，和 V2 Roadmap Sprint 1 对齐：

### 安全（本周必修）

1. CommHub /mcp 加鉴权（通信牛发现）
2. tmux 远程控制默认关闭或加二次授权
3. Dashboard 登录密码不复用 CommHub token
4. cookie 加 secure + httpOnly
5. 登录加限流

### 稳定性（本周修）

6. agent-node 先执行后 ack（不是先 ack 再执行）
7. callCommHub 加 retry
8. writebackSession 不吞错误
9. 每 5 秒重复注册改成只注册一次
10. getInbox limit 改 20

### 代码质量（Sprint 2）

11. agent-node 拆模块
12. 全局变量收敛
13. 日志统一
14. PKG_VERSION 从 package.json 读

## 五、和 V2 Roadmap 对齐

| 问题 | 对应 Sprint |
|------|------------|
| /mcp 鉴权 + tmux 控制 | Sprint 1（止血）|
| Dashboard 安全 | Sprint 1 |
| 先 ack 再执行 → 消息生命周期 | Sprint 2（消息协议）|
| task 关联 → tasks 表 | Sprint 2 |
| alias 互踢 → node_id | Sprint 3（Node 生命周期）|
| agent-node 拆模块 | Sprint 2-3 并行 |
| Dashboard 重构 | Sprint 4 |
