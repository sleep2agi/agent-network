# 单文件 anet 可执行文件（运行手册）

给维护者。用户向的说明在 docs-site：[单文件可执行文件](../docs-site/docs/guide/standalone-binary.md)（英文：[en](../docs-site/docs/en/guide/standalone-binary.md)）。

这是 npm 之外的一条安装路径。`release.yml` 不改，也不要在这个工作流里 `npm publish`。Phase 1 只落地构建和冒烟。不要改 #906 拥有的版本常量。

## 产物

`scripts/build-anet-bin.mjs` 用 Bun `1.3.14` 执行 `bun build --compile --minify`，入口是 `agent-network/bin/anet-bin.ts`（未混淆源码）。编译期间改写 `agent-network/src/standalone-build-stamp.ts`，结束时恢复成入库的那份（`standalone: false`）。不要把 `standalone: true` 的 stamp 提交进去。

| argv | 进程 |
|---|---|
| （默认） | CLI |
| `__hub` | 内嵌 commhub-server |
| `__node` | 内嵌 agent-node |
| `__print-config-token` | 从 `$ANET_EXTAPP_CONFIG` 读 config.json 的 `token` 写到 stdout。给 Codex external-appserver 用，替代编译后无法执行的 `node -e` |

`--external` 固定排除 `@anthropic-ai/claude-agent-sdk`、`@openai/codex`、`@openai/codex-sdk`、`node-pty`。

`anet --version` 的第一行是 agent-network 的 package.json 版本。下一行是 `standalone bundle v<bundle>`。bundle 版本是工作流的 `version` 输入（本地构建用 `--bundle-version`，省略时等于 agent-network 的版本）。agent-node 和 commhub-server 的版本也来自各自的 package.json，写进同一份 stamp。

## 触发

工作流：`.github/workflows/cli-binary.yml`。`workflow_dispatch` 输入：

| 输入 | 含义 |
|---|---|
| `commit` | 40 位 SHA。`publish=true` 时必须是当时 `origin/main` 的祖先（`.github/scripts/verify-release-main.sh`，与 release.yml 同一支脚本） |
| `version` | bundle 版本，也是 release 标签 `cli-bin-v<version>` |
| `publish` | 默认 `false`。`true` 且矩阵全绿才创建 GitHub release |

```bash
gh workflow run cli-binary.yml --ref main \
  -f commit="$SHA" \
  -f version="$VERSION" \
  -f publish=false

gh api --method POST \
  repos/sleep2agi/agent-network/actions/workflows/cli-binary.yml/dispatches \
  -f ref=main \
  -f inputs[commit]="$SHA" \
  -f inputs[version]="$VERSION" \
  -f inputs[publish]=false
```

不要为了验证这个手册去点 publish。PR 上的 `pull_request` 路径用 `publish=false`、bundle 版本 `0.0.0-pr`，只编译当前变更并冒烟。

矩阵（`fail-fast: false`）：`ubuntu-24.04` + `bun-linux-x64`，`macos-14` + `bun-darwin-arm64`。Bun 与 release.yml 一样钉在 `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`、`1.3.14`。

每条腿：`anet --version` 对得上 stamp，`--help`，`__node --help`，`__hub` 的 `/health` 为 200 且 `version` 等于 commhub-server 的包版本，体积 ≤ 110MB，SHA256 文件。`actions/attest-build-provenance@v2` 只在 `workflow_dispatch` 运行；来自 fork 的 `pull_request` 不提供 OIDC 请求环境，因此 PR 只编译、冒烟并上传 artifact，不会伪造来源证明。

发布腿只在 `workflow_dispatch` 且 `publish=true` 且两条都成功时跑。它核对每条腿的三个包版本和 bundle 版本一致，写出 `SHA256SUMS` 与 `anet-bin-manifest.json`，再 `gh release create cli-bin-v<version>`。标签已存在就失败。

## 限制

- claude-agent-sdk 的平台二进制、node-pty、Codex SDK 保持外部、按需获取。
- tmux、claude、codex、opencode、grok 仍由用户安装。
- `.anet/node-server.js` 的脚本来自二进制内的预打包文本；Codex 等 runtime 仍用 PATH 上的 `bun` 去启动它。`claude-agent-sdk` 和 `grok-build-acp` 不走这个文件。
- 二进制忽略 `ANET_AGENT_NODE_BIN`。
- 未做：`linux-arm64`、`darwin-x64`、`windows-x64`。

## 签名（这一阶段跳过）

工作流里对应步骤是注释，不会执行。

macOS 之后需要 Developer ID Application 证书和公证。密钥名：`APPLE_CERTIFICATE_P12`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_TEAM_ID`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`APPLE_API_KEY`（或 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD`）。未公证的 darwin 文件只在 CI runner 上冒烟。下载后会被 Gatekeeper 拦住。不要把 `xattr -d com.apple.quarantine` 写成安装办法。

Windows 还没有 Authenticode 证书，所以矩阵里没有 `windows-x64`。

## 推广顺序

1. 签名并公证 macOS。有证书后再加 Windows。
2. 补 `linux-arm64`、`darwin-x64`。
3. ModelScope 镜像放在 `cli/<version>/`。
4. 桌面端 daemon 的回退表使用固定 URL + 与 manifest 相同的 sha256。
5. 可选：Tauri `externalBin`。在那之前桌面端不改安装方式。
