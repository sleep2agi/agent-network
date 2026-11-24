# @sleep2agi/agent-network (CLI) 2.3.0-preview.263

与 `@sleep2agi/agent-node` **2.5.0-preview.229** 精确配对（`PAIRED_AGENT_NODE_VERSION`）。

## Why

- **source resume 前 OpenCode 二进制被拒时写明具体原因**（`#3862`）：不再只报笼统拒绝，启动排查可直接定位被拒二进制与原因。
- **配对更新**：指向 `agent-node@2.5.0-preview.229`（含 `request_secret` / `reply_secret_request` 聊天密钥卡片、Antigravity 报错收尾、OpenCode V2 无原因失败指引、Hub PostgreSQL 兼容修复；详见该版说明）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.263 @sleep2agi/agent-node@2.5.0-preview.229
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.229
anet upgrade
```

## 运维提示

- `reply_secret_request` / 密钥卡片字段的 Hub 侧生效**需 Hub 运维重启 `commhub-hub`**。

## 未验

- 聊天密钥卡片三端联调（Hub + App + Dashboard）需在主 Hub 重启生效后做端到端复验；Windows 上的已知问题见 `2.3.0-preview.259` 的说明。
