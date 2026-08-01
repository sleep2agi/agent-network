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
- `send_message` / Dashboard 普通消息由 `new_message` SSE 立即唤醒，在 TUI 显示 15 秒通知并 ack；它不运行模型，也不写入 session 对话历史。

普通消息不能使用 OpenCode `noReply` user message 伪装通知：该 API 虽然当下不生成回答，却会留下未回答的 user turn，下一条真实任务可能把它一起回答，造成延迟误回复或 agent 间回复循环。

网络提交前读取 `/session/status`：已有 human/network turn 忙时排队，agent-node 内部的多条网络任务再经过 FIFO 串行化。OpenCode 1.18.1 仍没有原子“空闲检查并认领”API，因此人类可能恰好在空闲检查后开始输入；这是已知 preview 并发竞态，不能宣称强 lease。

## 安全与生命周期

- OpenCode 版本严格固定为 `opencode-ai@1.18.1`。
- 版本探针不接触 vendor credential；通过包身份校验后才生成一次性运行环境。
- TUI launcher 位于节点私有目录，mode 必须为 `0700`；它包含本次启动的 loopback 密码，不得复制、打印或提交。
- CommHub token 只通过每节点私有环境变量交给 OpenCode；MCP 配置正文只保存 `{env:...}` 引用，不内嵌 token。
- 安全模式固定 OpenCode 1.18.1，并对该版本全部内建工具逐项 deny；动态工具只放行 `commhub_*`。OpenCode 会把对象形式 wildcard 规则移到最后，因此不能用尾部 `* = deny` 再期待较早的 MCP allow 生效。
- server 使用 detached process group；停止前复核 PID、PGRP、Linux start ticks，身份漂移时拒绝误杀。
- 启动桥时显式传递 PATH、`ANET_AGENT_NODE_BIN` 和可选 `ANET_OPENCODE_SAFE_BASE`，不能依赖长期 tmux server 的陈旧环境。
- 节点模型必须以 `provider/model` 形式传入 REST message body；只写顶层 anet config、却不传 REST model，会让 OpenCode 回退到 preset 默认模型。

## 测试与复现

正式套件：`tests/test227-opencode-tui-copresence/`。

```bash
sg docker -c 'docker build -t anet-test227:dev \
  -f tests/test227-opencode-tui-copresence/Dockerfile .'

sg docker -c 'docker run --name anet-test227-run --rm \
  -v "$PWD/docs/tests:/report" anet-test227:dev'

sg docker -c 'docker rmi anet-test227:dev'
```

验收顺序：

1. process-group、FIFO、`new_message` SSE 与 inbox 接线单元层
2. CLI mode/tmux/陈旧环境接线层
3. loopback + 未认证 401 + launcher 0700
4. 真 OpenCode 1.18.1 使用 bearer 连接隔离假 CommHub MCP，并实际调用 `send_message`
5. full TUI 显示普通消息通知，且通知不污染下一条模型回复
6. 两条真实任务 turn 后 TUI/server 仍在线

证据：

- `docs/tests/report-test227.txt`
- `docs/tests/report-test227-live-uat.txt`

## 接手坐标

主要文件：

- `agent-node/src/runtime/opencode-copresence/runtime.ts`
- `agent-node/src/runtime/opencode-copresence/process-group.ts`
- `agent-node/src/cli.ts`
- `agent-network/bin/cli.ts`
- `agent-node/src/runtime/opencode-copresence/runtime.test.ts`
- `agent-node/src/runtime/opencode-copresence/inbox-wiring.test.ts`
- `agent-network/src/opencode-copresence-cli.test.ts`

实机候选节点位于 `/home/vansin/opencode-tui-live`，tmux 为 `opencode-指挥狗` / `opencode-指挥狗-桥`。它使用隔离候选 agent-node，不修改全局 npm 包。
