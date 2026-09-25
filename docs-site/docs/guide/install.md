# 安装

这一页只做一件事：把 `anet` 装好。装好后按 [10 分钟跑通第一个节点](/guide/getting-started) 继续。已经装过的，走[升级指南](/guide/upgrade)。

::: tip 不想用命令行？
[桌面应用](/guide/desktop-app)（macOS / Windows）自带本地 Hub，下载安装即可用，也能一键装好本机 daemon。下载入口在[首页](/#desktop-download-title)。
:::

## 前置：Node.js 和 Bun {#prerequisites}

| 依赖 | 版本 | 怎么装 |
|---|---|---|
| Node.js | ≥ 22.13.0 | 推荐用 [nvm](https://github.com/nvm-sh/nvm)：`nvm install 22 && nvm use 22`；Windows 见[下文](#windows) |
| Bun | ≥ 1.2.0 | `npm install -g bun`，或 `curl -fsSL https://bun.sh/install \| bash` |

两个都要装。Hub（`commhub-server`）由 Bun 运行，`anet hub start` 用 `bunx` 启动它。没装 Bun 时，`2.3.0-preview.47` 及以后的构建会在启动前报 `❌ anet hub start requires the Bun runtime` 并退出；更早的构建会直接崩成 `Error: spawn bunx ENOENT`。

```bash
node --version       # v22.x 或更新
bun --version        # 1.2.x 或更新
```

全局安装报 `EACCES` 时，用 nvm / fnm 装的 Node，不要用 `sudo npm` 或改系统目录权限。

::: details 用 systemd、cron 或别的用户启动时找不到 node / bun
nvm 只在交互 shell 里自动加载，Bun 也是按用户装在 `~/.bun/bin`。要让 systemd、cron 或另一个用户启动 Hub 和节点，在 unit / 脚本里显式 `source ~/.nvm/nvm.sh` 并把 `~/.bun/bin` 加进 `PATH`，或者把 node / npm 链接到 `/usr/local/bin`。
:::

## Linux / macOS

```bash
npm install -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

`@sleep2agi/agent-network` 提供 `anet` 命令。`commhub-server` 和 `agent-node` 首次使用时会自动拉取；提前装好 `agent-node` 可以让第一次 `anet node start` 不用等下载。

验证：

```bash
anet -v
```

`anet -v` 会列出 `agent-node`、`commhub-server` 是否已就位，以及本机装了哪些可选的 runtime CLI（`claude`、`codex` 等）。之后任何启动出错，先看这里。

## Windows {#windows}

两条路：

- **WSL（Ubuntu）**：标准 Linux 环境，所有 runtime 都适用，最稳。管理员 PowerShell 里 `wsl --install`，重启后打开 Ubuntu 终端，按上面的 Linux 步骤装。WSL 里连 Windows 宿主机上的 Hub 时，不要用 `localhost`，用宿主机在 WSL 里的可达地址。
- **原生 PowerShell**：`codex-sdk` 可作为无头节点；`codex-cli` 共存 TUI 也原生支持，`anet node start` 会自动管理 app-server 和 bridge，不需要 tmux。

原生 PowerShell 安装：

```powershell
winget install OpenJS.NodeJS.LTS
npm install -g bun @sleep2agi/agent-network
npm install -g @openai/codex       # 用 codex 类 runtime 时
anet -v
```

Windows 上的常见问题：

- **`anet --version` 报 `ENOENT ... 'E:\C:\...\package.json'`**：anet 装在一个盘、却从另一个盘运行时出现，已在 `2.3.0-preview.29` 及以后修复。旧版本可以先切到 anet 所在的盘再运行。
- **`spawn codex ENOENT`**：`codex` 没装，或 npm 全局 bin 不在 `PATH` 上。
- **命令结束后报 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`**：Node/libuv 在进程退出时的清理竞态，命令本身已经生效。多见于 conda 自带的 node，换成 [nodejs.org](https://nodejs.org) 的 Node 22 LTS 通常可解。

## 安装了什么 {#packages}

| npm 包 | 命令 | 用途 |
|---|---|---|
| `@sleep2agi/agent-network` | `anet` | CLI，也包含 Client SDK |
| `@sleep2agi/agent-node` | `agent-node` | 节点运行时，驱动 `claude-agent-sdk`、`codex-sdk` 等 runtime |
| `@sleep2agi/commhub-server` | `commhub-server` | Hub 服务端，需要 Bun；`anet hub start` 会自动拉取匹配的版本 |
| `@sleep2agi/agent-network-dashboard` | — | Web Dashboard；`anet hub dashboard` 通过 `npx` 自动拉取 |

资源参考：Hub 约 256 MB 内存，每个节点再加约 128 MB；磁盘 100 MB 起，随数据库增长。

不想全局安装时可以用 `npx @sleep2agi/agent-network hub start` 这类形式临时运行。在自己代码里用 Client SDK，见仓库里的 [npm 包与 SDK 说明](https://github.com/sleep2agi/agent-network/blob/main/docs/sdk/npm-packages-and-sdk.zh.md)。

## 发布通道

默认安装的是稳定通道 `latest`。想提前试新功能，装 `preview`：

```bash
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
```

两个通道的区别和切换方法见[升级指南：发布通道](/guide/upgrade#channels)。

## 旧的一键安装脚本已退役 {#setup-anet}

一键安装脚本已退役：`https://anet.sh/setup-anet.sh` 现在只打印退役说明并以非零状态退出。不要运行以前下载或复制的旧版本，它的进程清理和目录删除范围不局限于本次安装，可能影响同一台机器上的其他服务。请按本页安装。

## 下一步

- [10 分钟跑通第一个节点](/guide/getting-started)
- [干净服务器从零部署](/deploy/clean-server)：在一台新的 Ubuntu / Debian 服务器上长期运行
- [升级指南](/guide/upgrade)
