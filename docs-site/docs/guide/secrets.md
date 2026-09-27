# 密钥（节点环境变量）

API Key 这类值就是节点的环境变量：设一次、重启还在、启动前不用 `export`。只存在本机的两个 0600 文件里，
**不进 Hub 消息、不进 git**。

## 三个地方

| 地方 | 是什么 | 在哪 |
|---|---|---|
| Hub env | 只给 hub 进程自己（端口、DB、hub 自己的密钥），从不下发给节点 | hub 自己的配置，不在本页 |
| **本机 daemon env** | 本机所有节点共用 | `~/.anet/secrets.env` |
| **节点 env** | 一个节点 | `<节点目录>/secrets.env`，与它的 `config.json` 同目录（如 `.anet/nodes/<节点>/secrets.env`） |

每台机器有自己的一份 daemon env，不会经网络推送。

## 三条命令

```bash
anet secret set OPENAI_API_KEY                 # 本机 daemon env：本机所有节点共用
anet node secret set <节点名> OPENAI_API_KEY    # 节点 env：覆盖 daemon 的值
anet secret list --node <节点名>                # 只看键名、层、长度，从不打印值
```

值在终端里输入（不回显），或从管道读：

```bash
printf '%s' "$VALUE" | anet secret set OPENAI_API_KEY
```

值**不能**写在命令行参数里（会进 shell 历史和 `ps`）。删除：`anet secret unset KEY`、`anet node secret unset <节点名> KEY`。

**`set` / `unset` 只改文件**，不碰正在运行的节点；下次启动才生效：`anet node restart <节点名>`。

## 启动时谁覆盖谁（从低到高）

```
daemon env < 节点 env < config.json 的 env < 启动命令本身已有的环境变量
```

- 文件是持久的；手动设的值（`export X=…`、`X=… anet node start <节点>`）**只对这一次启动有效**，
  从不写回文件。干净的 shell、新 tmux、开机 sweep 只看得到文件 —— 想让值持久，就 `set` 进文件。
- 文件只**补**进程里没有的变量；值为**空字符串**也算「已有」，保留不动。
- 启动时打一行键名（从不打值）：`env: daemon=[A,B] node=[C] kept-from-process=[D]`。
- `config.json` `env` 里显式写的键排在节点文件之上，已有配置的值不变。`_envRef` 照常可用，
  它指向的变量现在可以放进这两个文件，不必再 `export`。
- `config.json` 的 `token`（Hub 登录）留在原处，不进这两个文件。
- 加载发生在 **agent-node 自己启动时**，脚本直接起 `agent-node --config …` 也生效；
  `claude-code-cli` 节点由 `anet node start` 按同样规则注入。

## 权限

- 新建和改写一律 `0600`（与 umask 无关），原子写入（临时文件 + rename）。
- 文件是你的但权限过宽（如 `0644`）：自动改回 `0600` 并继续加载，同时打一行提示。
- 文件属于别的用户：**拒绝加载**。
- 会让节点起不来或被劫持的键不能设置、也不会被加载：`PATH`、`HOME`、`NODE_OPTIONS`、
  `LD_*`、`ANET_*`、`COMMHUB_*`、`*_BINARY` 等。

`anet doctor` 会列出两个文件是否存在、权限、键数量（不含值），并提示 `config.json` 里还明文存着的 env 值。

## Codex 登录不要共享

Codex 的 `auth.json` / refresh token **不要**放进 daemon env 让所有节点共用：refresh token 是一次性的，
一个节点刷新后，其它节点手里那份立刻失效、被登出（见 #1918 的共享登录告警）。一个 Codex 账号只给一个节点用。
