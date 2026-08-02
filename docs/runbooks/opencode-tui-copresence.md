# OpenCode TUI 共存运行手册

状态：候选已实现并通过 Docker + 实机验收，尚未合并或发布。已发布的 npm `latest` 不含本功能；当前 preview 包也要等本候选正式发布后才可使用以下一等命令。

## 用户操作

发布后创建并启动：

```bash
anet node create opencode-指挥狗 \
  --runtime opencode-cli \
  --mode copresence \
  --model opencode/north-mini-code-free

anet node start opencode-指挥狗 --copresence
tmux attach -t opencode-指挥狗
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

不要用 `pkill -f`、`killall` 或模糊 tmux 匹配停止节点。

## 实现拓扑

`opencode-cli` 仍是一个 runtime，通过 `config.json` 的 `opencodeMode` 分派：

- `headless`：既有 ACP stdio runtime
- `copresence`：`opencode serve` + HTTP network turn + 官方 `opencode attach` TUI

共存模式只在 `127.0.0.1` 随机端口监听，使用每次启动随机生成的 Basic Auth 密码。agent-node 通过 `POST /session/:id/message` 把网络任务送进共享 session；人类 TUI 通过官方 `opencode attach` 连接同一个 session。共存模式不使用 ACP。

每次启动还会把当前节点的 CommHub ntok 绑定到一个私有 `commhub` remote MCP。TUI 使用 `commhub_send_message`、`commhub_send_task`、`commhub_get_task`、`commhub_get_all_status` 等工具主动出站；身份由 Hub 上的 node token 决定，提示词不能把节点伪装成其他 alias。节点配置的 `provider/model` 同时写入本次 OpenCode 私有配置，避免 attach TUI 回退到另一个默认模型后只输出伪工具标记而不执行。

CommHub 的两种入站语义保持分离：

- `send_task` / Dashboard 任务进入共享 session，运行模型，并把回答回传给发送方。
- `send_message` / Dashboard 普通消息由 `new_message` SSE 立即唤醒，在 TUI 显示 15 秒通知并 ack；它不运行模型，也不写入 session 对话历史。任务处理和普通消息使用两条独立串行 drain，因此模型正在跑任务时，普通消息仍能立即显示。

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

- OpenCode 版本严格固定为 `opencode-ai@1.18.1`。
- 版本探针不接触 vendor credential；通过包身份校验后才生成一次性运行环境。
- TUI launcher 位于节点私有目录，mode 必须为 `0700`；它包含本次启动的 loopback 密码和 CommHub token export，不得复制、打印或提交。serve/attach 子进程也通过环境变量持有这些 secret；同 UID 用户与 root 可经 `/proc/<pid>/environ` 或进程环境读取，因此安全边界是“同 UID + 私有目录”，不是 secret 不进入 `/proc`/tmux 环境。
- CommHub token 只通过每节点私有环境变量交给 OpenCode；MCP 配置正文只保存 `{env:...}` 引用，不内嵌 token。每个节点必须独占自己的启动环境，不能共用 attach launcher 或 server。
- 安全模式固定 OpenCode 1.18.1，并对该版本全部内建工具逐项 deny；动态工具只放行 `commhub_*`。OpenCode 会把对象形式 wildcard 规则移到最后，因此不能用尾部 `* = deny` 再期待较早的 MCP allow 生效。若未来放宽版本 pin，必须同时重新验证 wildcard 优先级并恢复可证明的默认 deny（或重新生成完整内建 deny 列表），不得直接沿用当前逐项列表。
- server 使用 detached process group；停止前复核 PID、PGRP、Linux start ticks，身份漂移时拒绝误杀。
- `SIGINT`、`SIGTERM` 和 tmux 关闭 pane 使用的 `SIGHUP` 全部进入同一 cleanup；少了 `SIGHUP` 会在 `tmux kill-session` 后遗留 detached server。
- 启动桥时显式传递 PATH、`ANET_AGENT_NODE_BIN` 和可选 `ANET_OPENCODE_SAFE_BASE`，不能依赖长期 tmux server 的陈旧环境。
- 节点模型必须以非空 `provider/model` 形式传入 REST message body；copresence 启动会拒绝空值或非法形式。只写顶层 anet config、却不传 REST model，会让 OpenCode 回退到 preset 默认模型，因此禁止静默回落。

## 测试与复现

正式套件：`tests/test227-opencode-tui-copresence/`。
并发/生命周期窄套件：`tests/test228-opencode-inbox-concurrency/`。

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
