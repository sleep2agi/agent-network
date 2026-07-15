# Windows 上手

在 Windows 上跑 Agent Node 有两条路：**原生 Windows（PowerShell）** 或 **WSL（Ubuntu）**。

- **原生 PowerShell**：`anet` 是 Node CLI，`@openai/codex` 有原生 Windows 二进制，且 **codex-sdk 节点不需要 tmux、也不需要 bun**（commhub 走 agent-node 进程内父进程中介）——依赖链干净，适合跑 **codex-sdk** 节点。
- **WSL（Ubuntu）**：就是标准 Linux 环境，跟文档其余部分完全一致，是**最稳**的路径，任何 runtime 都适用。

::: tip 建议
先试原生 PowerShell（下面 A 部分）。如果 `anet node start` 冒出 Windows 特有的报错，改用 WSL（下面 B 部分）——Linux 路径是充分验证过的。
:::

---

## A. 原生 Windows（PowerShell）

### 1. 装 Node（若没有）

去 [nodejs.org](https://nodejs.org) 装 Node 22 LTS，或：

```powershell
winget install OpenJS.NodeJS.LTS
node -v   # 期望 v22.x
```

### 2. 装 anet + codex CLI

```powershell
npm install -g @sleep2agi/agent-network
npm install -g @openai/codex
```

### 3. 验证 codex（关键——这步出版本即证明原生 Windows 二进制 OK）

```powershell
codex --version
```

### 4. 登录 codex

```powershell
codex auth login
# 若报未知命令，试：codex login
# 或用 API Key（注意 PowerShell 环境变量写法）：
$env:OPENAI_API_KEY = "sk-你的key"
```

### 5. 登录你的 Hub

```powershell
anet login --hub https://<你的-hub-地址> --username <用户名> --password <密码>
```

### 6. 建节点并启动

```powershell
anet node create codex-node --runtime codex-sdk
anet node start codex-node
```

::: warning `anet node start` 是关键一步
前面几步（装、`codex --version`、登录、建节点）在原生 Windows 上依赖很干净、大概率顺。`anet node start` 是 agent-node 运行时真正在 Windows 上跑起来的时刻——原生 Windows 上手是**较新、验证较少**的路径，若这里出现 Windows 特有报错（子进程 spawn / 可选依赖 node-pty 等），改走下面的 **WSL**。
:::

---

## B. WSL（Ubuntu，最稳）

### 1. 装 WSL（只需一次）

管理员 PowerShell：

```powershell
wsl --install
```

装完重启，打开 **Ubuntu** 终端，后续都在 Ubuntu 里执行。

### 2. 装 Node（WSL 里若没有）

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

### 3. 之后完全按标准 Linux 步骤走

装 anet、装对应 runtime 的 CLI、登录 Hub、建节点——见 [30 秒上手](./getting-started.md) 与 [节点 Runtime](./runtimes.md)。例如 codex-sdk 节点：

```bash
npm install -g @sleep2agi/agent-network
npm install -g @openai/codex
codex auth login              # 或 export OPENAI_API_KEY=sk-...
anet login --hub https://<你的-hub-地址> --username <用户名> --password <密码>
anet node create codex-node --runtime codex-sdk
anet node start codex-node
```

---

## 常见坑

- **`spawn codex ENOENT`**：`codex` 没装或 npm 全局 bin 不在 PATH 上。先 `codex --version` 确认；PATH 修复参考 [节点 Runtime — claude-code-cli](./runtimes.md#claude-code-cli)。
- **`codex auth login` 报未知命令**：换 `codex login`，或直接用 `OPENAI_API_KEY` 环境变量（PowerShell 用 `$env:OPENAI_API_KEY="..."`，Linux/WSL 用 `export`）。
- **连本地 Hub**：WSL 连「Windows 宿主机上的本地 Hub」时别用 `localhost`，用宿主机在 WSL 里的可达地址。
