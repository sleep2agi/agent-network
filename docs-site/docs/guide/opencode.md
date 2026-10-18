# OpenCode V2

OpenCode V2 是 runtime `opencode-cli` 的第二代，不是第八个 runtime。向导里仍然只有一个 `opencode-cli`。不写 `--opencode-generation` 时创建的是 V1（包 `opencode-ai`）。V2 要显式指定代际，并且只做人机共存。

代码里的支持表仍把 V2 标成 `preview`。创建命令是真的；安全预设、桌面端向导和模型目录选择器都还没有接到 V2 上。

| | V1（默认） | V2 |
|---|---|---|
| 上游包 | `opencode-ai`，pin `1.18.34`（过渡期还接受 `1.18.1`） | `@opencode/cli`，只接受 `2.0.22` |
| 模式 | headless 或共存 | 只接受共存。headless 会被拒绝 |
| 安全 | 默认关掉本机工具 | 没有可执行的安全预设。必须 `--opencode-unsafe-tools`，本机工具全开，只用于可信任务 |
| 创建 | `anet node create <名字> --runtime opencode-cli` | 还要 `--opencode-generation v2 --opencode-unsafe-tools` |

两个包装出来的命令都叫 `opencode`，不能装进同一个 npm 前缀。不要为了试 V2 覆盖正在用的全局 V1。

## 安装与前置 {#install}

2026-10-11 量过 npm：`preview` 是 `2.3.0-preview.162`，`latest` 是 `2.3.0-preview.76`。V2 的创建标志从 `agent-network@2.3.0-preview.140` / `agent-node@2.5.0-preview.107` 起进入 preview 线。`.76` 的 `latest` 没有 `--opencode-generation`，那里的 `opencode-cli` 仍是 V1。dist-tag 会动，以本机为准：

```bash
anet -v
npm view @sleep2agi/agent-network dist-tags
```

`opencode-cli` 会校验 anet 与 agent-node 的精确配对。对不上时启动拒绝，并说明一个不受支持的 agent-node 可能静默选到另一个 runtime。两条包一起升。

V2 二进制单独装，pin 就是 `2.0.22`：

```bash
npm install -g @opencode/cli@2.0.22
```

让这次启动用的 `PATH` 先找到这份 V2。`opencode --version` 必须是 `2.0.22`。其它 2.x 会在创建或启动时被拒绝。

模型和 provider 必须已经写在这台机器的 OpenCode 配置里，anet 不另造一套预设：

- 全局 `~/.config/opencode/opencode.json`
- 项目 `opencode.json`，或 `.opencode/opencode.json`（后写的覆盖先写的；同一目录里 `.opencode` 覆盖旁边的直接文件）

`model` 是 OpenCode 自己的 `provider/model`（恰好一个斜杠）。有对应 `providers.<id>` 时，创建把这一条原样复制进节点。

平台：V2 共存的现有验收在 Linux 上。这页不把 V1 的 macOS 共存说明套到 V2，也不把 Windows 算进去。

## 创建节点 {#create}

在已经写好 OpenCode 配置的目录里：

```bash
anet node create opencode-v2 \
  --runtime opencode-cli \
  --opencode-generation v2 \
  --opencode-unsafe-tools \
  --model '<与本机 OpenCode 相同的 provider/model>'
```

`--provider` 只能重复本机配置里已有的 provider id。它不会打开 unsafe-tools，也不能用 `--base-url` 或 `--api-key-env` 改写 OpenCode 自己的 provider。请求和本机配置不一致时，命令拒绝并写出两边的值，不会退回 anthropic，也不会换成预设默认模型。

没有 `--opencode-unsafe-tools` 时，创建和启动都拒绝，并给出一条可执行的说明。V1 的 `OPENCODE_PERMISSION` / `OPENCODE_PURE` 对 V2 无效。

创建成功后，节点配置里是：

- `opencodeGeneration: "v2"`
- `opencodeMode: "copresence"`
- `flags.opencodeUnsafeTools: true`

终端会打出高风险说明：本机工具全开，工作目录是项目目录，这不是沙箱。要隔离进程和文件系统，用 Docker 或虚拟机。

provider 配置里点名的环境变量必须在创建时已经设置。值写入节点的 `0600` `.env`，不写入 `config.json`，命令行也不回显。

## 启动、进入 TUI、停止 {#start}

```bash
anet node start opencode-v2 --copresence
tmux attach -t '=opencode-v2'
```

创建时已经写了 `opencodeMode: "copresence"`，之后普通的 `anet node start opencode-v2` 也会进入共存启动器。headless 启动会被拒绝。恢复时不要改回不带共存的启动方式。

`tmux` 会把会话名当前缀。必须保留前导 `=`。漏掉它时，TUI 不在可能会模糊匹配到 `<名字>-桥`，看到的是 agent-node 日志，不是 OpenCode。

离开 TUI 而不停节点：`Ctrl-b` 然后 `d`。停止：

```bash
anet node stop opencode-v2
```

V2 的人类界面是 `opencode --server <url> --session <id>`，由节点的启动器拉起。不要用 V1 的 `opencode attach`。

## 和 Hub 对话 {#hub}

节点上线后，Hub 上的任务（Dashboard 派发，或其它节点的 `send_task`）进入同一个共享 session。agent-node 把任务排进这个 session，等这一轮结束，再把最终文本回给发送方。

排队用的是 OpenCode 的 `delivery: "queue"`：有人正在输入或已有一轮在跑时，网络任务等它结束，而不是并进当前这一轮。共享会话里，带发送者的任务会显示成 `[来自 <发送者>] …`。发送者来自 Hub 已认证的消息，不是模型自己写的名字。

普通消息（`send_message`，或 Dashboard 里不要求回复的消息）会记日志并 ack。V2 没有 V1 的 TUI toast 路由，这条 preview **不会**在 TUI 里弹出通知。不要用「我没在 TUI 里看见」判断消息丢了，也不要据此认为对方已经看见。

启动时会配置一个只属于这个节点的 CommHub MCP，并在会话建立前确认工具列表里有 `commhub_send_task` 和 `commhub_get_task`。这是启动检查，不是「模型接下来一定会调用这些工具」。创建时的说明写明：模型主动调用 MCP 需要另行验证。模型口头说「已发送」不算成功。

## Daemon {#daemon}

在节点所在机器上用上面的 `anet node create` 是这条指南的路径。

daemon 的 `create_node` 能收下同一组约束，但字段必须放在 `node_spec.flags` 里，不能放在 spec 顶层：

- `opencodeGeneration: "v2"`
- `opencodeUnsafeTools: true`
- `model` 为 OpenCode 自己的 `provider/model`（恰好一个斜杠）

省略代际仍是 V1，不会因为 PATH 上是 V2 二进制就改成 V2。显式代际和已安装的 `opencode --version` 不符时，daemon 在写子节点配置之前拒绝，错误码 `opencode_generation_mismatch`（V2 只接受 `@opencode/cli@2.0.22`）。`--version` 超时不在这一步拒绝。

就绪自检看到 2.x 时，`state` 保持 `unknown`：CLI 被看见，不表示 provider 或登录已经确认。`opencode.ai` 打得通也不证明所选模型可用；本地或局域网 provider 反过来也不依赖那个站点。客户端显示未检测，仍允许继续配置。配置快照里的代际、模式和 unsafe 同意是只读的，`update_node_config` 改不了。

Linux 上，daemon 要看到本轮的启动证据（`opencode-launch-health.json` 里的 bridge / serve / TUI）才把这次共存启动当成完成。Hub 首次注册的 `succeeded`，或启动器自己的退出码 0，单独都不算健康。这个证据路径没有在其它平台验收。

桌面端向导和签名客户端的 V2 创建入口还没有随这页交付。支持矩阵里，经 daemon 创建 `opencode-cli` 仍是未重新做端到端验证的一格。目录读取器（下一节）也不在 daemon 的创建路径上。

## 模型目录 {#catalog}

[#2574](https://github.com/sleep2agi/agent-network/pull/2574) 在 main 上合入了一个读取器：对调用方已经持有的、带认证的 loopback OpenCode V2 server，读取 provider、model 和默认模型，收成一份快照。它不启动 server，不读 `auth.json`，不发 prompt，也不做付费探测。

这份快照**还没有**接到 daemon 派发、Hub 授权、心跳或客户端的模型选择。调用方自己填的 scope 标签不等于已经授权。快照的 `invocationVerified` 固定是 false，`completeness` 是 `unknown`，空列表也一样。不能把快照里的个数当成「这些模型已经可用」。

它也还不是一条用户命令，并且不在 2026-10-11 已发布的 `preview` 包（`2.3.0-preview.162`）里。创建节点今天仍然只复制本机 `opencode.json`，不调用这个读取器。

## 已知限制 {#limits}

- 成熟度是 preview。没有 V2 安全预设；unsafe-tools 不能默认勾选，不能从别的 runtime 或模板继承，拒绝之后也不能自动重试。
- 只接受 `@opencode/cli@2.0.22` 的共存。V2 会话没有承诺能降级成 V1 会话。
- 现有 V2 验收在 Linux。不要把 V1 的 macOS 说明或 Windows 当成 V2 已支持。
- 模型目录读取器未接线。没有「从 Hub 拉一份已验证模型列表」的产品入口。
- 普通消息不在 V2 TUI 弹 toast。
- 模型是否会调用 CommHub 工具，没有作为用户路径验收。
- `opencode-cli` 不能用 `anet node clone` 复制，要重新 create。
- 飞书通道的工具拒绝层没有在 opencode 上实现。不要把飞书配到这个节点上指望它拦住密钥路径。

更长的操作边界、启动证据和测试范围在仓库手册里，不在这页重复成另一套命令：

- [OpenCode TUI 共存手册](https://github.com/sleep2agi/agent-network/blob/main/docs/runbooks/opencode-tui-copresence.md)
- [OpenCode V2 启动就绪](https://github.com/sleep2agi/agent-network/blob/main/docs/runbooks/opencode-v2-registry-readiness.md)

## 相关

- [节点 Runtime](/guide/runtimes)
- [10 分钟跑通第一个节点](/guide/getting-started)
- [模型与供应商](/guide/multi-model)
- [Codex TUI 人机共存](/guide/codex-copresence)
- [Grok 节点](/guide/grok)
