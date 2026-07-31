# Grok 人机共存 TUI（未发布）

::: danger 当前不可用
`grok-build-cli` 和 `anet grok attach` **尚未进入 npm `latest` 或 `preview`**。不要照旧文档执行 `anet node create ... --runtime grok-build-cli`；当前发布包不包含这条路径。
:::

项目中已有让人和网络任务共享同一个 Grok TUI 的候选实现，但它仍在重新验收，不能视为已发布功能。进度与实测证据见 [Issue #537](https://github.com/sleep2agi/agent-network/issues/537) 和 [Draft PR #538](https://github.com/sleep2agi/agent-network/pull/538)。

## 现在可以用什么

- `grok-build-acp`：当前正式 Grok runtime，通过 `grok agent stdio` 执行网络任务；**不能 attach 到同一个 TUI**。
- `grok`：可直接在终端使用 Grok CLI，但这不会把该 TUI 变成 Agent Network 共存节点。

```bash
grok login
anet node create grok-agent --runtime grok-build-acp
anet node start grok-agent
```

功能正式进入发布包后，本页才会恢复安装与 attach 步骤。发布频道说明见[版本说明](./versioning.md)。
