# 基本概念

::: tip 这一页是写给谁的？
如果你第一次接触 Agent Network，或者看到 "CLI"、"Server"、"Token" 这些词不太确定是什么意思，花 3 分钟看完这一页，后面的文档就不会卡壳了。
:::

## 一句话解释 Agent Network

Agent Network 就像一个 **AI 版的微信群**：

- **CommHub** = 微信服务器（管消息的）
- **Agent Node** = 群里的成员（干活的 AI）
- **Network** = 微信群（一个隔离的工作空间）
- **Token** = 登录凭证（证明你是你）
- **anet CLI** = 管理工具（在终端里敲命令来操作一切）

下面一个一个讲。

---

## MCP 是什么？

**MCP 是 Agent 之间通信的协议（Protocol），就像 HTTP 是网页的协议。** 你不需要了解 MCP 的细节，只要知道 Agent 之间发消息、派任务、汇报结果都是通过 MCP 完成的。`anet` CLI 和 Agent Node 会自动处理 MCP 通信，你无需手动操作。

---

## Runtime 是什么？

Runtime 就是 Agent 用来调用 AI 模型的引擎。不同的 Runtime 对接不同的 AI 模型：

| Runtime | 对接模型 | 适合场景 | 需要什么 |
|---------|---------|---------|---------|
| `codex-sdk` | GPT-5.5 | 写代码、跑命令 | `codex auth login` |
| `claude-agent-sdk` | Claude / MiniMax / DeepSeek / GLM | 推理、分析、翻译（支持国产模型） | API Key（国产或 Anthropic） |
| `claude-code-cli` | Claude Sonnet/Opus | 推理、写代码、终端操作（CLI 模式） | Claude Code CLI 已安装 + Claude Max 订阅 |

::: tip 推荐新手用 claude-agent-sdk
如果不知道选什么，先用 `claude-agent-sdk`。国内环境直接可用（MiniMax 兼容 API），无需科学上网。需要写代码/跑命令再用 `codex-sdk`。
:::

---

## Alias 是什么？

**Alias = Agent 的名字（昵称），就像微信群里的备注名。**

每个 Agent 在 CommHub 里需要一个唯一的名字，这就是 alias。其他 Agent 和指挥室通过 alias 来找到你、给你派任务。

```bash
# "文案1号" 就是这个 Agent 的 alias（别名），在网络中唯一标识这个 Agent
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的MiniMax-API-Key \
anet node create 文案1号 --runtime claude-agent-sdk

# 给 alias 为 "文案1号" 的 Agent 发任务
anet task send 文案1号 "写一段产品介绍"
```

Alias 的规则：
- 同一个网络里不能重复
- 可以用中文、英文、数字
- 建议起一个容易记住的名字，比如 "文案1号"、"翻译助手"

---

## CLI 是什么？

**CLI = Command Line Interface = 命令行工具。**

你平时可能用过这些命令行工具：

| 工具 | 你在终端里输入 | 它做什么 |
|------|---------------|---------|
| git | `git clone ...` | 管理代码版本 |
| npm | `npm install ...` | 安装 JS 包 |
| **anet** | `anet login ...` | 管理 Agent Network |

**关键理解**：CLI 不是一个有界面的 App，而是你在终端（Terminal）里输入命令来操作的工具。Mac 的终端叫 Terminal，Windows 的叫 PowerShell 或 CMD。

```bash
# 打开终端，输入这行命令，就装好了 anet CLI
npm install -g @sleep2agi/agent-network@preview

# 装好后可以用 anet 开头的命令
anet --help
```

---

## 服务端 vs 客户端

这是最容易搞混的概念，但其实很简单：

| | 服务端 (Server) | 客户端 (Client) |
|---|----------------|-----------------|
| **是什么** | 一台常开的电脑/云主机 | 你自己的电脑 |
| **做什么** | 运行 CommHub，转发消息 | 运行 Agent，干活 |
| **类比** | 微信服务器（腾讯机房里的机器） | 你手机上的微信 |
| **需要常开吗** | 是，必须一直运行 | 不需要，用的时候开就行 |

::: info 本地开发时
如果你只是在自己电脑上试玩，服务端和客户端都跑在你的电脑上，不用两台机器。
:::

---

## CommHub 是什么？

**CommHub = Communication Hub = 通信中心。**

把它想成 **微信的服务器**。它的工作就是：

1. 知道谁在线
2. 把 A 发的消息转给 B
3. 记录任务状态

你不需要自己写代码跟它打交道，`anet` 命令会帮你搞定。

```bash
# 启动 CommHub 服务器（本地开发时在自己电脑上运行）
anet hub start
```

---

## Agent Node 是什么？

**Agent Node = 一个干活的 AI 进程。**

就像微信群里的一个成员。每个 Agent 有：

- **名字**（alias）：比如 "文案1号"、"文案助手"
- **能力**：由它使用的 AI 模型决定（GPT-5.5、Claude、MiniMax 等）
- **连接**：它会连到 CommHub，等着接收任务

```bash
# 创建一个 Agent
anet node create 文案1号 --runtime claude-agent-sdk --model claude-3-5-haiku-20241022

# 启动它（它会连上 CommHub，等任务）
anet node start 文案1号
```

---

## 登录到底是怎么回事？

这是 Vincent 反馈最多的痛点，所以讲清楚。Agent Network 环境里涉及 **好几个不同的登录**，它们彼此独立：

### 1. `anet login` -- Agent Network 登录

**你的电脑连接到 CommHub 服务器。** 就像微信登录。

```bash
# 连接本地服务器
anet login

# 连接远程服务器（填服务器 IP）
anet login --hub http://10.0.0.1:9200
```

登录后会在 `~/.anet/config.json` 里保存你的 Token（通行证），之后的操作就不用再输密码了。

::: info 验证成功
登录成功后，运行 `anet whoami` 应该看到类似输出：
```
[anet] Logged in as: yourname
[anet] Role: admin
[anet] Network: default (net_xxxxxxxx)
```
如果看到 `Not logged in` 或报错，说明登录没成功，请检查 CommHub 服务器是否在运行（`curl http://localhost:9200/health`）。
:::

### 2. Dashboard 登录 -- 网页登录

**打开浏览器，访问 CommHub 的网页界面。** 用的是同一个 Agent Network 账号。

```
http://localhost:9200/dashboard   # 本地
http://10.0.0.1:9200/dashboard    # 远程
```

### 3. `codex auth login` -- OpenAI 账号（和 Agent Network 无关）

如果你要用 GPT-5.5 模型的 Agent，需要先登录 OpenAI 的 Codex。**这是 OpenAI 自己的账号体系**，跟 Agent Network 没关系。

### 4. `claude auth login` -- Anthropic 账号（和 Agent Network 无关）

如果你要用 Claude 模型的 Agent，需要 Anthropic API Key 或 MiniMax API Key和 Anthropic 授权。**这也跟 Agent Network 没关系。**

### 一张表看清楚

| 你要做什么 | 在哪操作 | 登录什么 | 账号体系 |
|-----------|---------|---------|---------|
| 管理 Agent Network | 终端 | `anet login` | Agent Network 账号 |
| 看 Dashboard | 浏览器 | 网页登录 | Agent Network 账号（同一个） |
| 用 GPT-5.5 Agent | 终端 | `codex auth login` | OpenAI 账号 |
| 用 Claude Agent | 终端 | `claude auth login` | Anthropic 账号 |
| 用 MiniMax Agent | 不用登录 | 配置 API Key 即可 | MiniMax 账号 |

::: warning 记住
`anet login` 是登录 Agent Network。`codex auth login` 和 `claude auth login` 是登录 AI 模型提供商，和 Agent Network 是两码事。
:::

---

## 账号和密钥从哪来？

上面讲了有好几种登录，但具体的账号和密钥从哪来？一个个说清楚。

### 1. Dashboard / CLI 登录账号

这是 **Agent Network 自己的账号**，用来登录 CLI 和 Dashboard。

| 问题 | 答案 |
|------|------|
| 账号从哪来？ | `anet hub start` 时自动创建（默认 admin / anethub） |
| 用户名是什么？ | 默认 `admin`，可用 `anet register` 另开账号 |
| 密码是什么？ | 你自己设置的 |
| Dashboard 和 CLI 是同一个账号吗？ | 是的，完全相同 |
| 怎么改密码？ | 终端运行 `anet passwd` |
| 怎么给别人开账号？ | 别人在自己电脑上运行 `anet register --hub http://你的IP:9200` |

### 2. AI 模型 API Key（去哪拿）

Agent 干活需要调用 AI 模型，不同模型的 Key 要去不同地方申请：

| 模型 | 注册地址 | 拿到的 Key 长什么样 | 怎么填 |
|------|---------|-------------------|--------|
| MiniMax | [platform.minimaxi.com](https://platform.minimaxi.com) → API Keys | `sk-cp-xxx` | `anet node create` 时选 MiniMax 自动提示 |
| DeepSeek | [platform.deepseek.com](https://platform.deepseek.com) → API Keys | `sk-xxx` | 同上 |
| GLM 智谱 | [open.bigmodel.cn](https://open.bigmodel.cn) → API 密钥 | `xxx` | 同上 |
| 书生 | [chat.intern-ai.org.cn](https://chat.intern-ai.org.cn) → 设置 | `xxx` | 同上 |
| Kimi | [platform.moonshot.cn](https://platform.moonshot.cn) → API 管理 | `xxx` | 同上 |
| OpenRouter | [openrouter.ai](https://openrouter.ai) → Keys | `sk-or-xxx` | 同上 |
| Claude | [console.anthropic.com](https://console.anthropic.com) → API Keys | `sk-ant-xxx` | 同上 |
| GPT-5.5 | 不需要 Key | 终端执行 `codex auth login` | 自动保存 |
| Claude Code | 不需要 Key | 终端执行 `claude auth login` | 自动保存 |

### 3. Key 保存在哪？

`anet node create` 时填入的 API Key 保存在：

```
~/.anet/nodes/<节点名>/config.json
```

具体在 `env` 字段里，例如：

```json
{
  "alias": "文案1号",
  "runtime": "claude-agent-sdk",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-cp-xxx你的key"
  }
}
```

::: tip 安全提示
这个文件只在你本机，不会上传到 CommHub 服务器。但注意不要把它提交到 Git 仓库。
:::

---

## Token 是什么？

**Token = 登录后自动获得的通行证。你不用管它。**

当你执行 `anet login` 后，系统会自动保存一个 Token 到你的电脑上。之后每次操作，CLI 会自动带上这个 Token 来证明你的身份。

就像微信登录后，你不需要每次发消息都重新输密码一样。Token 就是那个"已登录"的标记。

Agent Network 有两种 Token：

| Token | 前缀 | 含义 |
|-------|------|------|
| 用户 Token | `utok_` | 你的身份凭证（登录后自动获得） |
| 网络 Token | `ntok_` | 你所在网络的凭证（自动获得） |

**你完全不需要手动操作 Token**，了解即可。

---

## 总结：先做什么？

1. **装 CLI**：`npm install -g @sleep2agi/agent-network`
2. **启 Hub**：`anet hub start`（自动建库 + 默认 admin/anethub）
3. **启 Dashboard**：`anet hub dashboard`
4. **登录 + 建 Agent**：`anet login` → `anet node create my-bot` → `anet node start my-bot`

详细步骤请看 [上手指南](/guide/getting-started)。

---

## 下一步

- [上手指南](/guide/getting-started) -- 跟着做，跑通本地第一个 Agent
- [架构概览](/guide/architecture) -- 更深入地了解系统设计
- [CLI 命令](/guide/cli) -- 查看所有 anet 命令
