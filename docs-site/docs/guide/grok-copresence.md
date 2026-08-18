# Grok 人机共存 TUI（未发布）

::: danger 当前不可用
`grok-build-cli` 这条 runtime 路径**不要照旧文档使用** —— 不要执行 `anet node create ... --runtime grok-build-cli`。

🔴 **更正(2026-08-18 实测)**:原文写「`anet grok attach` 尚未进入 `latest` 或 `preview`」,**后半句不成立**。用真包跑二进制:

```
latest  2.2.21              anet grok attach → Unknown: grok
preview 2.3.0-preview.39    anet grok attach → Usage: anet grok attach <node>
```

⇒ **这个命令在 `preview` 里是存在的**,只是 `latest` 里没有。
**但「命令存在」不等于「这条共存路径可用」** —— 我只验到命令注册,没有验端到端可用性。
本页其余的告诫仍然成立:它仍在重新验收,不要当已发布功能用。
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
