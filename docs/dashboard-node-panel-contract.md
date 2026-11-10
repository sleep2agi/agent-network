# Dashboard 节点面板要用的 Hub 端点清单（给消费方，不是给 Hub）

> 起因：Dashboard 侧三条卡（节点详情缺 6 个分区 / 权限模式只读 / 节点密钥）曾分别判断为
> 「端点不存在」「等 Hub 发版」。逐条读码后结论是：**端点都在，缺的是取法**。
> 这份清单只写「哪个数据从哪来、前置条件是什么、失败时怎么读」，不重复 Hub 内部实现。

---

## 1. 节点列表与权限模式（只读即可做）

```text
GET /api/nodes?network_id=<net>
```

每行里与面板相关的字段：

```text
permission_mode            'normal' | 'readonly' | 'restricted' | null
viewer_can.permission_mode boolean        ← 调用者能否改；只读展示不必看它
peer_allowlist / tool_allowlist / rest_allowlist / inbox_allowlist
lifecycle_state / lifecycle_controllable / lifecycle_daemon_node_id
config_revision / updated_at
```

要点：

```text
· 权限模式的**值**在行里，直接展示「normal / readonly / restricted」，无需单节点 GET
· 想显示「可改」时看 viewer_can.permission_mode；决定权在 Hub，别自己推断角色
· 没有 GET /api/nodes/:id —— 不要按单节点端点数去设计（那条不存在是设计如此）
```

---

## 2. 能力旗（规则文件 / 技能 / 文件夹）—— 🔴 只有一种取法是对的

```text
✅ GET /api/status?network_id=<net>&alias=<alias>     → 完整投影，带能力旗
❌ GET /api/status?network_id=<net>&light=1           → 窄投影，**没有**能力旗
```

`rules_file_capable` / `skills_capable` / `files_capable` 只在完整投影里。

推论（也是 Dashboard 那条「直达 /nodes/<alias> 缺能力旗」的分诊依据）：

```text
· 用 ?alias= 收窄**不会**降级成窄投影 —— 实测返回的是完整投影的一行，
  所以「为了拿能力旗必须拉全网 533 KB」这个借口不成立
· 若直达路由拿不到能力旗，先看它是不是用了 light=1，而不是怀疑 Hub
```

另有一个只在特定调用者身上触发的降级，供排障时识别：

```text
节点令牌 + `Accept: application/json` + 查询串里只有 network_id
  ⇒ Hub 认为是旧版 agent-node 的别名探测，返回窄投影（这是兼容行为，不是 bug）
```

---

## 3. 节点密钥（有人误判为「端点 404，要等 Hub 发版」）

真实形状是**入队 + 轮询**，不是「一个 GET 拿全部」：

```text
POST /api/nodes/<node_id>/secrets          body: { action: "list" | "put" | "delete", key?, value?, revision? }
GET  /api/nodes/<node_id>/secrets/<request_id>     按 request_id 轮询结果
```

前置条件（三条，缺一条就失败，且错误码不同）：

```text
1  必须是**用户令牌**（节点令牌 → 401 / user_token_required）
2  必须是网络 owner/admin（secret_admin_required → 403）
3  节点要支持该能力（node_secrets_upgrade_required → 409；这是「升级节点」，不是「等 Hub」）
```

其它约束：

```text
· put / delete 必须带 revision（来自上一次 list）；不带 → 400 revision_required
· 值只出现在写入方向；读回执只给 key / updated_at / revision
· 所以 GET /api/nodes/<id>/secrets（不带 request_id）→ 404 是正常的，别据此判断端点不存在
```

---

## 4. 「选已有项目 / 已有 Session」「Fork 当前节点」（preview 车道）

```text
GET/POST /api/node-session-control/source/directory
GET/POST /api/node-session-control/source/fork
```

读状态码的方式（**这四条不要混**）：

```text
404  gate 未开放（directoryEnabled 关闭）—— 不要 fallback 到普通创建
400  请求体不合法（键/ID 形状）
403  凭据类型或权限不对（目录车道要求**人类凭据**）
409  source_directory_unavailable / source_fork_unavailable —— 能力或租约不成立
```

后台前提（面板「不可用」时的真正原因）：

```text
daemon 必须上报 daemon_capabilities 里的
  source_directory_read / project_new_session / session_attach / source_node_delivery / source_fork_transport
这些是 preview 级、按 daemon 由环境变量显式开启的，**默认关闭**。
判断方法是查 daemon 行的 config_snapshot，不是看 /api/host-supervisors 的投影（那里没有这个字段）。
开启步骤与回滚见 docs/runbooks/source-preview-enablement.md。
```

---

## 5. 三条通用提醒

```text
1  Hub 会对未声明的键做**静默丢弃**（zod）。字段“查不到”时先怀疑自己拼的键名，再怀疑端点。
2  写接口一律看**顶层状态**判断成功（例如模型档位看顶层 modelVariant），
   兼容投影（config_snapshot）可能滞后 1–2.5 分钟，拿它判会得到“没生效”的假结论。
3  /api/host-supervisors 与 /api/nodes 是两套投影：前者是 daemon（host_supervisor）视角，
   后者是节点视角；能力旗、密钥、目录三者都不在同一个投影里。
```
