# Grok 节点

Agent Network 有两种跑 Grok 的节点：

| 模式 | runtime | 状态 | 适合 |
|---|---|---|---|
| **ACP（推荐，默认）** | `grok-build-acp` | 正式 | 无人值守、稳定接网络任务 |
| 共存 TUI | `grok-build-cli` | **实验** | 人和网络任务共用同一个 Grok TUI |

没有特别理由，就用 `grok-build-acp`。共存 TUI 适合「人要坐在终端前一起看、一起打字」的场景，但它有下面列出的已知限制。

## 推荐：`grok-build-acp` {#acp}

节点 spawn 本机 `grok agent stdio`，通过 Agent Client Protocol 执行网络任务，复用本机 Grok 登录态。它是 headless 的，**不能 attach 到 TUI**。

前置：

- 本机已装 Grok Build CLI 并完成 `grok login`
- 已设环境变量 `GROK_CODE_XAI_API_KEY`
- Hub 已启动、已登录（见[上手指南](/guide/getting-started)）

```bash
grok login
anet node create my-grok --runtime grok-build-acp
anet node start my-grok
```

长任务超时（默认 5 分钟）、每节点独立工作目录等细节见 [Runtime → grok-build-acp](/guide/runtimes#grok-build-acp)。

**项目技能**：ACP 节点会加载项目根的 `.agents/skills/<name>/SKILL.md`，但技能清单在 grok session 创建时定格。新增或修改技能后：停节点 → 删掉 `.anet/nodes/<name>/config.json` 里的 `grokSession`（和 `session`）→ 起节点。

**经代理出网**：ACP 路径会把 shell 里的 `HTTP(S)_PROXY` 原样传给 grok。公司代理到 `*.x.ai` / `*.grok.com` 不通时，ACP initialize 会一直不返回，stderr 只有 `Settings fetch failed`。设 `NO_PROXY="x.ai,.x.ai,grok.com,.grok.com,localhost,127.0.0.1"`，让这些域名走主机侧直连或中继（见下文[出网受限](#egress)）。`NO_PROXY` 里的 CIDR 对字面量 IP 不生效，要另补字面量。

## 实验：共存 TUI（`grok-build-cli`） {#copresence}

::: warning 实验能力，已知限制
- 人在 TUI 输入框里有字时，网络任务只会排队，超时后失败。
- 共存只接受**已验证的 grok build**（当前为 `0.2.93 (f00f96316d)` 与 `1.0.5 (5115b46bc909)`，以报错里列出的清单为准）。grok 自更新到清单外的版本后，节点**下一次重启**起不来；报错会给出 `GROK_BINARY=<已验证的旧版本> anet node start <节点>` 恢复命令。
- 共存 TUI 不加载项目技能，也不能开 always-approve。
- 已随 npm 发布包提供（`latest` 与 `preview` 通道都有，`anet --help` 的「Grok co-presence」一节会列出），但不作为默认推荐。
:::

`grok-build-cli` 让一个节点持有唯一的真实 Grok TUI。你从另一个终端用 `anet grok attach` 进入同一界面；CommHub 网络任务排队进入同一会话。人类输入优先，网络任务按 FIFO 执行。

### 前置

- Linux、macOS 或 WSL；已装 Node.js、Bun 和原生 `node-pty` 依赖
- Grok Build CLI 已安装并登录，`grok --version` 在已验证清单内
- npm 安装的 `anet` 与 `agent-node`（`anet --help` 里能看到 `grok-build-cli` 与 `anet grok attach`）；只有要跑未发布的源码改动时才需要从源码构建

::: details 从源码构建（开发者）
```bash
cd agent-node && bun install && npm run build
cd ../agent-network && bun install && npm run build && cd ..

export ANET_SOURCE=/绝对路径/agent-network
export ANET_AGENT_NODE_BIN="$ANET_SOURCE/agent-node/dist/cli.js"
anet() { bun "$ANET_SOURCE/agent-network/dist/bin/cli.js" "$@"; }
```

报 `Installed agent-node does not support grok-build-cli` 时，说明调用的 agent-node 不支持共存，或 `ANET_AGENT_NODE_BIN` 指错了，把它设为 `dist/cli.js` 的绝对路径。
:::

### 启动与连接

```bash
# 终端 1：创建并持续运行节点
anet node create grok-demo --runtime grok-build-cli
anet node start grok-demo
```

（anet 2.3.0-preview.116 起也可以写成 `--runtime grok --copresence`，效果相同。）

看到下面这行说明 TUI 已就绪：

```text
[grok-copresence] ...; attach with anet grok attach grok-demo
```

```bash
# 终端 2：在节点工作目录下连接同一个 TUI
anet grok attach grok-demo
```

- `Ctrl-]` 只断开当前终端，不会停止节点或 Grok 会话。同一时间只允许一个人类终端连接。
- `anet grok attach` 必须在节点的工作目录下、在交互式终端里执行（不能 pipe 或重定向）。
- 网络任务在 TUI 里显示为 `[Agent Network/from=<发送者>/task=<任务 ID>] <消息>`。普通对话不会自动发到网络，只有明确的委派指令（如 `给 reviewer 发任务: 检查当前改动`）才会派发。
- 权限弹窗只由已连接的人类处理：Enter 单次允许，`Ctrl-C` 拒绝。运行时不会替你选永久允许。

### 停止、恢复与换模型

```bash
anet node stop grok-demo
anet node start grok-demo      # 恢复同一个 grokCliSession
```

运行时不会静默切到 headless，也不会猜另一个会话。进程在网络任务执行中崩溃时，该任务失败而不会自动重放。

换模型有两条安全路径：

- TUI 里直接输入 `/model <模型名>`（agent-node ≥ `2.5.0-preview.45`）：干净的单参数 `/model` 会被代为执行，结果答在 TUI 里；其他行首斜杠命令默认被拦截。
- 另开终端 `anet grok model <节点> <模型名>`：任意版本可用，attach 着也能切。

需要每个任务单独起无界面 Grok 进程时，可用旧 headless 模式：`anet node create grok-headless --runtime grok-build-cli --grok-headless`（不能 attach）。

### 名册显示 `blocked`

agent-node ≥ `2.5.0-preview.57` 时，`blocked` 表示 TUI 子进程、composer 就绪或 `attach.sock` 有问题，值得去查。更早的版本在 grok 1.0.5（按设计不创建 `leader.sock`）上会恒显示 `blocked`，此时以节点日志为准：有 `injected network task` / `processTask returned` 就说明运行时正常。

升级 agent-node 后必须重启节点，liveness 在长驻进程内计算。重启前先 `grok --version`：`PATH` 上的 grok 若已不在验证清单内，节点一重启就会被拒绝启动，而在跑的节点看起来一切正常。旧版二进制通常还在 `~/.grok/downloads/`，可以用 `GROK_BINARY=~/.grok/downloads/grok-<已验证版本>-<平台> anet node start <name>` 起。

### 出网受限的机器 {#egress}

共存运行时给 grok 子进程的环境是固定白名单，`HTTP(S)_PROXY` 一律剥掉，所以给节点设代理变量没用。可行的是主机侧方案：`/etc/hosts` 把 `auth.x.ai`、`api.x.ai`、`cli-chat-proxy.grok.com`、`code.grok.com` 指到本机，本机跑一个按 SNI 转发的 443 中继，再经公司代理出网。先用 `curl --connect-to auth.x.ai:443:127.0.0.1:443 https://auth.x.ai/.well-known/openid-configuration` 验中继，再看节点能否回 Hub 的探针；前者通过不等于后者通过。`GROK_OIDC_ISSUER` 是企业 IdP 覆盖，不是代理。

### 常见问题

**版本过旧或不匹配**：装到清单内的版本再启动，不要绕过版本检查。别让 grok 的 `auto_update` 把它升出清单：用 `GROK_BINARY` 钉住已验证 build，或在节点私有 `GROK_HOME` 里关掉 `auto_update`。

**已有的裸 grok 会话不能直接变共存**：共存运行时强制沙箱档，grok 会拒绝跨档 resume（`cannot resume this session under sandbox profile … it was created with 'off'`）。可移植做法：把旧会话目录 `sessions/<cwd-key>/<old-id>/` 整个复制成一个新 UUID 并删掉 `*.lock`；把克隆件 `summary.json` 的 `sandbox_profile` 从 `"off"` 改成节点当前的 workspace 档（形如 `anet-<hash>-workspace`）；节点 config 的 `grokCliSession` 指向新 id 后重启。原会话不受影响。

**报 `cannot resume missing session <id>`**：`grokCliSession` 指向的会话目录已不在。运行时故意不自动新建（会静默丢掉历史）。删掉 `.anet/nodes/<name>/config.json` 里的 `grokCliSession` 再 `anet node start`，会新建会话并写回新 id。

**工作目录里出现 5 个 0 字节文件**（`.grok` `.claude` `.cursor` `.mcp.json` `.envrc`）：这是 grok 启动时种下的读拒绝占位，`anet node stop` 只回收 mode 为 `0444` 的这五个文件。部分主机上 grok 1.0.5 会把它们种成 `0666`，每次 stop 都会报 `refuses post-stop project placeholder` 并在下次 start 报 `expected a real directory`。处置：stop 后执行 `chmod 0444 .grok .claude .cursor .mcp.json .envrc` 再起（agent-node ≥ `2.5.0-preview.70` 的报错里直接带这条命令）。

**`bwrap exec failed` / 提示 `apt install -y bubblewrap`**：dnf/yum 系统装 `bubblewrap` 的 rpm 即可（`sudo dnf install -y bubblewrap`）。

**启动时报 `<hub> did not answer /health within 2000ms`**：跨公网连 Hub 时出现。`2.3.0-preview.92` 起非 loopback Hub 默认等 10 秒，并可用 `ANET_HUB_HEALTH_TIMEOUT_MS=<1000–60000>` 覆盖；更早的版本升级即可。

**TUI 停在 `Login with Grok`**：共存节点复用本机 `grok login` 的登录态（`~/.grok/`）。登录要能直连 `auth.x.ai` / `api.x.ai` / `grok.com`。不要把别的机器的 `~/.grok/auth.json` 拷过来，登录态绑定机器与账号。

**能不能开 always-approve**：不能。共存 TUI 里任何人派的任务都直达这个会话，审批必须留在 TUI 前的人手里；`flags.dangerouslySkipPermissions: true` 会直接拒起。要让 grok 自主改文件、跑命令，另建一个 `grok-build-acp` 节点。

## 相关

- [节点 Runtime](/guide/runtimes)
- [Codex TUI 人机共存](/guide/codex-copresence)
- [完整 Grok Build Runtime 说明](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md)（实现、安全边界与 Docker 验证）
