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

网络提交前读取 `/session/status`：已有 human/network turn 忙时排队，agent-node 内部的多条网络任务再经过 FIFO 串行化。OpenCode 1.18.1 仍没有原子“空闲检查并认领”API，因此人类可能恰好在空闲检查后开始输入；这是已知 preview 并发竞态，不能宣称强 lease。

## 安全与生命周期

- OpenCode 版本严格固定为 `opencode-ai@1.18.1`。
- 版本探针不接触 vendor credential；通过包身份校验后才生成一次性运行环境。
- TUI launcher 位于节点私有目录，mode 必须为 `0700`；它包含本次启动的 loopback 密码，不得复制、打印或提交。
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

1. process-group 与 FIFO 单元层
2. CLI mode/tmux/陈旧环境接线层
3. loopback + 未认证 401 + launcher 0700
4. 真 OpenCode 1.18.1 full TUI 显示网络 turn
5. 第二条 turn 后 TUI/server 仍在线

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
- `agent-network/src/opencode-copresence-cli.test.ts`

实机候选节点位于 `/home/vansin/opencode-tui-live`，tmux 为 `opencode-指挥狗` / `opencode-指挥狗-桥`。它使用隔离候选 agent-node，不修改全局 npm 包。
