# @sleep2agi/agent-network 2.3.0-preview.42 — release notes

本版把 Codex 共存模式直接放进 `anet node create` 的交互式 runtime 菜单。
`codex-cli` **不是默认选项**；用户主动选择它时，会直接记录共存模式，不再出现第二次模式询问。
`codex-sdk` 仍是后台无头运行时。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.42
```

## Upgrade

```bash
anet upgrade
# 或仅升级 preview CLI
npm install -g @sleep2agi/agent-network@preview
```

## 交互行为

```bash
anet node create codex-human
# 在 runtime 菜单中主动选择：codex-cli — Codex 共存 TUI
anet node start codex-human
```

- 选择 `codex-cli` 会自动写入 `codexCopresence: true`。
- 不会把 `codex-cli` 设为默认项。
- 不会再额外询问 headless / co-presence 模式。
- 显式命令 `--runtime codex-cli` 行为相同。
- 旧命令 `--runtime codex-app-server --copresence` 保持兼容。

## Verification (pre-publish)

- `test750`：Docker 内真实 PTY 发送方向键和 Enter，验证交互菜单选择、配置落盘和普通 `node start` 路由；**10 groups / 80 assertions / 0 failures**。
- `agent-network` typecheck/build：Docker 内通过。
- `npm pack`：Docker 内成功生成 `@sleep2agi/agent-network@2.3.0-preview.42` tarball；发布前还会从合并后的精确 `origin/main` 重新打包并安装烟测。
