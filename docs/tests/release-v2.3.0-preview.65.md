# @sleep2agi/agent-network 2.3.0-preview.65 — release notes

四条 create/edit 修复，主题是**「傻瓜路径不该比带 flag 的路径设防更少」**。

- **`network_id` 现在会被持久化**（PR #1471，#1469 finding-2）：`saveProfile` 的白名单漏了它。
- **交互向导补上带名路径的护栏**（PR #1473，#1469 finding-1）：无名的 `anet node create` 在
  `createCommand` 里被 `if (!id) return createInteractiveCommand()` 短路，短路点**位于三道护栏之上**，
  于是面向新手的入口设防最少 —— 本地 hub 自探没跑、「先验 hub 再问 model/key」的顺序反了、
  `network_id` 缺失时抛未捕获错而不是给下一步。现在两条路径共用同一道门，**向导在打出任何东西
  之前先验环境**；带名路径的调用点位置未变，行为逐字不变。
- **裸 `--resume` 不再被静默丢弃**（PR #1475，#1469 finding-4）：无值 flag 被记成 `"true"`，
  而它此前被排除在「resume 请求」之外 ⇒ runtime 保持默认 ⇒ 整块 session 绑定逻辑被跳过，
  **连 TTY 的选单都进不去**。现在它算请求；非 TTY 且没给 id 时报错并给出两条可执行的下一步。
- **`--tools` / `--model` 在 `createProfileFromOpts` 里校验**（PR #1477，#1469 finding-3）。

本版把配套 pin 推到 `PAIRED_AGENT_NODE_VERSION = 2.5.0-preview.50`。
`PINNED_SERVER_VERSION` **保持 `0.9.0-preview.40`** —— 本批没有 server 改动。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.65 @sleep2agi/agent-node@2.5.0-preview.50
anet login
anet hub start
```

需要 Node.js ≥ 22.13。

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.65
cd ~/anodes && anet project restart
```

hub 不需要重启：server 版本本批未变（仍是 `0.9.0-preview.40`）。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1471 | #1469 finding-2 | `saveProfile` 白名单补上 `network_id` |
| #1473 | #1469 finding-1 | 交互向导与带名路径共用环境护栏，且先验环境再要输入 |
| #1475 | #1469 finding-4 | 裸 `--resume` 视为 resume 请求，非 TTY 无 id 时可操作退出 |
| #1477 | #1469 finding-3 | `--tools` / `--model` 校验 |
| — | — | pin：agent-node `2.5.0-preview.50`；server 保持 `.40` |

**未包含**：issue #1474 finding-2（pgid）尚未合入 main，走 agent-node `2.5.0-preview.51` fast-follow。
