# agent-node 2.5.0-preview.230

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.264** 精确配对。

## Why

- **修复 `agy models` Tab 分隔解析（`#3869` / `#5321`）**：`parseAgyModels` 识别 `<slug>\t<Display Name>` 格式，Antigravity 节点心跳可完整上报全部可用模型至 `agy_models`。
- **心跳 `secret_keys` 合并 `node-secrets.json` 键名（`#3871` / `#5505`）**：`collectSecretKeys` 仅读取并上报键名（不泄值、拒符号链接），消除独立节点保存密钥后 `secret_keys` 仍为 `null` 的断层。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.230 @sleep2agi/agent-network@2.3.0-preview.264
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.230
anet upgrade
```
