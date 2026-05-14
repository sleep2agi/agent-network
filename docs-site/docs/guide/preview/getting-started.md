# Preview 快速开始（preview.10）

本页面向正在安装 `@preview` 的用户，覆盖当前 preview.10 路径：Hub / Dashboard / 登录注册 / batch primitive / sci-team / token UX / 多 hub / admin reset。

::: warning Preview 不是 latest
`@preview` 用于提前验证下一批功能，版本可能比 npm `latest` 新，也可能包含仍在观察的 UX。生产环境优先用 `npm install -g @sleep2agi/agent-network`；需要 preview.10 功能时才安装 `@preview`。
:::

## 0. 前置

| 依赖 | 要求 |
|------|------|
| Node.js | ≥ 22.13.0 |
| npm | 建议 ≥ 10 |
| tmux | batch / sci-team 需要 |

如果你的 Node 低于 22.13，`npm` 默认只会 `EBADENGINE warn`，不会强制失败；请主动升级 Node，避免运行期差异。

## 1. 安装 preview CLI

```bash
npm install -g @sleep2agi/agent-network@preview
anet -v
```

当前验证版本：

```text
anet v2.1.8-preview.10
```

`commhub-server`、`agent-node`、Dashboard 会在首次使用时自动拉取对应包，不需要提前全局安装。

## 2. 启动 Hub

```bash
anet hub start
```

本机快速上手默认：

- Hub: `http://127.0.0.1:9200`
- 管理员：`admin / anethub`
- 数据库：`~/.commhub/commhub.db`

::: warning 公网部署先改密
默认 `admin / anethub` 只适合本机快速验证。任何 `--host 0.0.0.0` 或公网部署，启动后立即执行 `anet passwd` 改强密码。
:::

## 3. 登录 / 注册

已有管理员：

```bash
anet login --username admin --password anethub
```

新用户：

```bash
anet register
anet login
```

preview.7 起，登录 / 注册 / provider 选择路径加了更明确的 hint：如果没有 token，会引导你用默认 `admin / anethub` 登录；provider 选择会给出已验证的 base URL / model 值。

## 4. Dashboard

```bash
anet hub dashboard
```

浏览器打开 `http://localhost:3000`。preview.10 修复了 dashboard 双 channel：通过 CLI 启动时会跟随 `@preview` tag 拉取 preview dashboard，而不是误用 latest。

## 5. Batch primitive

preview.8 引入：

```bash
anet create --batch
```

常用非交互写法：

```bash
anet create --batch \
  --preset claude-haiku-4-5 \
  --api-key sk-ant-... \
  --prefix 工程师 \
  --count 5
```

生命周期：

```bash
anet batch list
anet batch stop 工程师
anet batch cleanup 工程师 --workdir ~/anet-team
```

详细说明见 [批量 Agent](/guide/batch)。

## 6. 科研军团 / sci-team

`anet demo sci-team` 保持兼容，是 batch primitive 的 preset wrapper：

```bash
anet demo sci-team --count 10 --intern-api "$INTERN_API_KEY" --dir ~/intern-s
```

verified vendor 值：

```text
runtime = claude-agent-sdk
model   = intern-s1-pro
baseUrl = https://chat.intern-ai.org.cn
```

旧命令：

```bash
anet demo sci-team --stop
anet demo sci-team --restart
anet demo sci-team --cleanup
```

仍可用，但会提示迁移到：

```bash
anet batch stop sci-team
anet batch cleanup sci-team --workdir ~/intern-s
```

## 7. Token UX

preview.9 修复了几个高频误导：

- `anet status` 的 session / agent 计数更贴近实际 Hub 状态。
- 旧 token / ntok 失效时，错误提示会指向 `anet doctor --fix`，而不是让你检查全局 token。
- `doctor --fix` 会重新签发 node token；运行中的 agent 若遇到 SSE 401，应重新读取 node config 后重连。

排障优先跑：

```bash
anet doctor --fix
```

## 8. 多 Hub 登录

同一机器要切不同 Hub，显式带 `--hub`：

```bash
anet login --hub http://127.0.0.1:9200 --username admin --password anethub
anet whoami
```

只改 Hub 地址：

```bash
anet init --hub http://192.168.1.10:9200
```

之后再 `anet login`。不要用旧式 master token 作为主路径；v0.8 起推荐用户名密码登录拿 `utok_`。

## 9. 管理员重置用户

本机管理员可重置普通用户：

```bash
anet hub admin reset-user --username alice
```

该命令会生成一次性新密码并撤销目标用户旧 `utok_`。适合用户忘记密码或 token 泄露后的本机救援。

## 10. Troubleshooting

### npm 提示 `EBADENGINE`

升级 Node 到 ≥ 22.13.0。npm 默认是 warn，不一定阻止安装，但 preview.10 代码路径按 Node 22.13+ 验证。

### Hub 起不来

检查端口是否占用：

```bash
lsof -i :9200
```

如果只是本机重置测试环境：

```bash
rm -rf ~/.commhub ~/.anet/server
anet hub start
```

### Agent SSE 401

优先：

```bash
anet doctor --fix
```

然后重启对应 node。如果仍失败，检查 `.anet/nodes/<name>/config.json` 里的 token 是否是 `ntok_`。

### Batch cleanup 后还有文件

`--workdir-mode shared` 的配置在 `<workdir>/.anet/nodes/`，preview.10 不会自动删，需手动清理。默认 `separate` 模式会清理 `<workdir>/node*`。

### Dashboard 没跟上 preview

确认你是通过 preview CLI 启动：

```bash
anet -v
anet hub dashboard
```

preview.10 起 CLI 会让 Dashboard 跟随 `@preview` channel。
