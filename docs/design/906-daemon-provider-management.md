# #906 — Daemon Provider 管理首片

状态：实现中，未上线。P0；本片不是 #906 完成验收。

2026-10-11 12:30 东八区交付校准：既有 API Key 首片已合入 main；Hub `.121`
已经部署，Android `.235` 已发布，但 CLI `.163` 被 npm 接收后尚未可下载，
自身 Daemon 和桌面首片尚未升级/发布。下文各阶段的“未接线/未发布”是实现时
边界记录，不等于上述组件都未交付；也不能把组件发布当整票可用或已完成。

### 官方 ChatGPT 登录增量（开发中，不在上述发布包中）

`agent-node/src/runtime/codex-managed-login.ts` 提供单次设备码登录状态机。
调用方必须持有一个独立私有 draft CODEX_HOME 和受信 Codex 进程；不复用活跃节点
home，不复制别的账号文件。开始前 `account/read` 必须为空；只调用托管设备码流，
不接入外部 access-token 模式。只有对应 loginId 的成功通知及 ChatGPT account
回读同时成立，才标记 authenticated；客户端公开状态不含 email、token 或原始错误。
取消只针对当前 loginId 并关闭该 draft 进程；成功不触发节点应用、模型切换或推理。
所有权、draft 目录持久化、Hub 操作接口及客户端交互尚未接通，不能直接对外使用。

现有 stdio 客户端增加显式 `replaceEnv`，用于新登录进程不继承父进程的 API Key
或 CODEX_HOME；旧调用方默认行为不变。调用方必须使用此模式并显式提供最小环境。
已用实际 Codex `0.159.2` 的生成 schema 确认设备码协议，以及隔离 account/read；
尚未进行真实用户登录，不能据此宣称官方账号切换可用。

设计依据：[OpenAI Codex App Server authentication](https://learn.chatgpt.com/docs/app-server#authentication-endpoints)。
不新增生产端口、服务或密钥来源；这段状态机尚未接线，生产恢复/回滚流程不变。
后续 draft 凭据须由 daemon 私有目录及加密备份管理，Git 不能重建用户登录状态。

## 用户确认的层级

Daemon → Provider → Runtime（首片 codex-tui）→ 登录 / API Key → 配置 → 模型。
所有者是目标 daemon；runtime 只是兼容维度。官方 ChatGPT 登录和第三方 API Key
不共用凭据，也不因为页面有两种按钮就认定每个 Provider 都支持两种认证。

## 本片已实现的边界

`agent-network/src/daemon-provider-store.ts` 为本地受信操作者提供独立配置存储。
`anet daemon provider list <daemon>` 返回脱敏配置；
`anet daemon provider put <daemon> --revision N` 从标准输入读取不超过 64 KiB 的 JSON。
工作目录沿用现有 CLI 的 `.anet/nodes/<daemon>` 解析，不接受任意路径或命令行 key。
客户端/远程 Hub 不得直接依赖这个本地操作者权限边界。远程协议已增加受控配置写入，
官方登录和节点应用仍未接通；配置写入成功不是模型调用成功。

配置示例（假数据；真实密钥不得写入 shell 历史、提交或测试镜像）：

```json
{
  "id": "deepseek",
  "label": "DeepSeek",
  "enabled": true,
  "runtimes": [{
    "runtime": "codex-tui",
    "auth": [{
      "id": "work",
      "kind": "api_key",
      "baseUrl": "https://api.example.test/v1",
      "models": ["model-a"],
      "key": "TEST-ONLY-placeholder"
    }]
  }]
}
```

保存后必须读取返回的 revision。更新时省略 key 保留旧 key；端点改变时不复用旧 key，
须显式重输。启用/停用以 enabled 更新；目前不提供删除或运行中绑定变更。
官方账号配置用 Provider `openai`、kind `chatgpt`，不接受 key/baseUrl，
**保存这个元数据不执行登录**，credential_present=false。

存储绑定 `{network_id, daemon_node_id}`；复制到其他 daemon/network 后拒绝读取和写入。
所有输出逐字段构造，不带 key。配置存在仅为 configured，verification=not_checked、
application=not_applied；模型清单是用户配置，不是 entitlement 或实际可用性证明。
目录 0700、文件 0600、写入 fsync + 原子 rename；独占锁和 expected revision 防止覆盖。
锁文件存在时拒绝写入，不能仅因时间长而自动抢锁。未知字段和非法认证组合明确拒绝。

## 远程回读协议（源码已实现，尚未上线）

- 用户侧 MCP `daemon_provider_snapshot`：`action=refresh,id=<daemon_node_id>` 请求刷新；
  `action=read,id=<request_id>` 读取回执，两者传目标 `network_id`。仅该网络人类 owner/admin 可用，
  节点令牌及无用户身份的旧全局模式不能管理其他 daemon 的配置。其他既有 token 功能不变。
- Hub 持久化 `daemon_provider_snapshots`；只含请求元数据及验证过的公开投影，不含 key/OAuth。
  同 daemon 同时最多一条 pending；120 秒过期，7 天后在下一次访问时清理旧回执。
- 目标 daemon 从 `pull_daemon_provider_snapshots` 拉取，通过现有 ANET_BIN 信任根验证启动器，
  使用最小环境执行本地 `provider list`，不接受远端文件路径或命令。SSE 门铃及重连均触发补拉，
  并发门铃合并；传输失败不伪造成功。单次 CLI 10 秒超时，公开快照上限 1 MiB。
- `ack_daemon_provider_snapshot` 只接受目标 daemon 的 token-bound 身份；网络、daemon ID、
  Provider/runtime/auth 字段与枚举逐层验证，未知字段（包括 key）拒绝。首条有效回执胜出，
  重复或超时回执不能覆盖。失败只保存固定错误码，不保存原始 CLI/parser 错误。
- `succeeded` 仅指配置回读成功，`observed_at` 为 Hub 收到回执的时间，不是推理验证时间。
  配置仍是 `not_checked/not_applied`；旧 daemon 不响应时显示 expired，绝不冒充空列表或 Hub 列表。

## 下一步必须完成（不能拿本片替代）

1. 远程写入：同一 MCP 工具 `action=put,id=<daemon>,revision,provider`；仅人类 owner/admin。
   `daemon_provider_writes` 用既有 vault AES-GCM 加密暂存输入，公开回执不含密钥。
   必须配置 `ANET_HUB_SECRET_VAULT_KEY`，缺失时明确失败；不为此修改生产密钥。
   Daemon 仅在 Hub URL 为 HTTPS/回环 HTTP 时声明 `accept_writes=true`，旧 daemon 不会收到写请求/密钥。
   本地 CLI 通过 stdin 写入，`--request dps_UUID` 持久化单次写回执；丢回执重试不重复改 revision。
   保存结果同时验证 scope、revision 和公开配置，成功/失败后删除暂存密文；过期在下次协议访问时清理。
   客户端到 Hub 同样要求 HTTPS/回环；反代应禁用请求体记录。保存不自动探测、登录或重启任何节点。
   request/status 历史包含操作者和目标，未将请求内容放入普通消息任务。
2. 客户端 Provider 管理页替换演示壳，按上述层级读写同一份真实配置；切换 daemon 丢弃旧请求。
3. 官方账号登录需本人完成，优先核对已安装 Codex 的 device-code 能力和取消/状态接口。
   不复制其他节点 auth.json，不假设共享 refresh-token 安全。
4. 节点绑定 + 模型选择 → 安全应用 → 实际回读 → 独立认证/请求验收。
   不将 metadata 保存成功写成登录成功，不静默跨 Provider / 账号回退。
5. Docker 的认证原子层通过后，再进入完整流程、多用户、安全及原生客户端包验收。

官方依据（2026-10-11 查询；不是安装版本支持证明）：
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex app-server account login / cancel](https://learn.chatgpt.com/docs/app-server)
- [Custom model providers](https://learn.chatgpt.com/docs/config-file/config-advanced)

## 恢复六问

### 节点应用事务核心（未接入远程 apply）

`agent-network/src/daemon-provider-application.ts` 是正在接线的内部模块，不是可用的
CLI/MCP 应用入口。它要求受信本地节点目录、网络/daemon/node/alias 一致、节点配置
hash 与 Provider revision 双重比较；只选择启用的 codex-tui API Key 配置及其模型。
首个写入路径只允许节点自己的 codex-home，不修改别的登录源、auth.json 或共享 home。
目标停机、启动及真实生效回读由生命周期适配器提供，不能用写文件成功代替这些动作。

停止前保存 0600 `provider-application.json` 私有恢复日志（包含原私有配置，不能上报
Hub 或作为普通日志上传）；Provider store 持锁避免选择后被修改。错误生效回读触发
精确原配置恢复及旧运行态恢复。停止无法确认、回滚失败或检测到外部修改时保留日志并
报告 recovery_required，不覆盖外部编辑，也不自动抢锁/重试。当前尚无恢复 CLI；恢复
操作者须先核对目标属主进程已停、审查日志与当前配置差异，再恢复对应私有文件并启动
原版本，不能仅删除日志假装成功。完成状态另存不含密钥的私有回执；同请求同参数及
同配置版本重放只返回原回执，不重复重启。真实生命周期/远程接线仍待补齐。

应用同时写入节点的 `codexModelProvider`。POSIX/Windows 共存启动器恢复已有会话时
把它显式传到 `thread/resume.modelProvider`，要求返回的 Provider 与模型完全相同；
无此配置字段的旧节点继续原行为。版本指纹忽略启动器生成的端口/恢复观察信息，但
继续覆盖节点身份、线程、权限、模型和环境配置。实际模型调用能力仍须单独验证；
不能把会话恢复回读当作供应商认证成功或可用模型目录证明。

不新增服务、端口或反代；密钥仍来自本 daemon 私有 store。模块尚未接线，因此本次
不部署生产；未来换版仍按精确 main SHA 发布并核对运行态。软件回滚不能撤销已应用
配置；私有日志和 provider-store 必须纳入加密备份，Git 不含这些数据或凭据。

### 既有 Codex 只读扫描（首版增量）

`provider scan <daemon>` 从 stdin 接收 Hub 根据当前网络创建记录与 active bindings
选出的 node_id/alias 清单；不接受远端路径。daemon 使用本地 child-workdirs 注册表
及实际节点 config.json 确认身份，支持原目录与收编节点目录；不能确认时逐节点返回 unavailable。
工作区邻居不会自动进入结果。200 节点为本次扫描上限，超过则拒绝而非隐瞒截断。
用户刷新 Provider 页时扫描并回读；保存 Provider 不自动改写已有 Codex 配置。

TOML 使用锁定的 smol-toml 解析，只输出配置中的 Provider ID、模型与节点模型，三者
不是正在运行进程的最终选择（启动参数/会话覆盖仍可能不同）。CODEX_HOME 只输出来源及
不可逆引用，不输出路径；认证文件仅投影认证类型和账号指纹，不输出 email/token/key。
读取拒绝符号链接、非本用户文件及不安全权限，认证文件不可公开读取；keyring/auto/ephemeral
或 env_key 没有本地凭据证据时是 unknown，不是 logout。不会触发登录或模型费用。
daemon 复用 runtime-readiness 的 PATH/--version 探针（1.5 秒），只返回状态/版本。
该探针只说明 daemon 启动路径的 Codex，不外推每个节点自定义二进制版本。

仍有差额：未收编的独立 Codex 不被冒充此 daemon 所有；宿主默认配置的独立目录展示、
完整 profile 模型目录及运行中会话实际账号/model 比对尚未接入。本增量不等于账号切换完成。
扫描不新增端口/服务/数据库表，不保存或迁移凭据；回滚旧版本忽略可选 inventory 字段。
恢复仍需原节点配置、child-workdirs 注册表及各自认证的加密备份；缺文件明确未知，不自动重建账号。

- 启动：不新增常驻进程；权威入口 `agent-network/bin/cli.ts` 的 daemon provider 分支，
  `agent-node/src/runtime/daemon-provider-snapshot.ts` 由既有 daemon 的 SSE/重连处理调用；
  Hub 由 `server/src/tools.ts` 注册协议，`server/src/db.ts` 增量建表。
- 拓扑：无端口、反代或隧道改动。
- 密钥：本地操作者经 stdin 或已鉴权客户端通过安全传输提供，daemon 私有 provider-store/state.json 持有。
  Hub 暂存密文依赖运维秘密来源注入 `ANET_HUB_SECRET_VAULT_KEY`；不能提交实际值或自动生成替换现存值。
  不入 Git、不回读、不声称磁盘加密；生产备份必须加密并限制访问。
- 换版：只能使用 main 正式发布物。list 回读 scope/revision；本测试分支不得部署为正式版本。
- 回滚：旧版本不会消费新增存储和快照表；保留它们，不删除原 node config、登录或其他数据。
  降级前等待 pending 写入终态；不可把软件降级视为撤销已保存配置，恢复旧配置需加密备份。
  不将回滚软件等同撤销已外泄供应商 key；后者需供应商侧撤销。
- 数据：Git 只能重建实现，不能重建账号/key/用户配置。加密备份目的地、密钥保管、保留期尚未
  指定；未做生产恢复演练，不宣称全机可恢复。崩溃遗留锁需操作者核对写进程已终止后处理。

### 单节点应用传输（测试分支已接线，尚未正式发布）

`daemon_provider_snapshot` 的 `apply` 操作使用既有 daemon id、Provider revision，
以及无密钥的 `provider={node_id,node_revision,provider_id,auth_id,model,confirm_restart:true}`。
扫描对已确认 network 且独占本节点 codex-home 的配置返回可选 `config_revision`；
缺失或 null 仍可展示，但不能作为写入依据。版本包括配置意图、TOML 和私有环境，
排除启动端口/会话验证等观测字段，不对外输出原配置或凭据。

Hub 在 `daemon_provider_applications` 保存无密钥选择，复用快照队列的单 daemon 单飞约束，
请求使用 dpa_UUID、十分钟有效期；只有显式声明 `accept_applications` 的 daemon 才能领取。
领取和成功回执再次验证当前节点归属。回执必须精确匹配节点、Provider、认证项、模型、
运行时 Provider 标识和版本，不把配置快照视作运行中生效证明。
read 将应用证据单独放在 `application`，不会伪装为 Provider 配置快照。
完成/失败/过期清理请求选择，历史无密钥回执按既有七天策略保留。

客户端使用独立确认界面，提交一次后轮询精确请求回执；离开页面只停止观察，不取消远端操作。
daemon 通过已固定的 CLI 入口执行 `daemon provider apply <daemon>`，选择通过 stdin 传递，
不接受 Hub 给出的路径或任意命令。CLI 从本地受信注册表解析目标，并再次验证 Hub 待处理请求、
归属及最新 idle/空队列状态（这不是原子排空租约，仍需真实链路验证）。
现有单节点 stop/start/verify 生命周期负责进程归属；只操作目标节点且不复制宿主 auth.json。
启动必须回读同一 thread/resume 的实际 Provider、模型与节点版本；失败恢复显式传入原 Provider
和模型，不能仅恢复文件后假定会话已还原。恢复不确定保留私有 journal 并禁止盲目重试。
应用选择需要已知原模型；不支持的节点布局、共享 home 或缺失版本会拒绝。

自定义认证使用选定 Provider 的 env_key 与已解析节点环境，不将 key 存在称为登录/推理成功。
语义依据：https://learn.chatgpt.com/docs/config-file/config-reference 与
https://learn.chatgpt.com/docs/app-server；实际二进制契约另见 test906 native-provider-probe。
2026-10-11 已在隔离 Docker 完成真实 Hub→Node daemon handler→源码构建 CLI→原生
Codex 0.159.2 的同会话切换核心链路；本地 HTTPS Responses 端点确认新端点/key/model，
模型回复与凭据均为测试夹具，不代表真实供应商推理、官方账号或原生客户端安装包验收。
复现入口为 `tests/test906-daemon-provider-management/Dockerfile.native`，运行使用
`docker run --init --rm --network none`，init 负责回收 tmux 脱离的子进程，不能用降低
停止验证约束来替代。测试私有 tmux socket 与源码包解析 shim 均在该目录入库。

生命周期 home 检查区分认证方式：没有 auth.json 时，只允许选定自定义 Provider 的
env_key 在属于本节点的实际 Codex app-server 和 TUI 进程中同时存在且相同；仅配置或
wrapper 环境不能作证据。目录权限、已有 auth 文件权限、Hub token、进程归属检查保留。
该检查不宣称凭据远程有效，也不把 keyring/未知认证状态伪装成成功。依据官方认证说明：
https://learn.chatgpt.com/docs/auth#alternative-model-providers 。
不新增服务、端口、密钥来源。建表由仓库 db.ts 负责；软件回滚保留表，旧 daemon 不领取
应用请求。数据库来自既有加密备份；节点配置恢复仍依赖前述私有事务日志/加密备份，
不能靠 clone 仓库重建身份或凭据，也不能将请求超时等同于节点已回滚。

### 托管 ChatGPT 登录与模型配置绑定（PR2581，尚未发布）

客户端在 Daemon 的 Provider 页发起设备码登录。Hub 只暂存有界登录意图和短期设备码回执；
官方浏览器验证必须由人完成。启动进程和私有目录由该 Daemon 自己创建，
不接收远程 credential path、不导入其他节点的 auth.json。实现入口：
`agent-node/src/runtime/daemon-provider-login.ts`、`daemon-codex-logins.ts`。
保存后在 `provider-store/codex-logins/login-*/anet-account.json` 写入随机 account_id、
network/daemon 归属及显示名称；凭据保留同一新登录目录的 auth.json。

配置条目可以引用 `openai -> codex-tui -> chatgpt -> account_id -> models`。
Daemon 在写入配置时检查同一 network/daemon 的私有保存记录和凭据存在性；不跨 Daemon 查找，
不接受路径代替 account_id。回读只含不透明 account_id 和 credential_present，
仍为 verification=not_checked、application=not_applied；模型列表是配置而非额度/权限证明。
删除或损坏凭据后，回读保留配置引用但不再声称凭据存在。API-key 条目不能携带 account_id。
账号绑定与普通配置启停复用既有 revision/CAS 及 Hub 加密写入协议，不能覆盖并发修改。

同一 PR 的后续增量提供 ChatGPT 节点应用事务，但尚未正式发布。选择必须携带精确
account_id（API-key 请求不带），回执匹配同一账号、模型、节点及 revision。复用节点
stop/start/verify；官方账号使用内置 openai Provider、file 凭据存储和强制 ChatGPT 登录，
不把 OAuth 凭据送往用户定义的 Provider 地址。保留 workspace 管理约束。

`daemon-provider-account-custody.ts` 在已确认停止目标节点后读取最新 auth.json，切走前
回存到同一 Daemon 的私有账号目录。保存记录首次应用写入 bound_node_id，之后不能把
同一刷新链应用到第二个节点；第二个节点需独立登录。active 记录的唯一权威凭据是
该节点 codex-home/auth.json，账号目录中的旧副本不能被重新激活。切回从已停用账号
的最新副本恢复；失败时先收回新账号可能已刷新的凭据，再恢复原账号和模型。同账号
模型修改失败也保留最新 token，不覆盖为启动前旧 token。API-key 切换不删除登录文件。

启动后验证既有会话/model/provider，再读取该节点实际 loopback app-server 的 account/read
确认 ChatGPT 模式，并核对私有账号文件指纹。该回执不承诺额度、远程模型可调用或真实
OAuth 仍有效；这些需要实际登录/调用证据。旧宿主级 account install 注册表不是本流程。
托管账号目录与节点目录都是私有状态，Hub 不接收路径、JWT 或刷新 token。

故障恢复：事务日志的 account_recovery 包含停机后的原凭据及两个不透明账号 ID，0600
仅供本机恢复。遗留日志会阻止重放；必须先确认目标进程已停止，检查 active/bound_node_id
和节点当前凭据归属，再将新账号最新凭据安全回存、恢复原配置/账号并验证，不能直接
拿日志中的静态 token 覆盖仍在刷新的账号。异常时保留日志，不宣称自动恢复成功。
软件回滚不清除 bound/active 标记；旧版本不支持账号应用，不能用旧流程跨节点复制凭据。

恢复六问：沿既有 Daemon/SSE 常驻入口，不增服务/端口/反代/隧道；Hub 凭据仍来自已有
部署秘密来源，OAuth 凭据来自本人浏览器登录；软件仅从 main 精确 SHA 发布后更换，并回读
所选 Daemon 的 account_id/Provider revision 验证；软件回滚保留新增私有账号目录和表，
不会注销账号或恢复生产数据。凭据目录必须由现有加密备份覆盖或重新登录，Git 不含这些值。
目前未做生产空机恢复演练，不宣称可恢复。官方语义依据：
https://learn.chatgpt.com/docs/auth 和 https://learn.chatgpt.com/docs/app-server 。
