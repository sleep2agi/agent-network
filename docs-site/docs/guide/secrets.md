# 密钥（Secrets）

API Key 之类的值设一次、重启还在、启动前不用 `export`。只存在本机的两个 0600 文件里，
**不进 Hub 消息、不进 git**。

## 三条命令

```bash
anet secret set OPENAI_API_KEY                 # 本机所有节点都能用
anet node secret set <节点名> OPENAI_API_KEY    # 只给这个节点，覆盖上面那个
anet secret list --node <节点名>                # 只看键名、来源、长度，从不打印值
```

值在终端里输入（不回显），或从管道读：

```bash
printf '%s' "$VALUE" | anet secret set OPENAI_API_KEY
```

值**不能**写在命令行参数里（会进 shell 历史和 `ps`），`anet secret set KEY value` 会被拒绝。
删除：`anet secret unset KEY`、`anet node secret unset <节点名> KEY`。

设完之后重启节点生效：`anet node restart <节点名>`。

## 存在哪

| 文件 | 作用范围 |
|---|---|
| `~/.anet/secrets.env` | 本机所有节点 |
| `<节点目录>/secrets.env` | 一个节点（与它的 `config.json` 同目录，例如 `.anet/nodes/<节点>/secrets.env`） |

格式是 `KEY=value` 一行一个；支持 `#` 注释、`export KEY=`、单/双引号。

## 谁覆盖谁（从低到高）

```
启动时的 shell 环境 < ~/.anet/secrets.env < 节点 secrets.env < config.json 的 env
```

- 加载发生在 **agent-node 自己启动时**，所以不管是 `anet node start` 还是脚本直接起
  `agent-node --config …` 都生效；`claude-code-cli` 节点由 `anet node start` 注入。
- `config.json` 的 `env` 里显式写了的键（包括 `{"_envRef":"X"}`）优先级最高。
  `_envRef` 指向的变量 `X` 现在也可以放进 secrets 文件，不必再 `export`。
- `config.json` 的 `token`（Hub 登录）不变，不需要迁移。

## 权限

- 新建和改写一律 `0600`（与 umask 无关），原子写入（临时文件 + rename）。
- 文件是你的但权限过宽（如 `0644`）：自动改回 `0600` 并继续加载，同时打一行提示。
- 文件属于别的用户：**拒绝加载**。
- 会让节点起不来或被劫持的键不能设置、也不会被加载：`PATH`、`HOME`、`NODE_OPTIONS`、
  `LD_*`、`ANET_*`、`COMMHUB_*`、`*_BINARY` 等。

`anet doctor` 会列出这两个文件是否存在、权限、键数量（不含值），并提示 `config.json`
里还明文存着的 env 值。

## Codex 登录不要当密钥共享

Codex 的 `auth.json` / refresh token **不要**放进 `~/.anet/secrets.env` 让所有节点共用：
refresh token 是一次性的，一个节点刷新后，其它节点手里那份立刻失效、被登出（见 #1918 的共享登录告警）。
一个 Codex 账号只给一个节点用。
