# Agent Orchestra V2 Roadmap

> 状态：草稿 | 日期：2026-04-10 | 作者：SDK马 初稿 + 通信牛补充

---

## 目标

V2 不是继续堆功能，而是把系统从“能跑”收敛到“可控、可观测、不会自激循环”的状态。

本版统一解决 5 个问题：

1. Node 生命周期不清晰，重启、恢复、删除、改名边界不统一
2. 消息没有严格类型，agent 之间会互发确认导致循环
3. CommHub Server 同时承担路由、状态、协议兼容，但接口语义还不稳定
4. Dashboard 目前更像调试页，不是运营控制台
5. 缺少用户登录和权限边界，节点、项目、消息都没有真正的归属模型

V2 的核心原则：

1. Node 是可恢复的长期实体，不是一次性 session 包装
2. 只有 `task` 能触发执行，其他消息类型都不能自动再次驱动 agent
3. Server 负责状态真相、协议约束和审计
4. CLI 负责本地体验和节点运维，不承载业务真相
5. Dashboard 负责可视化和人工介入，不直接绕过协议
6. 登录系统先解决“谁能看/谁能发/谁能管”，再谈协作

---

## V2 总体架构

```text
User / Dashboard / CLI
        │
        ▼
   CommHub Server
   - auth
   - session registry
   - inbox / outbox
   - SSE fanout
   - audit log
        │
        ▼
  agent-node / claude-code / codex runtime
        │
        ▼
   Local workspace + local session state
```

职责边界：

- CLI：创建、启动、停止、恢复、巡检 node
- CommHub Server：保存 session、消息、权限、事件日志
- Dashboard：查看网络、消息、节点、任务、用户
- Runtime：只消费允许消费的消息类型，按协议回包

---

## 一、Node 生命周期

参考已有 [node-lifecycle.md](../node-lifecycle.md)，V2 目标不是推翻，而是把本地状态、服务端状态和 UI 状态对齐。

### 1. 生命周期状态

```text
created
  -> registered
  -> online(idle)
  -> running(working)
  -> blocked
  -> online(idle)
  -> offline
  -> deleted
```

补充约束：

1. `created` 只存在于本地 config，Server 不可见
2. `registered` 是内部瞬时态，只为连接握手服务
3. `online/idle`、`running/working`、`blocked`、`offline` 是 Server 真相
4. `error` 不是独立生命周期终点，而是运行状态标签，可叠加在 `online` 或 `offline`
5. `deleted` 必须同时清理本地配置和服务端注册

### 2. Node 标识

V2 固化三层标识，避免名字和 session 混用：

1. `node_id`：稳定 ID，本地和服务端共用，不可变
2. `alias`：展示名，可变
3. `runtime_session_id`：具体运行时会话 ID，可变

规则：

- CLI 和 Dashboard 默认展示 `alias`
- 协议层关联统一用 `node_id`
- 恢复运行时优先用 `runtime_session_id`

### 3. CLI 行为补充

V2 下 `anet` 建议统一成 node 运维入口：

```bash
anet create <name>
anet start <name>
anet stop <name>
anet restart <name>
anet delete <name>
anet ls
anet inspect <name>
anet logs <name>
```

CLI 侧关键补充：

1. `anet ls` 同时显示 `local_state / server_state / runtime_session`
2. `anet inspect <name>` 输出完整视图：node_id、alias、status、last_seen、current_task、workspace、runtime
3. `anet start` 如果发现本地存在、服务端残留冲突，应提示是 `resume` 还是 `force-register`
4. `anet delete` 只能删除 offline node，且必须二次确认
5. `anet restart-all` 只恢复“本机 + offline + 可识别 runtime”的节点

### 4. Dashboard 行为补充

Dashboard 对 Node 要有两层视图：

1. 网络视图：谁在线、谁忙、谁失联
2. 节点详情页：配置、最近任务、最近错误、最近回复、重启入口

关键 UX：

- `offline` 和 `stale` 要区分
- `blocked` 要显示阻塞原因
- `running` 要显示关联 task
- 对 `error` 节点要给出最近一次错误摘要，而不是只显示红点

---

## 二、消息生命周期

参考已有 [message-lifecycle.md](../message-lifecycle.md)，V2 需要把“消息类型”和“任务状态”彻底分开。

### 1. 消息类型

| 类型 | 是否触发执行 | 是否需人工关注 | 是否可自动回发 |
|------|--------------|---------------|---------------|
| `task` | 是 | 是 | 允许，产出 `reply` |
| `reply` | 否 | 是 | 否 |
| `ack` | 否 | 否 | 否 |
| `message` | 否 | 视内容而定 | 否 |
| `broadcast` | 是 | 是 | 视策略而定 |

核心规则：

1. 只有 `task` 和受控 `broadcast` 触发执行
2. `reply` 只能结束或补充某个 task，不能再触发自动执行
3. `ack` 只更新投递状态，不进入 agent 思考链路
4. `message` 是信息性载体，不承担任务语义

### 2. 协议字段

V2 协议建议标准化为：

```json
{
  "message_id": "m_xxx",
  "type": "task",
  "from_node_id": "n_sender",
  "to_node_id": "n_target",
  "task_id": "t_xxx",
  "reply_to": null,
  "requires_response": "reply",
  "priority": "normal",
  "content": "...",
  "created_at": "2026-04-10T10:00:00Z",
  "dedupe_key": "optional"
}
```

字段语义：

1. `message_id`：消息唯一 ID
2. `task_id`：任务链路 ID；同一 task 的 reply/ack 共享该值
3. `reply_to`：指向上一条消息，一般 reply/ack 使用
4. `requires_response`：`none | ack | reply`
5. `dedupe_key`：幂等发送时可选

### 3. 任务状态机

消息和任务不要混为一个状态机。任务单独有状态：

```text
created -> delivered -> acked -> running -> replied -> closed
                         \-> timeout
                         \-> failed
```

规则：

1. `task` 创建时进入 `created`
2. 入目标 inbox 后进入 `delivered`
3. 若需要 `ack`，收到后进入 `acked`
4. 目标 node 开始执行后进入 `running`
5. 发送 `reply` 后进入 `replied`
6. 发送方确认完成后进入 `closed`

### 4. 防循环规则

这是 V2 必须落地的硬规则：

1. `ack` 永远不能响应 `ack`
2. `reply` 永远不能自动响应 `reply`
3. `message` 永远不能默认触发自动回复
4. Claude/Codex channel 注入时，必须带 `type`
5. Runtime prompt 明确写死：仅 `type=task` 进入执行流
6. 同一 `task_id` 只接受一个终态 `reply`；重复 reply 记审计日志

### 5. CLI / UX 补充

CLI 和 Dashboard 都不要再把所有收件箱内容都叫“任务”。

建议统一术语：

1. Tasks：需要执行的事项
2. Replies：执行结果
3. Messages：普通消息
4. Receipts：投递回执和 ack

对应 UX：

- `anet inbox` 默认只看 `task`
- `anet inbox --all` 看全部类型
- Dashboard 默认首页聚合 `task + running + failed`
- `reply` 应归到任务详情页，而不是冒充新任务

---

## 三、CommHub Server

V2 的 CommHub Server 要从“消息转发器”升级成“状态与协议中心”。

### 1. 服务端职责

1. session 注册和心跳
2. node 状态真相
3. 消息投递和路由
4. inbox / outbox / audit 持久化
5. SSE / WebSocket 推送
6. 用户认证和权限校验
7. Dashboard 查询接口

### 2. 数据模型

V2 最少拆成这些核心表：

1. `users`
2. `projects`
3. `project_members`
4. `nodes`
5. `sessions`
6. `messages`
7. `tasks`
8. `task_events`
9. `audit_logs`

关键关系：

- `nodes` 属于 `project`
- `sessions` 属于 `node`
- `messages` 属于 `project`，发送方和接收方是 node
- `tasks` 是跨消息链路实体
- `task_events` 记录投递、ack、开始、完成、失败

### 3. API 分层

建议把 API 分成 4 组：

1. Node API
   - register
   - heartbeat
   - report_status
   - unregister
2. Message API
   - send_task
   - send_reply
   - send_ack
   - send_message
3. Query API
   - list_nodes
   - get_node
   - list_tasks
   - get_task
   - list_messages
4. Auth API
   - login
   - logout
   - whoami
   - list_projects

### 4. 推送层

SSE 事件建议显式区分，避免客户端靠猜：

| event.type | 说明 | 谁关心 |
|-----------|------|-------|
| `new_task` | 新任务入箱 | runtime, dashboard |
| `task_updated` | task 状态变化 | dashboard, cli |
| `new_reply` | 收到回复 | dashboard, cli |
| `new_message` | 普通消息 | dashboard |
| `node_status_changed` | 节点状态变化 | dashboard, cli |
| `receipt` | ack / delivery 回执 | cli, dashboard |

原则：

1. Runtime 默认只监听 `new_task`
2. CLI 可以监听 `new_reply` 和 `node_status_changed`
3. Dashboard 监听全部

### 5. 向后兼容

V2 分阶段落地：

#### P0

1. 保持旧接口还能发 `task/message`
2. agent-node 先只消费 `new_task`
3. CLAUDE.md / system prompt 禁止对 `message` 自动回复

#### P1

1. Server 补齐 `reply/ack`
2. 数据表补齐 `task_id/reply_to/requires_response`
3. Dashboard 任务详情页上线

#### P2

1. 登录、项目、权限全部生效
2. CLI 改为登录态运行
3. Dashboard 支持按项目切换

---

## 四、Dashboard

V2 的 Dashboard 不该只是 SSE 调试台，而应该是“网络操作台”。

### 1. 当前 Dashboard 现状

当前仓库里的 Dashboard 已经具备一个可用原型，但本质上仍是“监控看板 + 运维调试页”：

1. 现有页面只有登录页、总览页、节点详情页
2. 首页主要展示在线节点、工作状态、拓扑图、Agent 卡片和 Dashboard inbox
3. 节点详情页支持查看基础状态、当前任务、最近输出，并可向单节点发 task
4. 已接入的后端能力以 CommHub 状态、消息、单发、广播为主

现有优点：

1. 实时感强，适合演示网络在线态势
2. 拓扑图辨识度高，有产品记忆点
3. 已具备广播和单节点派单能力

现有问题：

1. 页面层级太浅，没有真正的后台导航结构
2. 首页承担了列表、概览、控制台、消息区多种职责，信息过载
3. 没有统一的任务中心、消息中心、日志中心
4. 缺少搜索、筛选、批量操作、审计、权限这些后台基础能力

所以 V2 的目标不是继续堆首页，而是把它升级成真正可管理、可协作、可运营的后台系统。

### 2. 信息架构

建议收敛为 6 个一级页面：

1. Overview
2. Nodes
3. Tasks
4. Messages
5. Logs
6. Settings

补充原则：

1. Overview 负责全局态势，不承载所有明细
2. Nodes 负责节点管理和节点详情
3. Tasks 负责执行闭环，是主工作区
4. Messages 负责协议排障和原始消息检查
5. Logs 负责日志检索和异常定位
6. Settings 负责项目、成员、令牌、权限和服务配置

### 3. 页面职责

#### Overview

首页应该先回答“系统现在是否健康、哪里有风险、下一步该点哪里”。

建议展示：

- 在线节点数
- 运行中任务数
- 失败任务数
- timeout 任务数
- 最近异常节点
- 最近回复
- 今日广播与关键操作
- 快捷入口

首页不再把原始卡片列表作为唯一主体，而是把当前拓扑图降级为“亮点模块”，用于展示网络态势，而不是替代后台导航。

#### Nodes

节点列表 + 筛选：

- alias
- node_id
- project
- status
- runtime
- current_task
- last_seen
- error_summary

支持操作：

- 查看详情
- 标记维护
- 复制 node_id
- 跳到任务列表
- 查看最近日志

节点详情页建议增强：

- 基础配置
- 最近任务时间线
- 最近 reply / message
- 最近错误摘要
- 运行指标摘要
- 当前状态标签：online / running / blocked / offline / stale

#### Tasks

任务视图是 Dashboard 主工作区：

- 按状态筛选：pending / delivered / acked / running / replied / closed / failed / timeout
- 按发送方/接收方筛选
- 按 project / node / 时间范围筛选
- 查看 task timeline
- 看到关联 reply、ack、message
- 支持失败重试和重新派发

这里要明确：

1. Dashboard 以后不要把所有 inbox 内容都叫任务
2. reply 应挂在 task 之下
3. ack 只作为状态证据，不占主视觉

#### Messages

Messages 只做原始消息检查和排障，不抢 Tasks 的主入口地位。

建议支持：

- 按 type、from、to、task_id、时间范围搜索
- 查看广播历史
- 查看 delivery / ack / reply 链路
- 切换“调试模式”后显示完整协议字段

#### Logs

这是当前缺口最大的页面之一，V2 应补齐：

- 全局日志搜索
- 节点日志过滤
- 错误级别筛选
- 最近异常聚合
- 从 node / task / message 详情跳转日志

#### Settings

Settings 不只是配置页，还要承担多人协作基础设施：

- 项目切换
- 成员与角色
- API token / CLI token
- Dashboard 登录态
- CommHub 服务配置
- 审计日志入口

### 4. Dashboard 在 V2 的优先级

Dashboard 侧建议分 4 个阶段推进，避免只做视觉重构。

#### P0：先把看板升级成后台

最优先交付：

1. 导航重构
2. Overview 首页重做
3. Nodes 列表页
4. Tasks 页
5. Messages 页
6. 基础审计日志

原因：

1. 这是从“会展示”到“能管理”的分水岭
2. 也是后续日志、权限、协作能力的落点

#### P1：补齐运维闭环

1. Logs 页上线
2. 异常节点视图
3. timeout / failed task 高亮
4. 节点详情增强

原因：

1. 这部分决定用户会不会日常打开 Dashboard
2. 能直接提高排障效率

#### P2：补齐多人协作

1. project 切换
2. 用户与角色
3. 按权限显示操作入口
4. 广播模板、批量操作、收藏视图

#### P3：增强产品吸引力

1. 老板 / 运营视角概览
2. 只读分享模式
3. onboarding 和空状态设计
4. 更清晰的趋势图和数据故事化表达

### 5. UX 原则

1. 首页先给“状态”和“风险”，不要先给原始日志
2. 任务详情用 timeline，而不是平铺消息列表
3. 回复应挂在任务之下，不单独制造“未处理提醒”
4. `ack` 默认折叠，除非进入调试模式
5. 所有时间展示支持本地时区切换
6. 关键操作必须可追踪，发 task、广播、重试都要能看到结果闭环
7. 关键风险要可见，offline、stale、blocked、timeout 需要明确区分

### 6. “吸引人用”的产品要求

Dashboard 吸引人，不主要靠更炫的首页，而靠以下几点：

1. 用户 30 秒内能找到异常节点
2. 用户 1 分钟内能定位 task 卡在哪一步
3. 派发、回复、失败、重试都有清晰反馈
4. 既能给 operator 日常使用，也能给 owner / 管理者快速看全局
5. 保留拓扑图这类有记忆点的模块，但不让它挤占后台主工作流

换句话说，V2 的 Dashboard 要从“调试台”升级成：

1. 网络态势面板
2. 任务操作台
3. 运维排障入口
4. 多人协作后台

---

## 五、用户登录系统

V2 如果没有登录系统，节点、消息、Dashboard 都无法进入多人协作。

### 1. 认证目标

先解决最小闭环：

1. 用户能登录 Dashboard
2. CLI 能以用户身份拿 token
3. Server 能知道“谁创建了 project / node / task”
4. 不同项目之间默认隔离

### 2. 模型设计

建议 4 个核心实体：

1. `user`
2. `project`
3. `membership`
4. `api_token`

角色建议先收敛成：

1. `owner`
2. `admin`
3. `operator`
4. `viewer`

权限边界：

- `owner/admin`：管理项目、成员、节点
- `operator`：发 task、看日志、重启节点
- `viewer`：只读看板

### 3. CLI 登录体验

建议新增：

```bash
anet login
anet logout
anet whoami
anet project use <project>
```

行为：

1. `anet login` 打开浏览器 OAuth 或输入访问令牌
2. 登录成功后，把 token 写到 `~/.anet/auth.json`
3. `anet whoami` 显示当前用户、默认项目、token 过期时间
4. `anet project use` 切默认项目，避免每次命令带 project 参数

### 4. 节点与用户关系

Node 不直接属于 user，而属于 project。

但需要保留审计字段：

1. `created_by`
2. `last_started_by`
3. `last_stopped_by`
4. `last_message_sent_by`

这样可以回答：

- 这个 node 是谁建的
- 这个任务是谁派发的
- 这个节点是谁重启的

### 5. Dashboard 登录体验

建议最小实现：

1. 邮箱 / OAuth 登录
2. 登录后先进入 project picker
3. 页面右上角始终显示当前 project 和当前用户
4. 无权限页面不显示可操作按钮，而不是点了再报错

---

## 六、统一协议和产品约束

这是 V2 最需要统一的一层，否则各模块会再次漂移。

### 1. 统一术语

1. `node`：长期实体
2. `session`：node 的一次在线运行
3. `task`：需要执行的工作项
4. `message`：协议级传输单元
5. `reply`：某个 task 的结果消息
6. `ack`：投递确认

### 2. 统一真相来源

1. Node 状态以 Server 为准
2. 本地配置以 CLI 文件为准
3. task 状态以 `tasks + task_events` 为准
4. Dashboard 不自行推导协议真相，只消费服务端视图

### 3. 统一失败处理

1. 投递失败：标记 task failed，允许重试
2. 节点离线：task 留在 pending 或 delayed，不伪装成 delivered
3. reply 超时：进入 timeout，Dashboard 高亮
4. 重复消息：按 `message_id` 或 `dedupe_key` 幂等处理

---

## 七、实施顺序

### Phase 1：先止血

1. Runtime 只消费 `task`
2. `reply/message/ack` 不再触发自动回复
3. SSE 事件分型
4. Dashboard 区分 task 和 message

### Phase 2：补协议

1. Server 增加 `send_reply/send_ack`
2. 数据模型增加 `task_id/reply_to/requires_response`
3. Task timeline 打通
4. CLI `inspect/inbox/logs` 对齐新模型

### Phase 3：补控制台

1. Nodes 页
2. Tasks 页
3. Task 详情页
4. Node 详情页

### Phase 4：补多用户

1. user/project/membership
2. Dashboard 登录
3. CLI 登录
4. 项目隔离和 RBAC

---

## 八、待定问题

1. `broadcast` 是否进入独立类型，还是视为多播 `task`
2. `ack` 是否完全不持久化，还是只写 `task_events`
3. Runtime 是否允许对 `message` 做人工转 `task`
4. CLI 是否要支持 `anet send` 作为统一发件入口
5. Dashboard 是否需要“人工接管任务”能力

---

## 建议结论

V2 的重点不是新增更多 agent 特性，而是先把“实体、状态、协议、权限”四层稳定下来。

从 CLI/UX/协议视角，最关键的三件事是：

1. 把 `node / session / task / message` 四个概念彻底拆开
2. 把 `task / reply / ack / message` 做成硬协议，不再靠提示词约定
3. 让 CLI、Server、Dashboard 共用同一套状态真相和术语

如果这三件事先落地，后面的登录、多项目、运营面板和自动化协作都会顺很多。
