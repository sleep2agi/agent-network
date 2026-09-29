# 需求卡负责人和参与人（下一小版）

基于需求池 #2064；本变更尚未发布。运行中的 tasks 状态不变。

GET `/api/requirements/people?network_id=...` 返回当前网络的候选人：
`{people:[{kind:"user"|"node",id,networkId,name}]}`。离线节点仍可分配，显示名不作为身份。

需求卡新增 `owner:null|{kind,id}` 和 `participants:[{kind,id}]`。POST 可提供初始绑定；PATCH 可以单独替换 owner、participants、name、priority、due、assignee，省略字段保留原值。owner 用 null、participants 用 [] 显式清空；due 和 assignee 用空字符串清空。参与人按 kind + id 去重，上限 100 个输入项。旧 assignee 文本保留，旧列移动客户端仍兼容。

成员必须属于卡片的网络；用户来自 network_members，Agent 来自 nodes。读取继承网络作用域，写入继承现有网络角色权限，viewer 不可写。节点令牌依旧拒绝；Agent 自主操作留到后续授权小版。

### 负责人 / 负责 Agent 分开（agent_owner）

- `owner`：**负责人**，只能是人类（`{kind:"user",id}`），对结果负责。写入节点返回 400 `owner_must_be_human`。
- `agent_owner`：**负责 Agent**，只能是节点（`{kind:"node",id}`），负责执行。写入人类返回 400 `agent_owner_must_be_agent`。与 owner 同样按网络校验成员，`null` 清空，PATCH 省略则保留。
- `participants` 不变：人类和 Agent 都可以。
- 读取总带 `agent_owner` 字段（没有时为 `null`）；客户端用「行里有没有这个字段」判断 Hub 是否支持两个角色，旧 Hub 退回单一负责人。
- 启动迁移（`server/src/requirements-migrate.ts`）：`owner` 是节点且 `agent_owner` 为空的行，把节点挪到 `agent_owner`、`owner` 置空；幂等，不删行、不动其他列，解析不了的旧值原样保留。旧库里未迁移的节点负责人照常读出，只在请求显式写 owner 时校验种类。

本版为最后写入覆盖语义，尚无版本冲突提示。客户端应避免一次编辑提交未改动的绑定字段；多人同时修改同一字段的冲突解决属于后续交付项。

## 恢复与部署边界

- 启动仍由仓库现有 Hub 启动/部署流程负责，本变更仅在 `server/src/db.ts` 增加幂等列迁移。
- 端口、反代、隧道未改变，沿用既有部署配置；本变更不需要新服务或端口。
- 使用既有用户令牌和数据库环境配置，不新增密钥；不在仓库记录密钥值。
- 升级须从合入 main 的精确 SHA 构建；验证候选查询、保存及另一个客户端回读，不能只看包版本。
- 回滚旧二进制时保留新增列。旧客户端不显示人员绑定，但不应删除这些列或重建生产数据库。升级前按部署方现有流程保存数据库备份。
- 绑定属于生产数据库数据，须随数据库备份恢复；clone 仓库只恢复 schema 和软件，不恢复成员或任务数据。本次仅隔离数据库演练，未验证生产恢复流程。
