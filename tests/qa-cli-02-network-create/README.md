# qa-cli-02-network-create

**Matrix cell**: [CLI-02](../../docs/qa/test-matrix.md#cli-用户矩阵persona-终端开发者) — `anet network create` 走完整 CLI 路径。

**Layer**: L2 CLI smoke（用户视角，真 CLI binary，黑盒）。

**Why it matters**: REST 层已由 [qa-hub-05](../qa-hub-05-roundtrip/) 覆盖。这条专测 **CLI 包装层**：
- 非交互登录（`--username/--password`）
- `~/.anet/config.json` 落地（hub URL + utok）
- `anet network create` **输出格式**（SDK 脚本依赖正则解析）
- `anet network ls` 列表
- 重复名拒绝
- `anet whoami` 用 persisted utok

是 getting-started 第二步（每个新用户必跑）的回归保护。

## Run

```bash
sg docker -c 'docker build -t anet-qa-cli-02 -f tests/qa-cli-02-network-create/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-cli-02'
```

预算：cold ~30s（含 npm install），warm ~12s。

## 7 步

| # | 命令 | 断言 |
|---|------|------|
| [0] hub boot | health 200 |
| [1] `anet login --hub --username --password` | stdout 含 "Logged in as admin" |
| [2] config 落地 | `~/.anet/config.json` 有 hub URL + utok_ |
| [3] `anet network create qa-cli02-net` | **stdout 精确匹配** `[anet] Network "qa-cli02-net" created (net_<hex>)` |
| [4] REST 验证 | `/api/networks` 看到该 network |
| [5] `anet network ls` | stdout 含 network name |
| [6] `anet network create` 重名 | stdout 含 already/taken/exists 类提示 |
| [7] `anet whoami` | 输出含 admin |

## 关键契约锁死

#### 1. CLI 输出精确格式 `[anet] Network "<name>" created (<id>)`

SDK 脚本 / shell wrapper 用正则解析这个 stdout 拿 network_id。
[cli.ts L3166](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3166) 的 `console.log`。
一旦改文案（比如改成 emoji 或 i18n），所有解析脚本挂。

#### 2. `~/.anet/config.json` 是 source-of-truth

login 把 hub + token 写本地 JSON，后续命令复用。**不是**每条 CLI 都自带 `--hub`/`--token`。

#### 3. 非交互登录路径必须可用

`anet login --username X --password Y` — pin "脚本可用，不强制 tty"。
没有这个，CI/Docker 测试都没法跑（[loginCommand L3055](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3055) 接 opts.username/opts.password 跳过 ask）。

## 资源

- Docker（`sg docker`）
- node:20-slim + bun + jq + unzip + procps
- `@sleep2agi/agent-network@preview` from npm
- 0 LLM API calls
