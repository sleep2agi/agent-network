# anet V2 迭代计划

> 日期：2026-04-10 | 团队：SDK马 + 通信牛 + N站牛 + N站马 + 通信龙

## 当前稳定版本（生产锁定）

| 包 | 版本 |
|---|------|
| anet | 1.3.3 |
| agent-node | 2.0.0 |
| commhub-server | 0.4.4 |

## 迭代节奏

- 一个功能一个功能来
- 做完 → 写测试 → 9210 自测 → review → 发版
- 不并行不跳步

## Sprint 1：止血 + 基础稳定（本周）

### 1.1 codex agent "安静等待"优化
- **问题**：codex 没任务时一直发"等待任务"消息
- **改动**：优化 developer_instructions + 出站过滤"等待"类消息
- **负责**：SDK马
- **测试**：启动 codex agent → 发 1 条 task → 回复后等 2 分钟 → 不应有新消息
- **验收**：0 条垃圾消息

### 1.2 ensureMcpJson node-server.js 路径修复
- **问题**：anet start 后 .anet/node-server.js 没复制成功
- **改动**：修复路径查找 + npm root -g fallback
- **负责**：通信龙
- **测试**：新目录 anet create + anet start → .anet/node-server.js 存在
- **验收**：文件存在且可运行

### 1.3 anet upgrade self-upgrade 修复
- **问题**：anet upgrade 在自己进程里更新自己，可能导致 anet 命令消失
- **改动**：改成提示用户手动装，或 fork 外部脚本
- **负责**：通信牛
- **测试**：anet upgrade → anet -v 仍可用
- **验收**：升级后命令不丢失

## Sprint 2：消息协议 P0（下周）

### 2.1 消息类型字段
- **改动**：CommHub inbox 表加 type 字段（task/reply/message/ack）
- **负责**：SDK马
- **测试**：send_task → type=task，send_message → type=message
- **验收**：inbox 消息有正确 type

### 2.2 send_reply 工具
- **改动**：CommHub server 新增 send_reply MCP 工具，带 in_reply_to 字段
- **负责**：SDK马
- **测试**：agent 收到 task → 用 send_reply 回复 → 原 task 关联 reply
- **验收**：reply 关联到原始 task

### 2.3 agent-node 用 send_reply 回复
- **改动**：agent-node sendReply 从 send_message 改成 send_reply
- **负责**：SDK马
- **测试**：task → reply 链路完整
- **验收**：CommHub 能看到 task-reply 关联

### 2.4 scope=single|broadcast
- **改动**：broadcast 从消息类型降级为 scope 字段
- **负责**：SDK马
- **测试**：broadcast task → 每个 agent 收到的 type=task，scope=broadcast
- **验收**：type 和 scope 分离

## Sprint 3：Node 生命周期 P0

### 3.1 node_id 生成
- **改动**：anet create 自动生成 node_id（n_ + 8hex）
- **负责**：通信牛
- **测试**：anet create → config.json 有 node_id
- **验收**：新 node 有 node_id，旧 node 启动时自动补

### 3.2 name → node_name
- **改动**：config.json 字段从 name 改为 node_name
- **负责**：通信牛
- **测试**：anet create → config.json 有 node_name
- **验收**：兼容读取旧字段 name/alias

### 3.3 session → 统一字段
- **改动**：废弃 resume/resumeAlias/sessionId，统一用 session
- **负责**：通信牛
- **测试**：旧 config 有 resume → 读取为 session
- **验收**：所有启动路径用 session 字段

### 3.4 anet rename
- **改动**：anet rename 老名字 新名字（P0 只改本地 config）
- **负责**：通信牛
- **测试**：rename → config.json node_name 变了 + 下次 start 用新名字注册
- **验收**：改名后启动正常

## Sprint 4：Dashboard P0

### 4.1 导航重构
- **改动**：Overview / Nodes / Tasks / Messages / Settings
- **负责**：N站牛 + N站马
- **测试**：5 个一级页面都能访问
- **验收**：导航清晰，页面加载正常

### 4.2 Nodes 列表页
- **改动**：所有 agent 列表 + 状态 + 操作
- **负责**：N站牛
- **测试**：显示所有在线/离线 agent
- **验收**：和 anet ls 数据一致

### 4.3 Tasks 中心
- **改动**：任务列表 + 状态 + task-reply 关联
- **负责**：N站牛
- **测试**：发 task → Dashboard 能看到 + reply
- **验收**：任务链路可追踪

### 4.4 Messages 查看
- **改动**：消息流 + 按 type 过滤
- **负责**：N站马
- **测试**：按 task/reply/message 过滤
- **验收**：过滤正确

## Sprint 5：用户系统 P1

### 5.1 JWT 登录
- **改动**：Dashboard 多用户认证
- **负责**：N站马
- **验收**：登录/登出正常

### 5.2 Project 归属
- **改动**：Node 属于 Project，不直接属于个人
- **负责**：SDK马
- **验收**：不同 project 的 node 隔离

## 规范

### 发版前必做
1. 写测试用例
2. 9210 环境自测
3. 互相 review
4. 测试报告发给指挥室
5. 确认后发版

### 版本号
- P0 完成后核心包升 major（anet 2.0.0 + agent-node 3.0.0）
- Sprint 内的修复用 patch 版本

### 测试环境
- CommHub：9210 端口
- 不动生产 9200
