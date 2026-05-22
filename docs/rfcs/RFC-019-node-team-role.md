# RFC-019：节点 team + role 两个组织维度

| 字段 | 内容 |
|---|---|
| 状态 | **Proposed** —— 待 通信牛 review → Vincent 拍板 |
| 提出 | 2026-05-22 |
| 作者 | 通信工程马 |
| 派单 | 通信龙（Vincent telegram 5896-5900） |
| 关联 issue | [#175](https://github.com/sleep2agi/agent-network/issues/175) 节点 team 维度 / [#170](https://github.com/sleep2agi/agent-network/issues/170) Dashboard 组织架构视图 / [#163](https://github.com/sleep2agi/agent-network/issues/163) Topology 负责人节点 |
| 关联 RFC | RFC-008 multi-agent team convention（首次引入 demo-only `team`/`role`，本 RFC 将其提升为一等维度） |
| 目标版本 | 待 Vincent 拍板后定 |

## 摘要

给 anet 节点新增两个**一等组织维度**：

- **`team`（团队）** —— 节点的团队归属（如「anet 迭代小组」「IM 接入组」「Dashboard 组」）。
- **`role`（角色）** —— 节点在团队里的职能角色（如 负责人 / 工程师 / 测试 / 设计 / 文档 / 运营）。

二者覆盖同一套数据模型 / CLI / commhub / Dashboard 触点，一份 RFC 一起设计。

> **现状关键事实**：`Profile` 接口（`agent-network/bin/cli.ts:256-278`）**已经有** `team?: string` 和 `role?: "leader" | "worker"` 字段，`saveProfile` 也已持久化它们 —— 但这是 RFC-008 / issue #51 科研军团 demo 的 **demo-only 元数据**，只有 `anet demo sci-team` 脚手架会写，没有 user-facing CLI、没进 commhub、Dashboard 不用。本 RFC = 把它们从「demo 元数据」**提升为一等节点维度** + 把 `role` 从 `leader|worker` 二值扩成职能角色。

## 1. 背景

### 1.1 现状

anet 节点现有维度：`alias` / `node_id` / `runtime` / `network` / `model` / `channels`。**没有「团队归属」「职能角色」概念。**

- Dashboard 现在「靠 alias 前缀猜团队」分组（N站马 实现，明确是临时 hack）—— 前缀分组不可靠、易漂移，`team` 字段才该是 source of truth。
- `Profile.team` / `Profile.role` 字段虽已存在，但：`role` 受限于 `"leader" | "worker"`（RFC-008 demo 的结构角色，**不是** Vincent 要的职能角色）；无 `--team`/`--role` CLI flag；`createProfileFromOpts` 不读它们；commhub registration/status payload 不带；Dashboard 不消费。

### 1.2 价值（per #175）

- **组织架构可视化** —— `team` 是 org-chart 的天然分组键，直接喂 #170（Dashboard 组织架构视图）、#163（负责人节点）。
- **团队级操作 / roster / 过滤** —— 团队级 dashboard 分组、team-scoped 查询。
- **可靠的 source of truth** —— 取代 alias-prefix 猜测 hack。
- `role` 进一步让 org-chart 内部可分层（负责人 = 团队头节点）、Dashboard 可按角色打标签/图标。

### 1.3 与「网络成员 role」的区分（重要，避免混淆）

anet 已有一个 `role` 概念：`anet network` 的**成员权限角色**（owner / admin / member / viewer，`cli.ts:4855/4908`）—— 那是 **user × network 的权限层级**。

本 RFC 的 `node.role` 是**节点在团队里的职能角色**（负责人/工程师/测试…）—— 是 **node 的组织属性**，跟权限无关。

两者不同层、不同实体、字段不冲突（一个挂在 membership 上、一个挂在 node config 上）。但命名上同词，**Dashboard / 文档 / CLI 文案必须明确区分**，建议措辞：节点维度统一叫「团队角色 / team role」，网络维度叫「成员角色 / membership role」。

## 2. 设计目标

| 目标 | 描述 |
|---|---|
| G1 | `team` / `role` 成为一等节点维度：CLI 可设可读、commhub 可见、Dashboard 消费 |
| G2 | 不破坏现有 RFC-008 sci-team demo（`team:"sci-team"` + `role:leader/worker` 仍合法） |
| G3 | config.json 为 source of truth；commhub 持有投影副本供 Dashboard / 查询用 |
| G4 | 现有节点平滑迁移，无 team/role 不报错（视为「未分组」） |
| G5 | 取代 Dashboard 的 alias-prefix 分组 hack |

## 3. 数据模型

### 3.1 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `node.team` | `string`（单值，可选） | 团队名。自由文本。 |
| `node.role` | `string`（单值，可选） | 团队角色。自由文本 + 软枚举（见 3.3）。 |

存储位置：`.anet/nodes/<id>/config.json`（**source of truth**）。字段已存在于 `Profile` 接口与 `saveProfile` 白名单 —— 本 RFC 只需扩 `role` 类型 + 接通 CLI/commhub/Dashboard。

### 3.2 自由文本 vs 受控枚举（设计决策 D1）

- **`team` —— 自由文本。** 团队是用户自定义的组织单元，无法穷举。
- **`role` —— 自由文本 + 软枚举（推荐）。** anet 内置一份**推荐角色集**（供 Dashboard 图标 / 校验提示 / Tab 补全），但**存储与接受值是自由文本**，不硬性拒绝表外值 —— Vincent 的清单本身以「等」结尾、开放。
  - 推荐角色集（初版，**待 Vincent 拍板最终清单**）：`负责人` `工程师` `测试` `设计` `文档` `运营`。
  - 软枚举 = 表内值有图标/排序/i18n；表外值原样显示、不报错。兼顾一致性与扩展性。

> 备选：硬枚举。被否 —— Vincent 清单开放式，硬枚举每加一个角色要发版。

### 3.3 单值 vs 多值（设计决策 D2）

- **`team` 单值。** 一节点属一个团队。理由：org-chart（#170）要的是树，一节点跨两团队破坏树形；Vincent 的例子也都是 1 节点 1 团队。多团队属 YAGNI，列为未来扩展（若真需要，再升 `string[]`，迁移兼容）。
- **`role` 单值。** 一节点在团队里担一个职能角色。多角色罕见，单值够。

### 3.4 source of truth 与 commhub 投影（设计决策 D3）

- **config.json = source of truth** —— 节点自己的组织元数据，归节点 config。
- **commhub = 投影副本** —— 节点 register / report_status 时把 `team`/`role` 一并上报，commhub 存在 session/node 行上（跟 `alias`/`runtime`/`agent` 一样是注册时带上的投影）。Dashboard / team-scoped 查询读 commhub 投影，**无需逐个读节点本地 config**。
- 一致性：config 改了 → 下次节点重启 register 时投影刷新（跟 alias rename 同模型，参见 RFC-018）。不引入独立 teams 表（见 4.3）。

### 3.5 `role` 类型扩宽 + 向后兼容（设计决策 D4）

- `Profile.role` 从 `"leader" | "worker"` 改为 `string`（软枚举）。
- **向后兼容**：RFC-008 sci-team demo 写的 `leader` / `worker` 仍是合法 `role` 值，不破坏（G2）。demo 脚手架（`sciTeamPrompt`、`batchAliasFor`、`cli.ts:6386/6622`）可保留 leader/worker 不动，或后续单独跟进改用 `负责人` —— **不在本 RFC 范围**，本 RFC 只保证旧值合法。

## 4. CLI

### 4.1 创建时设置

```
anet node create <name> --team <团队> --role <角色>
```
`createProfileFromOpts` 读 `opts.team` / `opts.role` 写入 Profile。二者都可选。

### 4.2 事后修改 / 查看

```
anet node set-team <node-ref> <团队>      # 改 team
anet node set-role <node-ref> <角色>      # 改 role
anet node set-team <node-ref> --clear     # 清除归属
```
- 实现：`loadStoredProfile` → 改字段 → `saveProfile`。纯本地 config 操作。
- `anet node ls` 增列 `team` / `role`（`cli.ts:2475` 那行节点摘要）。
- `anet info <node>` 显示 team/role。

### 4.3 `anet team` 命令族（只读，团队为「涌现」模型）

```
anet team ls                 # 列出所有 team + 节点数 + 角色分布
anet team show <团队>         # 团队 roster：成员节点 + 各自 role + 在线状态
```

**设计决策 D5 —— 团队是「涌现」的，不做独立 team 注册表。** 一个 team「存在」当且仅当 ≥1 节点的 `team` 字段引用它。所以**不需要** `anet team create` / `delete` —— 无独立注册表 = 无状态、无 config↔registry 漂移。`anet team ls` 是对所有节点 `team` 字段的聚合视图。

> 备选：显式 teams 注册表（`anet team create`）。被否 —— 多一份要同步的状态，团队空名/孤儿条目风险；涌现模型更简、与「config 即 truth」一致。若将来团队要带自身元数据（负责人、描述、父团队），再单开 RFC 升级。

## 5. commhub

### 5.1 registration / status payload

节点注册（`report_status`）payload 增加 `team` / `role` 两字段：
- agent-node runtime：registration 代码加 `team`/`role`（读 config）。
- claude-code-cli runtime：`node-server.ts` 的 `report_status`（`agent-network/src/node-server.ts:437-446`）加 `team`/`role` —— 经由 launchAgent 注入 env（类似 RFC-018 的 `COMMHUB_RESUME_ID` 注入模式）或 node-server 直接读 config。
- commhub server：sessions/nodes 行加 `team` / `role` 列，upsert 时写入。

### 5.2 查询

- `commhub_get_all_status` / `/api/status` 返回值每节点带 `team` / `role`。
- team-scoped 查询：`/api/status?team=<团队>` 过滤（跟 RFC-018 引入的 `?network_id=` 同模式）。

## 6. Dashboard

### 6.1 取代 alias-prefix 分组 hack

Dashboard 改为读 commhub status 投影里的 `team` 字段做分组键，**删除现有 alias-prefix 猜测逻辑**（N站马 的临时 hack）。无 `team` 的节点归入「未分组 / Unassigned」组。

### 6.2 role 展示

- 每节点按 `role` 打标签 / 图标（软枚举表内值有内置图标；表外值显示文字标签）。
- 喂 #170 org-chart：`team` = 分组 / 层级键；team 内 `role` 为 `负责人`（或兼容值 `leader`）的节点 = 该团队头节点，org-chart 层级的锚点；其余 role 作团队内节点的标签 + 排序。

## 7. 迁移

现有节点绝大多数无 `team`/`role`（仅 sci-team demo 节点有）。回填策略：

1. **默认无害** —— 无 team/role 不报错；Dashboard 归「未分组」组；CLI 显示 `-`。G4。
2. **`anet doctor --fix`** —— 检测到未分组节点，交互式逐个问 team/role（可跳过）。
3. **批量** —— `anet node set-team` / `set-role` 逐节点；或未来 `anet team assign <团队> <node...>`（本 RFC 暂不含，列未来）。
4. **sci-team demo 节点** —— 已有 `team:"sci-team"` + `role:leader/worker`，天然合法（3.5），无需迁移动作。
5. **commhub 侧** —— 新增列 nullable，老行 `team`/`role` 为 NULL；节点下次注册时刷新投影。

## 8. 分期实施建议

| 阶段 | 内容 |
|---|---|
| P1 | 数据模型 + CLI（`Profile.role` 扩 string、`--team`/`--role`、`set-team`/`set-role`、`node ls`/`info` 显示）—— 纯 agent-network repo，最小闭环、立即可用 |
| P2 | commhub —— registration/status payload + server 列 + team-scoped 查询 |
| P3 | Dashboard —— team 分组取代 hack + role 标签 + 喂 #170 org-chart |
| P4 | `anet team ls/show` + `anet doctor --fix` 回填 |

P1 先落，P2/P3/P4 可并行。每阶段独立可发。

## 9. 开放问题 / 待 review 决策

1. **`role` 推荐角色集最终清单** —— 初版 `负责人/工程师/测试/设计/文档/运营`，待 Vincent 拍板（要不要加 产品 / 数据 / 安全 等）。
2. **软枚举 vs 硬枚举**（D1）—— 本 RFC 推荐软枚举，请 review 确认。
3. **`team` 单值**（D2）—— 推荐单值，多团队列未来扩展，请确认无近期多团队需求。
4. **涌现团队模型 vs 显式注册表**（D5）—— 推荐涌现模型（无 `anet team create`），请确认；若团队将来要带自身元数据（负责人/描述/父团队嵌套）需另开 RFC。
5. **`node.role` 与网络成员 role 的命名**（1.3）—— 建议 user-facing 文案区分「团队角色」vs「成员角色」，请确认措辞。
6. **P1 是否单独发版** —— P1 是纯 agent-network 本地维度,可先发让用户用起来,P2/P3 跟上;还是四阶段攒齐一起发,请定。
