# OpenCode TUI 共存运行手册

状态：共存功能在 preview 通道。V2 受限预览由 PR #2380 引入，首次随
`agent-network@2.3.0-preview.140` / `agent-node@2.5.0-preview.107` 发布；
这不是当前通道版本声明。升级时使用仓库版本配对表指定的精确 CLI/runtime，
不要混用不同批次，也不要把 V1 的安全保证套到 V2。

## OpenCode V2 远程创建接口（#829 开发中）

以下是 Hub/daemon 参数与落盘切片，**不是已经上线的客户端入口或真实 V2
生命周期验收**。现有 CLI、原生 V2 权限、客户端界面和正式发布仍各有门禁。

新接口沿用 runtime `opencode-cli`，在 `node_spec.flags` 里显式传
`opencodeGeneration: "v2"` 和 `opencodeUnsafeTools: true`。
V2 仍是高风险 preview：所有本地工具可用，只能用于可信任务，不能默认勾选、
从其它 runtime/模板继承授权，或把无授权拒绝改成自动重试。
Hub 与 daemon 都校验类型、runtime 和 opt-in；这两个字段误放顶层会被拒绝。
旧 Hub/daemon 不认识 flags 中的字段时应明确拒绝，不能偷偷退回 V1。

daemon 直接写子节点配置（不调用 CLI create）：代际写到顶层
`opencodeGeneration`，V2 模式写为 `opencodeMode: "copresence"`；
权限保留在 `flags.opencodeUnsafeTools`。省略代际保持旧 V1 行为，
显式 V1 不接受这条新建接口的 unsafe 开关。已有节点不迁移。

候选 V2 配置的 `opencodeMode: "copresence"` 使普通 `anet node start`
进入 TUI/桥编排；内部桥使用 `ANET_COPRESENCE_BRIDGE=1` 防止递归启动。
此选择不授予 unsafe 权限，V1 仍保持下文显式 `--copresence` 行为。
daemon 对编排启动器的完成判定、远程停止/重启仍须独立验证，不代表已发布。

Linux 候选实现会在原生 V2 就绪后写节点目录内的
`opencode-launch-health.json`（0600，无凭据）。daemon 接受正常退出的
共存启动器前，核对本轮写入时间、bridge/serve/TUI 的 PID 与启动 ticks、
serve 父进程、bridge 的精确配置路径及 TUI session；旧记录、PID 复用、
死进程或非零退出不放行。运行代际关闭/serve 退出时清理自己的记录。
此文件是可重建的运行证据，不是需要从备份恢复的数据，不能复制旧记录
冒充就绪。仅 Linux daemon 创建完成判定有此证据路径，其他平台未验收。
不要把 Hub 首次注册的 `succeeded` 或 launcher 的退出 0 单独当作健康；
应等 daemon 延迟检查结束，验证 token 仍有效，再验真实任务终态。
没有新增常驻服务、端口、环境变量或密钥来源；既有升级/回滚流程不变。

daemon 新建 OpenCode 节点时，先复用 CLI 的 no-follow 私密目录与 Git
未跟踪校验，再在同一运行用户的 `HOME/.anet/opencode-runtime-bindings/`
建立外部身份记录，最后原子写入含 token 的 0600 配置。不能只复制项目
目录后补造绑定；已有配置只有相同 create request/node_id、alias 且绑定
完整时才允许重试。绑定或私密路径被篡改时应调查并走显式重建，不能删除
身份记录来绕过拒绝。CLI 与 daemon 的四个安全模块为字节一致镜像，
由 `opencode-create-security-parity.test.ts` 阻止单边修改。
恢复时节点私密配置及上述 HOME 绑定属于加密备份数据，不属于 Git 源码；
必须恢复至匹配的规范项目路径，否则重新注册/创建。此补丁不改端口、
代理、常驻服务入口、凭据来源或正式发布流程，也未完成整机恢复演练。

验证入口为 `tests/test829-opencode-create/Dockerfile`，绑定完整源码 SHA，
运行时传同一 `EXPECTED_SOURCE_COMMIT`，报告在容器
`/tmp/art/report-test829.txt`。目前测试真实 Hub handler 存取与 daemon 写盘，
启动进程是测试替身；不据此宣称真实 V2 上线成功。下一门需要精确版本就绪、
真 daemon/Hub/V2 注册和任务回执、停止/再启动及客户端 UI 回读。

此切片不新增常驻服务、端口、代理、密钥来源或迁移。仍用本文的启动流程，
凭据由已有 Hub/节点密钥流程提供，不写入测试报告。正式升级只从经过门禁的
main 完整 SHA 构建；回滚须回到已验证版本，先停止新增 V2 节点，不能让旧版本
静默接管 V2 配置。数据库/节点数据来自原有备份，clone 不包含这些数据；
本切片测试不构成灾难恢复演练证明。


## 先选择代际

| 代际 | 上游包 / 固定版本 | 模式 | 安全边界 |
| --- | --- | --- | --- |
| V1（默认） | `opencode-ai@1.18.34`，过渡兼容 `1.18.1` | headless / copresence | 原有逐项 deny 安全预设 |
| V2（受限 preview） | `@opencode/cli@2.0.22` | 仅 copresence | 必须显式确认 `flags.opencodeUnsafeTools=true`；默认拒绝 |

两个上游包都安装名为 `opencode` 的命令，**不能装进同一个 npm prefix**。
V2 应安装在独立、所有者可信且不可组写的前缀，再让启动命令的 PATH 优先指向它。
不要通过覆盖生产全局 V1 来试用 V2。切回 V1 使用独立 V1 节点和对应 PATH；
V2 session 没有承诺可降级为 V1 session。

V2 创建命令（仅用于可信工作区和可信任务，先理解工具权限风险）：

```bash
anet node create opencode-v2 \
  --runtime opencode-cli \
  --opencode-generation v2 \
  --opencode-unsafe-tools \
  --model '<provider>/<model>'
anet node start opencode-v2 --copresence
tmux attach -t '=opencode-v2'
anet node stop opencode-v2
```

V2 忽略 V1 的 `OPENCODE_PERMISSION` 等环境开关。没有显式 opt-in 时应看到
拒绝提示，而不是删除校验或把安全模式改成宽松模式。原生 V2 安全策略、
daemon/API/客户端 V2 创建入口与模型主动调用 CommHub 工具的完整验收，
仍由 Hub #539 / GitHub #2544 跟踪；这里的 CLI 示例不代表这些入口已支持。

V2 使用 `opencode --server <url> --session <id>`，不是 V1 的 `attach`。
网络任务经 `/api/session/:id/prompt`、`delivery=queue` 提交，在消息历史中
确认任务归属和终态后才回执。普通通知暂时只记日志并 ack，**不在 V2 TUI 弹 toast**；
不要据此判断用户已看到通知，也不要通过伪造 user turn 来补 toast。

## V1 用户操作

创建并启动：

```bash
anet node create opencode-指挥狗 \
  --runtime opencode-cli \
  --mode copresence \
  --model opencode/north-mini-code-free

anet node start opencode-指挥狗 --copresence
tmux attach -t '=opencode-指挥狗'
```

离开 TUI 而不关节点：按 `Ctrl-b`，再按 `d`。

在 TUI 内可以直接要求节点通信，例如：

```text
请调用 commhub_send_message，给 通信牛 发送消息：测试完成。
请调用 commhub_send_task，给 通信龙 派任务：检查最新候选，并把结果回给我。
```

看到 TUI 中的 `⚙ commhub_send_message` / `⚙ commhub_send_task` 和 Hub 返回的成功 ID 才表示真正发送；只有模型口头说“已发送”不算成功。

停止：

```bash
anet node stop opencode-指挥狗
```

恢复时必须继续使用 `--copresence`；普通 `anet node start` 只启动任务 runtime，不会创建可进入的 TUI：

```bash
anet node start opencode-指挥狗 --copresence
```

每个节点使用两个精确 tmux 名称：

- `<alias>`：官方 OpenCode full attach TUI
- `<alias>-桥`：agent-node、loopback OpenCode server 和 CommHub SSE

`tmux` 默认接受会话名前缀，所以必须保留 attach 命令里的前导 `=`。如果
TUI 已退出但桥仍在线，`tmux attach -t <alias>` 会把 `<alias>` 模糊匹配到
`<alias>-桥`，看到的只是 agent-node 日志，并不是 OpenCode。精确命令
`tmux attach -t '=<alias>'` 会在 TUI 不存在时明确报错。

若只是误入桥，先按 `Ctrl-b`、`d` 离开，再用精确命令进入。若精确命令报告
TUI 不存在，可重新执行 `anet node start <alias> --copresence` 重建桥和 TUI；
不要用 `pkill -f`、`killall` 或模糊 tmux 匹配停止节点。

## V1 实现拓扑

`opencode-cli` 仍是一个 runtime，通过 `config.json` 的 `opencodeMode` 分派：

- `headless`：既有 ACP stdio runtime
- `copresence`：`opencode serve` + HTTP network turn + 官方 `opencode attach` TUI

共存模式只在 `127.0.0.1` 随机端口监听，使用每次启动随机生成的 Basic Auth 密码。agent-node 通过 `POST /session/:id/message` 把网络任务送进共享 session；人类 TUI 通过官方 `opencode attach` 连接同一个 session。共存模式不使用 ACP。

每次启动还会把当前节点的 CommHub ntok 绑定到一个私有 `commhub` remote MCP。TUI 使用 `commhub_send_message`、`commhub_send_task`、`commhub_get_task`、`commhub_get_all_status` 等工具主动出站；身份由 Hub 上的 node token 决定，提示词不能把节点伪装成其他 alias。节点配置的 `provider/model` 同时写入本次 OpenCode 私有配置，避免 attach TUI 回退到另一个默认模型后只输出伪工具标记而不执行。

CommHub 的两种入站语义保持分离：

- `send_task` / Dashboard 任务进入共享 session，运行模型，并把回答回传给发送方。
  共享 TUI 中的任务 user turn 固定带 `[来自 <发送者>]` 前缀；发送者取自
  CommHub 已认证消息元数据，并在显示前去控制字符、折叠空白、限制为 64 字符。
  这与普通消息的临时 toast 是两条不同链路，两者都必须单独验收。
- `send_message` / Dashboard 普通消息由 `new_message` SSE 立即唤醒，在 TUI 显示 15 秒通知并 ack；粗体标题直接显示 `Agent Network · 来自 <发送者>`，正文也保留 `[来自 <发送者>]` 前缀，因此发送者可在通知的两个位置识别。它不运行模型，也不写入 session 对话历史。任务处理和普通消息使用两条独立串行 drain，因此模型正在跑任务时，普通消息仍能立即显示。

两条 drain 的传输错误使用 1 秒起、最高 30 秒的指数退避重试。普通消息在 notify 成功后先记本进程 displayed-id，再尝试 ack；若 ack 响应丢失，重试只补 ack，不重复弹通知。Hub 已经提交 ack、但响应在网络中丢失时，下次 inbox 快照会清掉该 displayed-id。同一 inbox 快照会逐条尝试完再抛出首个错误，因此第一条消息 ack 持续失败时，后面的普通消息仍能显示，不会被它队头阻塞。持续失败期间，同一个 drain 的重复 SSE 唤醒会合并为一个 dirty rerun；成功前不会无限堆积 promise，成功边界新到的事件仍会补跑一次。

当前 agent-node 的共享 `get_inbox` 每次最多拉前 20 条，而且 Hub API
尚不支持按消息类型过滤。因此“任务正在运行时普通消息仍能立即显示”的
保证适用于普通消息已进入这 20 条快照的情况；若同一节点前面积压超过
20 条更高优先级任务，普通消息可能等到它进入快照后才显示。这是 preview
的已知队列窗口限制，不得宣称任意深度 backlog 下都有固定延迟上界。后续若
要消除此限制，应为 Hub 增加向后兼容、network-scoped 的 inbox type filter，
而不是改变所有运行时共享的全局优先级排序。

普通消息不能使用 OpenCode `noReply` user message 伪装通知：该 API 虽然当下不生成回答，却会留下未回答的 user turn，下一条真实任务可能把它一起回答，造成延迟误回复或 agent 间回复循环。

网络提交前读取 `/session/status`：已有 human/network turn 忙时排队，agent-node 内部的多条网络任务再经过 FIFO 串行化。固定版 OpenCode 1.18.1 在 idle 时实际返回空状态表；实现不会仅凭“缺状态条目”放行，而会再读 `/session/:id`，只有精确 session 仍存在时才按该固定版本的 idle 语义放行，缺 session、404 或未知状态形状都等到超时。

OpenCode 1.18.1 仍没有原子“空闲检查并认领”API，因此人类可能恰好在空闲检查后开始输入，这是 preview 的已知残余竞态。踩中时，human 与 network 两条内容可能被合并进同一个看似正常的 assistant reply，导致网络对端收到混合内容，或其中一个 turn 被另一个吃掉；看到回复混入另一条同时输入的内容时，应把该网络 turn 判为失败并重试，不能把结果当成可信完成。这里不能宣称强 lease。

启动也必须串行化：离线期间积压的普通消息会在注册后触发恢复 drain，它可能与主启动路径同时请求 OpenCode runtime。实现使用 single-flight 合并这些请求；否则一个 node 会生成两个 server/session，attach 脚本也会被后写者覆盖。

## 安全与生命周期

- V1 严格固定为 `opencode-ai@1.18.34`（#541 从 `1.18.1` 升上来）。过渡期已装 `1.18.1` 的主机仍可启动并提示升级；其他 V1 版本拒绝。V2 必须显式选择代际并满足上表中的包身份、版本和风险确认条件，不能当成 V1 的原位升级。
- 版本探针不接触 vendor credential；通过包身份校验后才生成一次性运行环境。
- TUI launcher 位于节点私有目录，mode 必须为 `0700`；它包含本次启动的 loopback 密码和 CommHub token export，不得复制、打印或提交。serve/attach 子进程也通过环境变量持有这些 secret；同 UID 用户与 root 可经 `/proc/<pid>/environ` 或进程环境读取，因此安全边界是“同 UID + 私有目录”，不是 secret 不进入 `/proc`/tmux 环境。
- CommHub token 只通过每节点私有环境变量交给 OpenCode；MCP 配置正文只保存 `{env:...}` 引用，不内嵌 token。每个节点必须独占自己的启动环境，不能共用 attach launcher 或 server。
- 安全模式固定 OpenCode 1.18.34(过渡期兼容 1.18.1)，并对该版本全部内建工具逐项 deny；动态工具只放行 `commhub_*`。OpenCode 会把对象形式 wildcard 规则移到最后，因此不能用尾部 `* = deny` 再期待较早的 MCP allow 生效。若未来放宽版本 pin，必须同时重新验证 wildcard 优先级并恢复可证明的默认 deny（或重新生成完整内建 deny 列表），不得直接沿用当前逐项列表。1.18.1 → 1.18.34 已按源码逐项比对(#541):环境变量开关、config 路径/managed config/指令发现、permission 模块、内建工具集合、serve/attach 参数与 session REST 路由均未变,逐项 deny 列表可沿用。
- server 使用 detached process group；停止前复核 PID、PGRP、Linux start ticks，身份漂移时拒绝误杀。
- `SIGINT`、`SIGTERM` 和 tmux 关闭 pane 使用的 `SIGHUP` 全部进入同一 cleanup；少了 `SIGHUP` 会在 `tmux kill-session` 后遗留 detached server。
- Linux OpenCode 共存的正常 `node stop` 应先给已记录且 birth 匹配的 agent 最多 10 秒完成清理，再关闭终端并审计残留进程；不要以直接关闭 tmux 替代正常停止。`test827` 同时检查生成的 registry observer 和 attach launcher 已消失，因为进程退出不代表私有启动文件清理完成。这一停止顺序修复仍须经过 main 合并/正式制品门，分支测试不代表已部署。
- 启动桥时显式传递 PATH、`ANET_AGENT_NODE_BIN` 和可选 `ANET_OPENCODE_SAFE_BASE`，不能依赖长期 tmux server 的陈旧环境。
- 节点模型必须以非空 `provider/model` 形式传入 REST message body；copresence 启动会拒绝空值或非法形式。只写顶层 anet config、却不传 REST model，会让 OpenCode 回退到 preset 默认模型，因此禁止静默回落。

## 测试与复现

正式套件：`tests/test227-opencode-tui-copresence/`。
并发/生命周期窄套件：`tests/test228-opencode-inbox-concurrency/`。
发送者可见性窄套件：`tests/test230-opencode-sender-label/`。
回复超时中止窄套件：`tests/test651-opencode-timeout-abort/`。
V2 后端及真实 TUI 窄套件：`tests/test543-opencode-v2-copresence/`。
V2 完整 CLI/Hub/打包 runtime/TUI 链路：`tests/test827-opencode-v2-hub/`。
后者只替换模型为 loopback stub，不替换 OpenCode、Hub 或 agent-node；
它不证明真实模型的工具选择，也不证明客户端/daemon 创建入口。

```bash
sg docker -c 'docker build -t anet-test227:dev \
  -f tests/test227-opencode-tui-copresence/Dockerfile .'

sg docker -c 'docker run --name anet-test227-run --rm \
  -v "$PWD/docs/tests:/report" anet-test227:dev'

sg docker -c 'docker rmi anet-test227:dev'
```

磁盘紧张时可先跑不安装 OpenCode 的窄套件：

```bash
sg docker -c 'docker build -t anet-test228:dev \
  -f tests/test228-opencode-inbox-concurrency/Dockerfile .'
sg docker -c 'docker run --rm \
  -v "$PWD/docs/tests:/report" anet-test228:dev'
sg docker -c 'docker rmi anet-test228:dev'
```

验收顺序：

1. process-group、FIFO、独立 work/informational drain、`new_message` SSE 与 inbox 接线单元层
2. CLI mode/tmux/陈旧环境接线层
3. loopback + 未认证 401 + launcher 0700
4. 真 OpenCode 1.18.1 使用 bearer 连接隔离假 CommHub MCP，并实际调用 `send_message`
5. full TUI 显示普通消息通知，且通知不污染下一条模型回复
6. 两条真实任务 turn 后 TUI/server 仍在线
7. busy task 未结束时普通消息先显示；把两条 drain 重新合并的 mutation 必须转红

证据：

- `docs/tests/report-test227.txt`
- `docs/tests/report-test227-live-uat.txt`
- `docs/tests/report-test228.txt`

## 接手坐标

主要文件：

- `agent-node/src/runtime/opencode-copresence/runtime.ts`
- `agent-node/src/runtime/opencode-copresence/process-group.ts`
- `agent-node/src/cli.ts`
- `agent-network/bin/cli.ts`
- `agent-node/src/runtime/opencode-copresence/runtime.test.ts`
- `agent-node/src/runtime/opencode-copresence/inbox-wiring.test.ts`
- `agent-node/src/runtime/inbox-drain-lane.ts`
- `agent-node/src/runtime/inbox-drain-lane.test.ts`
- `agent-node/src/util/single-flight.ts`
- `agent-node/src/util/single-flight.test.ts`
- `agent-network/src/opencode-copresence-cli.test.ts`

实机候选节点位于 `/home/vansin/opencode-tui-live`，tmux 为 `opencode-指挥狗` / `opencode-指挥狗-桥`。它使用隔离候选 agent-node，不修改全局 npm 包。

## 接第三方 OpenAI 兼容网关(2026-09-17 实测)

安全模式下 `renderSafeRuntimeConfig`(`agent-node/src/runtime/opencode-acp/child-env.ts`)只保留 `anthropic`/`openai` 两个 provider id 且 `options` 清空,子进程 env 白名单不含 `OPENAI_BASE_URL`;节点目录里的 `opencode.json` 加 baseURL 会在下次 start 被丢掉。可行路径:`flags.opencodeUnsafeTools=true`(不再设 `OPENCODE_DISABLE_PROJECT_CONFIG`,工作区根目录 `opencode.json` 生效)+ `provider.anthropic.options.baseURL` + `provider.anthropic.models.<model>` + `--model anthropic/<model>`。`openai` preset 走 Responses API,兼容网关通常 500;自定义 provider id 被凭据白名单剥掉;内置 id 的 `npm` 不可覆盖。
部署前置:`opencode-ai@1.18.34` 装在 umask 0022 的独立前缀;无 `/run/user/<uid>` 时用 `ANET_OPENCODE_SAFE_BASE` 指 0700 且父目录不带组写位、不在 `$HOME` 下的目录;agent-node 必须是所用 anet 的精确配对版本。
