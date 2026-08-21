# Windows 上手

在 Windows 上跑 Agent Node 有两条路：**原生 Windows（PowerShell）** 或 **WSL（Ubuntu）**。

- **原生 PowerShell**：`codex-sdk` 可作为无头节点；preview.43+ 还原生支持 `codex-cli` 共存 TUI，一条 `anet node start` 自动管理 app-server 与 bridge，不需要 tmux。
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
codex login
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

要让人和 Agent 共用同一个 Codex TUI/thread，请安装 preview.43+，然后交互创建：

```powershell
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
anet node create
# 在 runtime 菜单选择：codex-cli — Codex 共存 TUI
anet node start <你输入的节点名>
```

TUI 会直接占用当前控制台。停止时在另一个 PowerShell 运行 `anet node stop <节点名>`。再次执行 `anet node start <节点名>` 会恢复配置中保存的同一个 Codex thread，而不是新建会话。详见 [Codex TUI 人机共存](./codex-copresence.md)。

::: tip Windows 原生验证范围
preview.43 的共存路径在 `windows-latest` 的真实 ConPTY 中覆盖了交互选择、启动、TUI 接入、停止和重启恢复同一 thread。WSL 仍适合需要完整 POSIX 工具链的其他 runtime。
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
codex login              # 或 export OPENAI_API_KEY=sk-...
anet login --hub https://<你的-hub-地址> --username <用户名> --password <密码>
anet node create codex-node --runtime codex-sdk
anet node start codex-node
```

---

## 常见坑

- **`anet --version`（或任意命令）报 `ENOENT ... 'E:\C:\...\package.json'`（盘符被拼错）**：当 anet 装在某个盘（如 `C:`）、却从**另一个盘**（如 `E:\`）跑命令时触发（[#446](https://github.com/sleep2agi/agent-network/issues/446)）。**已在 preview `2.3.0-preview.29` 修复**，latest 补丁跟进中。临时绕过：切到 anet 所在盘再跑（先 `cd C:`），或把 Node/anet 装到跟工作目录同一个盘。
- **`spawn codex ENOENT`**：`codex` 没装或 npm 全局 bin 不在 PATH 上。先 `codex --version` 确认；PATH 修复参考 [节点 Runtime — claude-code-cli](./runtimes.md#claude-code-cli)。
- **`codex login` 报未知命令（很旧的 codex CLI）**：升级 codex（`npm i -g @openai/codex@latest`），或直接用 `OPENAI_API_KEY` 环境变量（PowerShell 用 `$env:OPENAI_API_KEY="..."`，Linux/WSL 用 `export`）。
- **连本地 Hub**：WSL 连「Windows 宿主机上的本地 Hub」时别用 `localhost`，用宿主机在 WSL 里的可达地址。
- **命令跑完后报 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) ... src\win\async.c`**：这是 Windows 上 Node/libuv 进程退出时的句柄清理竞态，**发生在命令实际工作完成之后**（比如 `anet login` 已经把 token 存好了才崩），功能其实已生效。多见于 conda 自带 / 旧版打包的 node；改用 [nodejs.org](https://nodejs.org) 的干净 **Node 22 LTS**（非 conda 的 node）通常可解。
