# TMWork host supervisor — Hub wire v0.3

状态：**协议基线；实现分 PR 交付，尚未启用或部署。** 日期：2026-11-09。
基于 main `f2388b0ff`，承接神明 v0.2 与 admin 10:35 授权。

P0：开关即同意，不做逐次 approval，不延长现有 60 秒秘密交付/创建回收窗口。
本人可在本人持久所有的 TMWork host 创建 `tmwork-session`；其他人仍须网络 owner/admin。
不改变普通 runtime、#4150 的 source_ref/oprj_/oses_、旧 adoption、通用 CLI 或生产部署。

## 1. 通用规则和身份

- JSON 对象按下文精确键集合验证，未知键拒绝；optional 字段只能缺席，不能用 null 代替。
- opaque ID 格式为前缀加 32 个小写 hex：`tmi_`（实例）、`tdir_`（目录请求）、
  `tsnap_`（快照）、`tprj_`（项目）、`tses_`（会话）、`tbind_`（绑定结果）。
  由发行方用密码学随机源产生至少 128 bit，不编码路径、native ID、token 或标题。
- 实例 ID 由插件每次启动生成；其余目录 ref 由插件生成并在本机保存映射。
  Hub 仍验证 scope、到期、引用成员关系，随机串不是 bearer 授权。
- 时间为整数 epoch 毫秒；deadline/TTL 由 Hub 时钟决定，插件只接受更短的期限。
- 人类使用经 Hub 认证的用户会话/PAT；daemon/child 用各自 token-bound node 凭据。
  node token 即使有 issuer user_id，也不是此对象级例外所称的“本人”人类凭据。
- HTTP 服务沿用现有 Bearer 认证、网络写入限制和限流，不在请求正文接收 token。
- 下列 HTTP 接口均为**新增**，须逐 PR 实现后才可调用；不是现网可用性声明。

### 持久所有权来源

插件登录者通过现有节点凭据签发流程，**明确传入新的 node_id** 建立节点，使用
`createNetworkTokenForNode(userId,networkId,name,nodeId)` 既有可信事务语义。
Hub 保存的 `nodes.owner_user_id` 与 token 的 `bound_node_id`/user_id/network_id 共同校验。
不从 report_status 的 owner/user 字段、机器名、alias 或 capabilities 推断所有权。
旧 owner=NULL、仅按名字注册或有歧义的 host 不自动回填 owner，不享受本人例外；
用户应通过明确的新身份登记流程注册，不凭 refresh 抢占旧节点。
节点凭据签发本身继续使用现有网络 membership/restricted 检查。

## 2. 能力与可见性

`report_status.config_snapshot.role="host_supervisor"`，并上报：

```json
{
  "daemon_capabilities": {
    "can_create_nodes": true,
    "runtimes_supported": ["tmwork-session"],
    "max_concurrent_children": 20,
    "tmwork": {
      "protocol": 1,
      "app_version": "<actual-version>",
      "instance_id": "tmi_00000000000000000000000000000001",
      "session_modes": ["bind", "new", "fork"],
      "directory": {"version": 1, "on_demand": true}
    }
  }
}
```

`tmwork` 整体严格校验；非法值当作不具备能力，不使整条心跳失败。
mode 数组 1–3 项、不可重复；app_version 1–64 字符，不含控制字符。
host 列表/MCP 投影不含目录快照或原生 ID；仅向有本 lane 权限者投影有效 tmwork 能力，
并提供 `tmwork_create_allowed` 布尔值。该位只表示权限，不替代 can_create_nodes/在线检查。
不能据此改变旧 host 的可见性/普通创建权限；缺字段视为不支持 TMWork。

TMWork lane 准入要求：role 正确、在线（最后心跳不超过 5 分钟）、can_create_nodes 严格 true、
runtimes_supported 包含目标、有效 protocol=1、当前 instance/mode 匹配、有效目录授权。
不使用“旧 daemon 缺 allowlist 仍放行”的普通 runtime 兼容兜底。

## 3. 权限矩阵

所有路径首先要求当前同网络有效 membership、可写凭据、非 restricted，且经过既有 scope/资源限制。

| 操作 | 本人持久所有 host 的普通成员（人类） | 网络 owner/admin（人类） | 其他成员 | daemon / child token |
|---|---|---|---|---|
| 发现本 lane host / 请求目录 | 本人 host | 已有权限内 host | 拒绝 | 不作为人类调用方 |
| TMWork create_node | 本人 host + tmwork-session | 已有权限内 host + tmwork-session | 拒绝 | 拒绝此 lane 创建 |
| 读目录结果 | 原 requester，仍有 host 权限 | 仅自己的请求 | 拒绝 | 拒绝 |
| 读创建操作状态 | 原 requester，仍有 host 权限 | 仅自己的请求 | 拒绝 | 只给目标 daemon 专用 pull/ack |
| pull/ack 目录、get/ack 创建 | 拒绝 | 拒绝人类冒充 daemon | 拒绝 | 仅目标 token-bound daemon |
| 上报子节点 binding | 拒绝 | 拒绝人类冒充 child | 拒绝 | 仅当前操作 token-bound child |
| 普通 runtime 创建/clone/start/stop/delete | 不因本例外获得权限 | 保持现有权限 | 保持现有权限 | 保持现有权限 |

每次读写重验权限、owner、token/instance 当前性；Hub 不能只在目录首次查询时检查。
对象级例外不扩大网络 scope；目录里不出现其他用户仅因同机器而可见的项目/会话。
无权限/跨网络的资源 HTTP 返回通用 404；错误不得包含其拥有者、路径或目录内容。

## 4. 目录：P0 仅按需，不做全目录心跳推送

### 4.1 人类请求

`POST /api/tmwork-directory/requests`

```json
{"network_id":"net_example","daemon_node_id":"node_example","instance_id":"tmi_00000000000000000000000000000001","intent_id":"00000000000000000000000000000002"}
```

响应 HTTP202：`{ok:true,request_id,instance_id,status:"pending",expires_at}`。
intent_id 是 32 小写 hex，作用域为认证用户/凭据/网络/daemon/操作；相同键和载荷返回原 request，
不同载荷 409 intent_payload_changed。请求有效期 60 秒，单人单 host 最多 2 个未完成请求。
可发送 `{type:"tmwork_directory",request_id}` 非敏感门铃；门铃仅提示，不能充当可靠队列。

`GET /api/tmwork-directory/requests/{tdir_id}?network_id=...`
精确响应：`{ok:true,request_id,instance_id,status,expires_at,snapshot,error}`。
snapshot/error 未出现时为 null；status 为 pending/claimed/ready/failed/expired。
ready 的 snapshot 形状：

```json
{
  "snapshot_id":"tsnap_00000000000000000000000000000003",
  "instance_id":"tmi_00000000000000000000000000000001",
  "expires_at":1794220800000,
  "completeness":"bounded",
  "truncated":false,
  "projects":[{
    "project_ref":"tprj_00000000000000000000000000000004",
    "label":"project",
    "sessions":[{"session_ref":"tses_00000000000000000000000000000005","title":"Session","updated_at":1794220500000}]
  }]
}
```

快照有效期至 Hub 接受成功 ack 后 5 分钟，不能由插件延长。
最多 16 项目，每项目最多 50 根会话，总会话最多 100，响应总计不超过 64 KiB UTF-8。
超过限额在插件端截断并声明 truncated=true，不声称枚举完整；Hub 不静默截断超标响应。
P0 无分页：向导可刷新/缩小 TMWork 本机公开项目集；不得伪装成全量搜索。
标题/label 最多120字符，拒控制字符；平台禁止上报路径、凭据、正文，插件先脱敏，Hub防御校验。

### 4.2 daemon 通道

`POST /api/tmwork-directory/pull` body `{instance_id}`：
返回 HTTP200 `{ok:true,task:null}` 或
`{ok:true,task:{request_id,instance_id,expires_at,max_projects:16,max_sessions_per_project:50,max_sessions_total:100,max_bytes:65536,snapshot_ttl_ms:300000}}`。
只可 claim 绑定自身 node token/网络/实例的请求；并发只 claim 一次。
连接/重连后及每 10 秒主动 pull 补漏，不能依赖易失门铃；单实例每次最多一个 task。

`POST /api/tmwork-directory/ack`：
成功 body `{request_id,instance_id,result:{status:"ready",snapshot:{snapshot_id,instance_id,completeness,truncated,projects}}}`；
失败 body `{request_id,instance_id,result:{status:"failed",error:<稳定错误码>}}`。
expires_at 由 Hub 写入返回快照，不接受 daemon 上送。
响应 `{ok:true,status:"ready"|"failed"}`；同一成功正文重报返回原结果，不同正文409。
旧实例、过期、非本 daemon、未 claim、重复 ref、跨项目 session_ref 复用、超限均拒绝。
只读任务可重新查询，但不得将一次目录重试当作 new/fork 的重试授权。

## 5. 创建专用 lane

MCP `create_node` 严格顶层 `{network_id,daemon_node_id,node_spec}`；node_spec 恰为
`{name,runtime:"tmwork-session",flags:{tmwork:<选择>}}`。不得被普通 zod strip 降级。
禁止 model/workdir/channels/env_refs/source_ref 和任意普通 flags（包括显式空值）。
name 沿用既有共享节点名校验；唯一变化不是放宽全局 RUNTIMES，而是先分派专用 lane。

选择公共键：protocol=1、instance_id、snapshot_id、intent_id、mode。
new 必须且只额外带 project_ref；bind/fork 必须且只额外带 session_ref，项目由快照推导。
bind/fork 禁 project_ref，避免双重来源或静默忽略。例：

```json
{
  "network_id":"net_example",
  "daemon_node_id":"node_example",
  "node_spec":{
    "name":"apple-1","runtime":"tmwork-session",
    "flags":{"tmwork":{
      "protocol":1,"instance_id":"tmi_00000000000000000000000000000001",
      "snapshot_id":"tsnap_00000000000000000000000000000003",
      "intent_id":"00000000000000000000000000000006",
      "mode":"bind","session_ref":"tses_00000000000000000000000000000005"
    }}
  }
}
```

成功继续使用 `{ok:true,request_id}`，失败 `{ok:false,error:<code>}`。
创建记录必须绑定 requester credential/user/network、持久 host owner、daemon node/token/instance、
原始快照、选择、规范 name、intent、预分配 child_node_id 和 child token ID。
同 intent 同载荷返回原请求（先查幂等，后判断旧快照是否过期），不再 mint/doorbell；
不同载荷409等价 MCP error=intent_payload_changed。保留幂等墓碑，过期旧键不当新键重跑。
在一个事务内做授权重验、快照引用校验、准入/并发限制和操作预留；先保留操作再 mint。
未知“是否已 mint/执行”进入 outcome_unknown，不自动创建第二个 request。

门铃仍为 `{type:"create_node",request_id}`，无秘密。
`get_create_request({request_id})` 保留既有键，TMWork lane 增加 `tmwork_delivery`：
`{protocol:1,instance_id,child_node_id,credential_expires_at}`。
node_spec 如上述规范形状，env_blob 为 {}，child_token 只经本 daemon 一次性取走。
本 lane child token 绑定预分配 child ID/网络/创建者用户，不能靠 alias 报到冒认别的节点。
交付不扩大当前60秒窗口，插件本地尽早校验并执行。凭据/初始化超时明确失败，不延长TTL。

## 6. 状态、ACK、unknown

创建请求沿用 pending → delivered → succeeded / failed / rejected / expired / runtime_capability_check_failed。
`ack_create_request` 参数仍为既有 request_id/status/error? 等；本 lane 禁 child_pid/launch_verified，
不用插件PID伪装子运行证明；插件自执行，禁止进入 buildAnetArgs/通用 anet CLI。
started 只盖已启动，不赋 succeeded、不续TTL；失败/拒绝撤销child token。
只有预期 token-bound child 的真实注册能收敛注册成功，不能仅按同名 alias 认领。

本 lane 新增只读状态接口：
`GET /api/tmwork-create-requests/{request_id}?network_id=...`，响应恰为
`{ok:true,request_id,status,error,binding_status,receive_enabled}`。
binding_status 为 pending/verified/failed/unknown；receive_enabled 无可信读回则 null。
**succeeded 只代表注册，不代表绑定或收件开启。** UI 分开显示“已注册”“已绑定”“收件关闭/开启”。

get响应丢失、kernel new/fork结果未知、实例变化、Hub/插件重启失去操作证明时，
插件持久 request_id 日志并 ack failed + error=outcome_unknown（能鉴权时）。
不可重复 get 取秘密、不可换 intent 自动再建、不可重放原生 new/fork。
Hub 观察 token/实例失效或无法判定的中间态，标记 unknown/失败，停准入并回收自己的凭据，
不替用户删已可能产生的会话。用户回 TMWork 人工核对；“再试”必须先解决旧结果，明确新操作。
SSE重连用 list_my_pending_create_requests() 补门铃，本地日志拒绝已经消费的请求再次执行。

## 7. 子节点绑定证据

只能由实际 child 自己的 token-bound `report_status` 上报，daemon不得冒用自身身份写别的节点。
字段为 `config_snapshot.tmwork.binding`，精确键为：

```json
{
  "protocol":1,
  "request_id":"cr_example",
  "daemon_instance_id":"tmi_00000000000000000000000000000001",
  "snapshot_id":"tsnap_00000000000000000000000000000003",
  "binding_ref":"tbind_00000000000000000000000000000007",
  "status":"verified",
  "receive_enabled":false
}
```

status=verified/failed/unknown；仅 verified 表示当前实际会话存在且绑定读回匹配。
Hub 核对 report caller 与创建记录 child ID/token/network、daemon实例、snapshot、操作。
不从客户端可写 verified:true 无条件提升状态；保留该证据属于本机可信插件读回、非第三方硬件证明的边界。
binding_ref 由插件发行，指向最终会话（new/fork 的新结果，不是源session_ref），不公开 native ID。
原选择 ref 从创建记录关联，避免 report_status 泄露过期目录映射。
实例变化/绑定失败后不得沿用旧 verified；receipt 可保留历史，但可用性必须依赖当前读回。
receive_enabled=false 与绑定成功可同时成立，不能自动改成 true；不宣称已可接任务。

## 8. 稳定错误码与限额

普通 create_node 错误继续原样；新增 lane 使用：
`tmwork_request_invalid`、`tmwork_not_supported`、`tmwork_host_forbidden`、`tmwork_host_offline`、
`tmwork_directory_limit`、`snapshot_expired`、`instance_changed`、`ref_unresolvable`、
`project_unavailable`、`session_not_found`、`mode_invalid`、`binding_conflict`、
`cross_dir_fork_unsupported`、`kernel_unavailable`、`daemon_disabled`、`outcome_unknown`、
`intent_payload_changed`、`binding_evidence_invalid`。

HTTP映射：无效400；无身份401；资源不可见404；冲突409；过期410；大小413；限流429；依赖503。
MCP使用既有 `{ok:false,error}`，不能把工具HTTP200当业务成功。
ack.error 仅稳定code，无原生报错堆栈/路径/凭据；敏感诊断只在本机脱敏日志。
目录 max bytes=65536、16项目/50单项目会话/100总会话、request TTL=60s、snapshot TTL=300s；
host创建上限取声明max_concurrent_children与平台硬上限较小值，P0平台硬上限20。
门铃/状态轮询不延长快照/凭据/操作有效期。

## 9. 本机执行与撤销

- 本机公开项目集以用户设置为准；realpath/位置归属复核，无调用者自由路径。
- bind 以 kernel/session 的实际身份加本机跨网络有效租约原子占用；暂停不释放租约。
- fork 在源实际工作目录执行，禁止跨目录或改cwd模拟；结果必须是不同native会话。
- 关闭开关先拒绝本机未开始请求/目录访问，报告can_create_nodes=false并使实例不可用，
  Hub再拒新准入/撤销未交付操作；注销或心跳缓存不是即时撤销机制。
- 关闭开关不自动停/删已创建子节点或任务；保留独立收件/生命周期权限，不擅自扩权。

## 10. 交付拆分与恢复边界

每项独立 PR；只有对应代码和测试交付后才对外称支持：
1. 本wire、独立严格validator/类型及原子测试（不启用任何route/runtime/权限）。
2. capability/binding schema与投影，缺能力fail-closed；真实host所有权路径验收。
3. 按需目录转发与scope/实例/限额/到期/并发/重复ack测试。
4. 专用create lane、对象权限、幂等、凭据/ACK/注册绑定收敛。
5. 跨组件负控、旧#4150/adoption回归与本机插件/客户端联调。

启动与反代沿用Hub既有入库编排，不新增机器、端口或秘密；所有新持久表/索引使用仓库migration，
未知中间态重启后fail-closed而非继续执行。目录/ref映射是实例本地状态，不承诺可跨重启恢复。
创建/幂等/绑定记录来自Hub数据库加密备份，clone不能恢复用户数据/secret。
后续运行PR须记录迁移、精确版本验证与兼容回滚：回滚先停止本lane新准入、收敛/撤销未完成凭据，
再切回旧代码；不删用户会话、不用破坏数据库的降级。部署、发布、生产验证均另需admin授权。
