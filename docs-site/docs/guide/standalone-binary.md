# 单文件可执行文件

这是一条不经过 npm 的安装路径：一个文件就是 `anet`，运行它不需要本机先装 Node、npm 或 Bun。它不替代 npm 包。`release.yml` 照旧发布 `@sleep2agi/agent-network`、`@sleep2agi/agent-node`、`@sleep2agi/commhub-server`。

这一阶段**没有公开下载**。工作流的 `publish` 默认是关的。macOS 产物没有签名，也没有公证，不能当安装包发出去。

## 二进制里有什么

构建读的是未混淆的 TypeScript，不是 npm 包里那份混淆后的 `dist/bin/anet.cjs`。

| 你运行的 | 实际进入 |
|---|---|
| `anet …` | CLI（`agent-network/bin/cli.ts`） |
| `anet __hub …` | 内嵌的 Hub（`server/bin/commhub.ts`） |
| `anet __node …` | 内嵌的 agent-node（`agent-node/src/cli.ts`） |

`anet hub start` 在二进制里启动的是内嵌 Hub（`__hub`），不再执行 `bunx @sleep2agi/commhub-server@…`。`anet node start` 启动的是内嵌的 agent-node（`__node`）。用 npm 安装时这两处仍走原来的 `bunx` 和本机 `agent-node`。

`anet --version` 打印三行包版本，并另起一行报告这次构建的 bundle 版本：

```text
anet v<agent-network 的 package.json>
standalone bundle v<工作流传入的 version>

✓ agent-node v<agent-node 的 package.json>
✓ commhub-server v<commhub-server 的 package.json>
```

三个包版本来自被构建的那次提交。bundle 版本是工作流的 `version` 输入，可以和包版本不同。指定一个与内嵌版本不同的 `--version` 去 `anet hub start`，会被拒绝。

## 怎么构建

在 main 上，对那次提交的完整 40 位 SHA 触发 [cli-binary.yml](https://github.com/sleep2agi/agent-network/blob/main/.github/workflows/cli-binary.yml)。`publish=true` 时，这个 SHA 必须是当时 `main` 的祖先。

```bash
SHA=   # git rev-parse origin/main，40 位
VERSION=   # bundle 版本，对应 GitHub release cli-bin-v<version>；不是 npm 发包

gh workflow run cli-binary.yml --ref main \
  -f commit="$SHA" \
  -f version="$VERSION" \
  -f publish=false
```

等价的 API：

```bash
gh api --method POST \
  repos/sleep2agi/agent-network/actions/workflows/cli-binary.yml/dispatches \
  -f ref=main \
  -f inputs[commit]="$SHA" \
  -f inputs[version]="$VERSION" \
  -f inputs[publish]=false
```

矩阵目前只有两项，`fail-fast` 关闭：

- `linux-x64`，`ubuntu-24.04`，`bun-linux-x64`
- `darwin-arm64`，`macos-14`，`bun-darwin-arm64`

每一项都做 `anet --version`、`--help`、`anet __node --help`、`anet __hub` 的 `/health`，并要求文件不超过 110MB，同时写出 SHA256。构建来源用 GitHub 的 provenance attestation。

`publish=true` 且两条都绿时，才组装 `SHA256SUMS` 和 `anet-bin-manifest.json`（版本、每个目标的文件名 / sha256 / 大小、源提交、三个包版本），上传到 GitHub release `cli-bin-v<version>`。标签已存在则失败，不覆盖。

## 做不到的事

- **claude-agent-sdk** 的平台二进制（大约 235MB）不在这个文件里。第一次用这个 runtime 时仍按原来的方式下载。
- **node-pty** 不在这个文件里（Linux 没有可用的预编译包）。需要它的 runtime 仍在运行时单独取。
- **@openai/codex** 和 **@openai/codex-sdk** 不在这个文件里。
- **tmux、claude、codex、opencode、grok** 仍要用户自己装。二进制只替代 anet / Hub / agent-node 这三份进程。
- Codex 等 runtime 把 CommHub MCP 起成 `bun .anet/node-server.js`。脚本内容已经打进二进制，写到项目里的 `.anet/node-server.js`；**启动这个 MCP 的那一下仍然要 PATH 上有 bun**。`claude-agent-sdk` 和 `grok-build-acp` 是进程内接入，不经过这个文件。
- 二进制忽略 `ANET_AGENT_NODE_BIN`。内嵌的 agent-node 就是这次提交里的那一份，不能再指到另一个 `.js` 入口。
- 还没有 `linux-arm64`、`darwin-x64`、`windows-x64`。Windows 没有 Authenticode 证书，这一阶段不编 Windows。

## 签名

darwin 产物没有 Developer ID，也没有公证。从浏览器或 GitHub release 下载后，Gatekeeper 会拦截。CI 只在 runner 上、文件还没被隔离时做冒烟。**不要把去掉隔离属性写成安装步骤。** 给用户的 macOS 包要等公证做完。

公证需要的密钥现在都没有：`APPLE_CERTIFICATE_P12`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_TEAM_ID`，以及 App Store Connect API 的 `APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`APPLE_API_KEY`（或 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD`）。Windows 的 Authenticode 证书也还没有。

## 接下来

1. 给 macOS 签名并公证。Windows 等有证书后再加进矩阵。
2. 补上 `linux-arm64` 和 `darwin-x64`。
3. 把已签名的文件镜像到 ModelScope，路径 `cli/<version>/`。
4. 桌面端 daemon 的回退表写成固定 URL + sha256（与 `anet-bin-manifest.json` 同一份摘要）。
5. 可选：Tauri `externalBin` 带上这份文件。在那之前，桌面端仍用现在的安装方式。
