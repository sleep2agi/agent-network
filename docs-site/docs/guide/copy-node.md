# 复制节点（clone / fork）与清理

想要「再来一个和它一样的节点」时，有两条命令。两条都会给新节点一个**新的 Hub 身份**；
区别在于要不要带走对话历史。

| 你要的 | 用 | 适用 runtime |
|---|---|---|
| 同样的设置，从空白对话开始 | `anet node clone <源> <新名字>` | 除 opencode-cli 外的节点 |
| 同样的设置，**连 codex 对话历史一起带走** | `anet node codex fork <源> --name <新名字> --workdir <目录>` | 只限 codex 共存节点（`codex-app-server`） |
| 换一台机器部署 | 在那台机器上 `anet login` 后重新 `anet node create` | 任意 |

::: tip 你的 anet 有没有这些命令
`anet node clone --help` 能打印用法，就说明你的 anet 带 clone；
`anet node delete --help` 里出现 `--hub-only`，就说明 `node delete` 会同时删 Hub 上的那一行。
没有的话先升级：`anet upgrade --channel preview`。
:::

::: danger 不要 `cp -r` 节点目录
`.anet/nodes/<name>/config.json` 里存着节点的 `node_id` 和 `ntok_`。拷出来的「新节点」和源节点是
**同一个 Hub 身份**：两个进程订阅同一个收件箱，同一个任务会被执行两次、回两次。
:::

## clone：复制设置，新身份

在**源节点所在的项目目录**里运行（anet 只在当前目录的 `.anet/nodes/` 里找节点）：

```bash
anet node clone my-node my-node-copy
# 等价写法
anet node create my-node-copy --from my-node
```

| 参数 | 说明 |
|---|---|
| `--workdir <dir>` | 把新节点放到另一个项目目录（不存在会创建；路径必须是 ASCII，节点名可以是中文）。不加时与源节点同目录，共用规则文件和 skills |
| `--model <id>` | 换一个模型；不加时沿用源节点的模型 |
| `--start` | 建完立即启动；有待填的机密 env 时不启动，先提示你填 |

clone 先向 Hub 注册新节点（和 `anet node create` 同一个接口），注册成功才写磁盘；所以必须先 `anet login`。
完成后打印一张表，逐项列出 `copied` / `regenerated` / `skipped`，例如：

```text
[anet] Cloned "my-node" → "my-node-copy"
[anet]   node_id: n_xxxxxxxx → n_yyyyyyyy   (distinct Hub identity)
...
Start: anet node start 'my-node-copy'
```

`anet node create` 专属的 `--runtime`、`--tools`、`--env`、`--channel`、`--copresence`、`--resume`、`--session`、`--batch`
不能和 clone 同用（报错退出码 2）：这些都从源节点复制。

会被拒绝（退出码 1）：新名字已存在或与源节点同名、目标落在源节点自己的目录里、`--workdir` 含非 ASCII 字符、
源节点是 opencode-cli（请用 `anet node create <新名字> --runtime opencode-cli` 新建）、源节点是 host daemon（`role=host_supervisor`）。

## fork：codex 节点连历史一起带走

```bash
anet node codex fork my-node --name my-node-copy --workdir ~/my-node-copy --no-codex-login
CODEX_HOME=~/my-node-copy/.anet/nodes/my-node-copy/codex-home codex login --device-auth
cd ~/my-node-copy && anet node codex start my-node-copy --probe-from my-node
```

- `--name` 和 `--workdir` 必填；`--workdir` 不存在会自动创建。
- 源节点必须是 `codex-app-server`，且它的身份、`CODEX_HOME`、thread、rollout 四项 preflight 都通过，否则拒绝（退出码 2）。源节点只被读，不被改。
- 源 rollout 被复制一份并改写成新的 thread id；新节点的 `config.toml` 里 `[projects."<源工作区>"]` 改写成新目录。
- `--model <id>` 覆盖模型；`--inherit-full-access` 在源节点本来就开了完整访问时继承它。
- 之后的 `anet node codex start/restart` 要在 `--workdir` 目录里执行。

细节（receipt 的每一项检查）见 [Codex TUI 人机共存](/guide/codex-copresence) 的「fork：继承历史，其余全新」一节。

## 复制了什么、新建了什么

| 项目 | `clone` | `codex fork` |
|---|---|---|
| `node_id` | 新的 | 新的 |
| 节点 token（`ntok_`） | 新的，Hub 签发 | 新的，Hub 签发 |
| 别名 | 你给的新名字 | `--name` |
| 模型 | 复制；`--model` 可覆盖 | 复制；`--model` 可覆盖 |
| runtime、工具、权限 flags、system prompt、非机密 env | 复制 | 不复制：新节点按 codex 共存节点的默认设置新建 |
| 机密 env 的值 | **不复制**：只保留键名，改成指向新节点的 envRef，启动前自己填 | 不复制 |
| `CODEX_HOME` | 新目录 `<节点目录>/codex-home`；只复制 `config.toml`、`AGENTS.md`、`version.json`、`skills/` | 新目录；复制 `config.toml`、`version.json`、`AGENTS.md` |
| codex 登录（`auth.json`） | **不复制** | 默认**拒绝**（见下节） |
| 对话 thread / 历史 | 不复制，从空白开始 | **复制**，换成新的 thread id |
| app-server 端口 | 首次启动时分配 | fork 时探一个空闲端口写进配置，首次启动优先用它 |
| tmux 会话名 | 由新名字派生（codex 共存节点为 `<名字>`、`<名字>-appsrv`、`<名字>-桥`） | 同左 |
| 日志、pid、inbox、goals、channel bot 凭据 | 不复制 | 不复制 |

## 为什么一个 codex 登录只能给一个节点

ChatGPT 登录的 refresh token 是**一次性**的：每刷新一次换一个新的，旧的作废。
同一份 `auth.json` 放进两个节点的 `CODEX_HOME`，谁先刷新谁活，另一个节点之后报
`401 token_revoked`（`Your access token could not be refreshed …`）。所以 anet 拦在复制之前：

- **clone** 从不复制 `auth.json`。新节点首次 `anet node start` 时，如果它的 `codex-home` 里还没有登录，anet 会把本机
  `~/.codex` 的登录放进去——但本机已有别的节点在用这份登录时**拒绝启动**（退出码 1）。
- **fork** 默认拒绝复制源节点的 ChatGPT 登录（源节点正在用它），退出码 1，在向 Hub 注册之前就退出，不留任何东西。
  `--no-codex-login` 不复制登录，首启前自己登录。
- 正确做法：每个节点自己登录一次（SSH 下也能用 device auth）：

  ```bash
  CODEX_HOME=<新节点目录>/codex-home codex login --device-auth
  ```

  或安装一个登记过的账号：`anet node codex account install <新名字> --source codex-login:<profile-id>`。
- `--allow-shared-codex-login`（`node start` 和 `codex fork` 都接受）强行共享，**不安全**：这几个节点会互相顶掉登录。

判断「是不是同一个登录」用的是 refresh token 的短指纹，不读别的节点的 `auth.json`。
详见 [一个登录只给一个节点](/guide/codex-copresence#one-login-per-node)。

## 每个 codex 节点自己登录

每个 codex 节点都有自己的 `CODEX_HOME`：refresh token 一次性（共用登录会互相顶掉）、会话按 HOME 存、停止/删除按 `CODEX_HOME` 认进程。所以复制出来的 codex 节点要自己登录一次：

- `anet node clone` 建出的 codex 节点如果首启不会有可用登录，命令最后一段就是给它登录的确切命令（`CODEX_HOME=<新节点目录>/codex-home codex login`，无浏览器用 `--device-auth`），之后才是 `anet node start`。只打印，不执行，不拷任何 `auth.json`。
- `anet node codex fork --no-codex-login` 的结果里也给出同样的命令。
- `anet node codex login-status [--json]` 列出本目录每个 codex 节点：`CODEX_HOME`、是否已登录、账号（邮箱或指纹）、和谁共用同一份登录。不打印 token。

详见 [为什么每个 codex 节点都有自己的 CODEX_HOME](/guide/codex-copresence#why-own-codex-home)。

## 删掉复制出来的节点

```bash
anet node delete my-node-copy            # 只预览：列出要删的目录和 node_id，不动手
anet node delete my-node-copy --force    # 真删
```

- **不用先停**：`--force` 先做一遍和 `anet node stop` 完全相同的停止，包括共存节点（codex / grok / opencode）的 tmux 会话。
  codex 共存节点按它自己的身份（共存标记 + `CODEX_HOME`）认；没有标记的节点只认 `<name>`、`<name>-appsrv`、`<name>-桥`
  这三个**完整**会话名，从不按前缀匹配 —— 名字相近的别的会话不受影响。
  停不干净（比如进程拒绝退出）就报错退出，**什么都不删**。
- **不用记副本放在哪**：clone / codex fork 会在源目录的 `.anet/child-workdirs.json` 里记下副本在哪。
  从源目录运行时，anet 找到它后**不会替你删**，而是打印一条原样可用的命令，退出码 `1`：

  ```text
  [anet] "my-node-copy" is not in this directory; it lives in /home/me/my-node-copy/.anet/nodes/my-node-copy (node_id n_yyyyyyyy).
  [anet] Nothing was stopped or deleted. Run it from there:
    cd '/home/me/my-node-copy' && anet node delete 'my-node-copy' --force
  ```

- 同名的节点有好几个（比如两个不同目录里都有 `my-node-copy`）时，anet **拒绝删除**，列出每一个的 `cd … && anet node delete <node_id>`，
  让你按 node_id 选一个。

`--force` 先删本地 `.anet/nodes/my-node-copy/`（包括它的 `codex-home`），再按本地配置里的 `node_id`
删掉 Hub 上的那一行，这样它不会在 app / dashboard 里一直显示「离线」：

```text
[anet] Deleted "my-node-copy"
[anet] Removed "my-node-copy" (node_id n_yyyyyyyy) from the Hub
```

- Hub 上的行**只按 `node_id` 匹配**，从不按名字：别处同名的节点不会被删，anet 会打印 `Left untouched: …`。
- Hub 连不上或拒绝时，本地照样删掉，anet 打印警告和可直接复制的重试命令，退出码 1：

  ```bash
  anet node delete <node_id> --hub-only
  anet node delete <node_id> --hub-only --hub <url>   # 节点用的不是当前登录的 Hub 时
  ```

- 节点目录删掉之后，它用过的 codex 登录不再算「被占用」，可以交给别的节点。
- `node delete` 不撤销已签发的 `ntok_`；需要时另行 `anet token revoke <token-id>`。

## 延伸阅读

- [CLI 命令参考](/guide/cli)
- [Agent Node](/guide/agent-node)
- [Codex TUI 人机共存](/guide/codex-copresence)
