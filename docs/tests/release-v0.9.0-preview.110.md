# CommHub v0.9.0-preview.110

本版带上 `0.9.0-preview.109`（发版合并 `826c3f0f`，#2448）之后合入的 Hub 改动。`git log 826c3f0f..<发版提交> -- server/` 列出：

| 提交 | PR | 内容 |
|---|---|---|
| cc9a4a50 | #2447 | #629：用户能读到节点生命周期结果（`/api/nodes` 的 `managed` / `adoption`，新只读接口 `GET /api/node-lifecycle-requests`） |
| a5e4440c | #2449 | #652：节点名允许中文 / Unicode，目录仍然是 ASCII；同一 PR 的 agent-node 部分随 agent-node 单独发布 |
| b455e19a | #2450 | #629：生命周期读接口的报错脱敏，按记录下来的子进程身份找节点 |

## 你会看到的变化

- **节点生命周期结果用户看得到（#2447，#629）。** 只对用户令牌（请求头里的用户凭据，不是节点令牌、不是网络 / daemon 令牌）生效：
  - `/api/nodes` 每行多两个字段：`managed`（`created` / `adopted` / `none`）和 `adoption`（最近一次收编绑定的 `request_id` / `daemon_node_id` / `status` / `error`，没有时为 `null`）。其它调用者看到的和 `.109` 一样。
  - `/api/host-supervisors` 对用户令牌、且该 daemon 节点对调用者可见时，带上 daemon 自报的 `adopt_capable`。
  - 新接口 `GET /api/node-lifecycle-requests?kind=adopt|start|stop&request_id=…`（或 `&node_id=…`，二选一）返回最近一条请求的状态。非用户令牌回 `403 user_token_required`；参数不合法回 `400 invalid_lifecycle_query`；节点不可见回 `404 node_not_found`；按 `request_id` 查不到回 `404 request_not_found`。结果不含令牌、路径、PID 或配置。
- **节点名可以是中文（#2449，#652）。** `create_node` 的名字规则从 `^[a-z][a-z0-9_-]{0,63}$` 放宽为：Unicode 字母 / 数字 / 组合符、`_`、`-`，去掉首尾空白后 1–64 个字符，不能以 `-` 开头，不能含空白、`/ \ : .`、引号、`$`、反引号、控制字符。被拒时 `node_name_invalid` 附 `reason` / `char` / `message`。Hub 存、转发的是去掉首尾空白后的名字。
  - 原来合法的名字照旧合法，目录不变。
  - `create_node` 工具的 `node_spec.name` 的 zod 上限从 64 放到 256（UTF-16 单位，只是粗上限；64 个字符由规则本身限制）。
  - 中文名的节点目录由 daemon 换成 ASCII，需要 agent-node 带 #2449 的 daemon；旧 daemon 仍按旧规则拒绝中文名。
- **生命周期报错脱敏（#2450，#629）。** 上面两个读接口里的 `error` 只输出一组固定的公开错误码，其它 daemon 原文一律变成 `lifecycle_error`（原文可能带工作目录路径）。`managed: "created"` 优先按建节点记录里的 `child_node_id` 认节点，没有时才按 `request_id` 推算。

## 数据库与设置

- 不新增表、不改表结构（`server/src/db.ts` 自 `.109` 起没有改动）；新功能只读已有的建节点 / 启停 / 收编记录。
- 没有新的环境变量、端口或密钥来源，默认值都不变。`hub.env` 不用动。

## 检查

- **`tests/hub-release-compat`**：见 PR 说明（候选为 main `b455e19a` + 本版本号，基线 npm 上的 `0.9.0-preview.109`，App desktop-v0.2.214 / .215 / .216 / .217）。
- #2447 / #2450：`server/src/node-lifecycle-read-http.test.ts`，Docker 套件 `tests/test629-lifecycle-read`；记录在 `docs/tests/report-board629-lifecycle-read-api.txt`、`docs/tests/report-test629-read-hardening.txt`。
- #2449：`server/src/create-node-unicode-name.test.ts`、`server/src/shared/node-name.test.ts`，`tests/qa-rfc026-create-node` 场景 A.cn / A.cn2 / E1b。

本说明不代表已发布。只通过 release.yml、用包含这些改动的 main 完整 SHA 发布：
包 `@sleep2agi/commhub-server`，版本 `0.9.0-preview.110`，渠道 preview。

promote 时的 `must_contain`（npm 上 `.109` 的 tarball 里都是 0 处）：
- `invalid_lifecycle_query`（#2447，`server/src/node-lifecycle-read.ts`）
- `LEGACY_NODE_NAME_RE`（#2449，`server/src/shared/node-name.ts`）
- `publicLifecycleError`（#2450，`server/src/node-lifecycle-read.ts`）

## Install

在允许安装的隔离环境里（Hub 需要 Bun）装确切版本：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.110
```

安装命令本身不会切换任何生产进程。

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.110
```

不迁移数据，已有设置含义不变。旧 App 不读新字段，行为不变；新 App 可以建中文名节点（需要新 daemon）。

## 回滚

回到 `0.9.0-preview.109` 是安全的：不改表结构。回滚后 `GET /api/node-lifecycle-requests` 不存在，`/api/nodes` 不再带 `managed` / `adoption`，`create_node` 重新只接受旧规则的名字；已经建好的中文名节点的行和记录都保留。

不要覆盖已发布的包。包内不含任何已有数据、用户、网络成员或密钥。
