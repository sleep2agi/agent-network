# #906 / #907 — daemon 与 Hub Provider 两层作用域

状态：设计草案，2026-10-11。P0。本文不是已实现 API，也不是发布/凭据下发授权。

## 当前事实与首片

核对 Hub main `050b7bc400cde1378b35e27fdc8daa6f17841ca8`：
`server/src/tools.ts` 中 `list_providers` 按调用者 network 返回 enabled Provider/model，
没有 daemon 绑定、runtime 实测或调用授权字段。`probe_provider_model` 是独立的
admin/owner 探测操作；探测成功不建立持久绑定，也不证明节点创建使用了该配置。
现有注册表和 vault 参见 [RFC-028](../rfcs/RFC-028-provider-model-registry.md)。

App main `7fe4af6c1b7e6740faa7f77a1fb9bf9565051d9f` 已有目录展示及管理页入口，
但 `provider-create-options.ts` 仍显式拦截未接通的 Provider 创建写链路。
首片修正 `daemon-runtime-providers.ts`：只认可选中 daemon 自报的目录，
网络目录即使带 runtime 标签也不合入。没有目录仍显示未上报/升级提示，不伪造可用数量。
此修正不宣称 DeepSeek 创建或完整 Provider 管理已经可用。

## 数据身份与权限（拟议）

Hub 对象的所有者是 network，而非整个 Hub 的所有租户。daemon 对象的所有者是
network 内一个不可变 daemon_node_id。引用由
`{network_id, scope: hub|daemon, owner_id, provider_id, revision}` 确定；名称只展示。
同名对象并存，不覆盖、不按名称继承、不在失败时偷偷切换账号。

| 操作 | network viewer | network admin/owner | daemon 授权管理员 |
| --- | --- | --- | --- |
| 查看脱敏 Hub 目录 | 按目录可见策略 | 是 | 按网络成员策略 |
| 编辑 Hub Provider/授权 | 否 | 是 | 否，除非兼任 network admin |
| 查看 daemon 实际目录 | 须有该 daemon 读取权限 | 是 | 仅授权 daemon |
| 管理 daemon 自有配置 | 否 | 按主机管理策略 | 仅授权 daemon |
| 绑定 Hub Provider | 否 | 须目标 daemon 授权 | 还须 Hub Provider 的 bind/use 授权 |
| 读取密钥明文 | 否 | 管理接口也不回读 | 管理接口也不回读 |

新增权限须复用服务器现有身份鉴别；角色表不是客户端自行判断授权的依据。
节点创建在 Hub 和目标 daemon 都重新校验引用、runtime、模型及版本，不能相信 UI 筛选。

## API 与状态模型（拟议，尚未实现）

- 保留 `list_providers` 原有 network 语义和旧客户端兼容性。
- 新 daemon catalog 请求必须指定 daemon_node_id；响应绑定 network_id、daemon_node_id、
  observed_at、catalog_revision，逐 runtime 给出兼容模型及能力来源。客户端切换主机或网络时
  取消/丢弃旧请求，不接受仅 runtime 相同的响应。
- 单独的 binding 资源包含 Hub provider_id/revision、daemon_node_id、允许 runtimes/models、
  enabled、配置版本和最近 daemon ack。写接口校验 expected_revision，并审计操作者/目标/差异。
- 配置写入采用 request_id 幂等、目标 ack、超时可查询；accepted 不等于 applied。
  daemon 离线时呈 pending，不假称生效。凭据值不放进状态、审计或普通任务 payload。
- 目录展示分别计 configured、bound、compatible、verified、failed、unknown/stale；
  verified 必须有目标机近期验证，不把未知当零或把 Hub 探测当 daemon 实测。
- 模型选择保留 OpenCode 原生 provider/model ID 与模型发现来源，不把 Codex 预设当作
  OpenCode 全目录。Codex 使用自己的 model_providers 与协议适配，不能仅凭名字相同就兼容。

## 凭据模式与撤销边界

首选实施阶段：共享非秘密模板 + daemon 自有 credential reference。绑定模板后若缺凭据，
显示 configured/credential-required，不能显示 ready。用户选择 daemon 本地凭据源；
不得复制其他节点个人 auth.json，也不得从网络共享目录隐式继承个人 OAuth 身份。

Hub 密钥直连分发须另行评审：仅在明确授权后向目标 daemon 按需提供最小凭据，短期缓存、
轮换及审计。静态供应商 key 一旦到达主机，Hub 解绑不能撤回已泄露的副本；真正吊销须供应商侧。
Hub 代理是另一候选，不因存在 vault 就默认建设或宣称支持流式/取消/工具协议。
沿用现有 SSRF、端点与重定向守卫，不为自定义 Provider 降低限制。

撤销先停止新创建/新绑定解析；运行中会话须按 runtime 能力明确提示“需重建会话”或执行已审计的
重新配置流程，不擅自 kill。离线 daemon 在重新联网后重新鉴权，不能用过期 ack 宣称授权仍有效。

## 客户端交互与小片验收

1. 本轮：阻断 network 目录误显示为 daemon 可用；Docker 回归本地目录与负控。
2. daemon 只读 catalog：来源标签、各 runtime Provider/模型计数、搜索/选择、空/错/过期状态；
   两台 daemon + 两个 network 的权限与切换测试。没有真实认证层通过，不进入写链路测试。
3. daemon 自有管理：增改/停用、凭据写入但不回读、真实 runtime 创建与失败可恢复；
   优先 OpenCode V2，同时覆盖 Codex 自定义 DeepSeek 协议负控，不能用 stub 替代真实兼容验收。
4. Hub 模板与显式绑定：同名冲突、乐观锁、权限、撤销、离线再同步与旧客户端兼容。
5. 只有前述原子层通过，才做完整原生包/多用户/安全 E2E；正式发布另走精确 main SHA 门。

每片沿原 #906/#907 回填版本、分母、失败性质及证据；需求拆分前查重，CI 通过不等于发布。

## 恢复影响（六问）

本轮只有客户端纯函数修复与设计文档，不新增常驻服务、启动器、端口、反代或隧道；
不新增环境变量/密钥来源，也不迁移数据库。换版验证需在后续 main 发布中运行目录负控；
回滚本片为回退客户端代码，但旧版本会重新引入误展示，应优先前滚。
生产 Provider、授权及 vault 数据不在 Git 中；将来 schema/binding 实施必须同步提交
migration、加密备份来源/恢复手册、密钥来源与隔离恢复演练。本文不宣称这些数据已可恢复。
