# 升级 Agent Network

本页适用于已经安装 `anet` 的用户。不要从文档复制固定版本号；稳定版与预览版
分别以 npm 的 `latest`、`preview` dist-tag 为准。

## 发布通道与版本号 {#channels}

Agent Network 有两个 npm 发布通道：

| 通道 | 装法 | 适合 |
|---|---|---|
| `latest`（稳定） | `anet upgrade` 或 `npm install -g @sleep2agi/agent-network` | 大多数用户 |
| `preview` | `anet upgrade --channel preview` 或 `npm install -g @sleep2agi/agent-network@preview` | 想提前试新功能 |

切回稳定通道：`anet upgrade --channel latest`。查通道此刻指向哪个版本：`npm view @sleep2agi/agent-network dist-tags`（`agent-node`、`commhub-server` 同理）。

版本号怎么读：

- `anet -v` 顶行是 `@sleep2agi/agent-network` 的版本（形如 `anet v2.3.0-preview.N`），下面的 Components 列出 `agent-node`、`commhub-server`、dashboard 各自的版本。各包按需独立发版，hotfix 可以只升一个包。
- 主仓 [GitHub releases](https://github.com/sleep2agi/agent-network/releases) 的 `v0.10.x` 等 tag 是 2026-06 之前的「bundle release」，最后一条是 2026-06-17 的 `v2.2.15`，不代表当前版本。变更请看[更新日志](/changelog)；桌面端安装包在 [agent-network-app releases](https://github.com/sleep2agi/agent-network-app/releases)。
- 包版本与整体版本的对应矩阵见 [docs/version/](https://github.com/sleep2agi/agent-network/blob/main/docs/version/README.md)。

## 1. 先看计划

```bash
anet --version
anet upgrade --dry-run
```

`--dry-run` 只解析目标版本并打印动作，不安装任何包。默认沿用当前 CLI 的发布通道；
只有明确要切换时才加 `--channel latest` 或 `--channel preview`。

## 2. 停止 Hub 并备份

先停止真正管理 Hub 的进程管理器。前台运行可用 `Ctrl-C`；PM2/systemd 部署应使用
对应管理器停止，避免守护程序立即把 Hub 拉起。不要使用 `pkill -f`。

Hub 停止后再复制 SQLite 目录，避免得到不一致的数据库、WAL 和 SHM 文件：

```bash
backup_dir="$HOME/anet-backup-$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$backup_dir"

[ ! -d "$HOME/.anet" ] || cp -a "$HOME/.anet" "$backup_dir/"
[ ! -d "$HOME/.commhub" ] || cp -a "$HOME/.commhub" "$backup_dir/"
[ ! -d .anet ] || cp -a .anet "$backup_dir/project-.anet"

find "$backup_dir" -mindepth 1 -maxdepth 1 -print
du -sh "$backup_dir"
```

确认输出中确实有预期目录，再继续。备份可能包含 token，保持目录权限为 `700`，
不要上传到公开仓库或聊天记录。

## 3. 执行升级

```bash
anet upgrade
```

该命令升级已全局安装的相关包；未全局安装、由 `bunx`/`npx` 延迟获取的包会标为
`lazy`。CLI 自升级通过后台进程完成，命令结束后在新 shell 中核验：

```bash
anet --version
```

自动化或 CI 不应让当前进程自替换，可用：

```bash
anet upgrade --no-auto-self
```

然后按命令输出，在新 shell 中手动升级 CLI。

## 4. 重启并验证

用原来的方式启动 Hub，再重启需要加载新 `agent-node` 的节点：

```bash
anet hub start
anet node restart <alias>
anet doctor
anet node ls
curl -fsS http://127.0.0.1:9200/health
```

如果 Hub 由 PM2/systemd 管理，应由该管理器启动，不要同时再运行前台
`anet hub start`。多个项目可在各自目录运行 `anet project restart`。

共存节点（preview）必须沿用原来的共存启动模式；例如原来使用 `--copresence`，恢复时也要带
`--copresence`，不要用普通启动命令抢同一个 alias。

验收至少包括：CLI 版本正确、`doctor` 无阻塞项、Hub `/health` 正常、节点重新在线。

### 容器中的配置文件所有者

新版 `agent-node` 会在读取含 token 的配置前拒绝符号链接和不同 UID 所有者，避免把
其他用户控制的文件当成节点身份。Docker/Podman 若把宿主机的 `config.json` 绑定挂载
进容器，请让容器进程 UID 与文件所有者一致，或先把配置复制到由容器用户拥有的
`.anet` 状态目录。不要用放宽权限来绕过检查；所有者不匹配会安全地拒绝启动。

同一 UID 的旧配置仍兼容：过宽的文件权限会收紧为 `0600`，Agent Network 管理的
`.anet` 目录会收紧为 `0700`。

## 很老的 v0.7 安装 {#v0-7-v0-8-升级注意-最新}

v0.7 使用旧的全局 token 模型。当前版本保留旧 `atok_` 的读取兼容，但新部署与写操作
使用用户 token（`utok_`）和节点 token（`ntok_`）。跨越这些旧版本时：

1. 保留离线备份。
2. 升级后运行 `anet login` 和 `anet doctor`。
3. 不要手工改 SQLite 表或复制其他节点的 token。

详细背景见[账号体系](/guide/account-system)与[更新日志](/changelog)。本页不再复制
旧版本的逐包安装命令，因为固定版本和历史默认密码会误导当前安装。

## 初始管理员密码的版本差异 {#initial-password}

- **`≥ 2.2.22-preview.4`**（现在的 `latest` 与 `preview` 都在此范围）：首次 `anet hub start` 打印**一次性随机密码**，只显示这一次，请当场保存；首次登录提示改密。
- **`≤ 2.2.22-preview.3`（含 `2.2.21` 及更早）**：固定默认 `admin` / `anethub`，登录后必须立即 `anet passwd` 改密。

任何公网部署，无论哪个版本，都必须登录后立即 `anet passwd`。

## 忘了管理员密码 {#forgot-password}

在 Hub 主机上运行：

```bash
anet hub admin reset-user --username <user>
```

::: tip 为什么这条要单独写出来
`anet hub --help` 的子命令列表里**不显示** `admin`，所以这条命令无法靠翻帮助发现。
不要改用直接修改 SQLite 的偏方 —— 那会绕过鉴权与审计，并可能破坏关联状态。
:::

## 回退不是删除目录

安装旧 CLI **不会**自动回退已经迁移的配置或 Hub 数据库。没有兼容性证据时，不要让
旧 Hub binary 直接打开升级后的生产数据库。

如果只是 CLI 本身异常，可以先查看可用版本，再安装已知可用的旧 CLI：

```bash
npm view @sleep2agi/agent-network versions --json
npm install -g @sleep2agi/agent-network@<已验证版本>
anet --version
```

需要恢复配置或数据库时，先停止唯一的 Hub 守护者，并把当前状态移动到新的保留目录；
确认备份路径、内容和权限后再复制。**不要递归删除整个 `~/.anet` 目录，也不要覆盖式恢复。**
数据库恢复应同时处理主库、WAL、SHM，并在生产目标之外验证后再执行。

无法确认版本与数据库兼容时，保留现场并在
[GitHub Issues](https://github.com/sleep2agi/agent-network/issues) 提交版本、`doctor`
输出和脱敏日志。

## 相关

- [CLI 命令](/guide/cli)
- [进程守护](/deploy/daemon)
- [故障排查](/troubleshooting)
