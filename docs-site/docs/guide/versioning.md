# 版本号体系

Agent Network 有两套版本号并行使用，第一次看可能困惑。这页讲清楚怎么读、哪个算 latest、什么时候各看哪个。

> 📋 **哪个整体版本对应哪些包版本**（权威矩阵，持续回填）：[docs/version/](https://github.com/sleep2agi/agent-network/blob/main/docs/version/README.md)

## 你会看到的两组数字

| 出现位置 | 例子 | 是什么 |
|---|---|---|
| `anet -v` 顶行 | `anet v2.3.0-preview.N` | npm 包 `@sleep2agi/agent-network` 的版本 |
| `anet -v` Components | `agent-node` / `commhub-server` / dashboard 各自版本 | 各 npm 包独立的 patch / minor（确切版本以你机器上 `anet -v` 的实际输出为准）|
| [GitHub releases](https://github.com/sleep2agi/agent-network/releases) tag | `v0.10.15` | **bundle release** —— 几个 npm 包同步发版的命名锚点（旧做法，最后一条是 2026-06-17 的 `v2.2.15`，之后不再发 GitHub release） |

## "latest" 指哪个

**面向用户操作**：`anet upgrade` 一键把 4 个 npm 包全升到 npm `latest`。每个包页面的 latest 标签即为权威，见 [@sleep2agi on npm](https://www.npmjs.com/org/sleep2agi)。

**查通道当前指向**：`npm view @sleep2agi/agent-network dist-tags`（`agent-node`、`commhub-server` 同理）。想知道自己现在装的确切版本，用 `anet -v`（各包都列）。npm 包自 2026-06 起按需独立发版，不再发 GitHub bundle release；主仓的 [GitHub releases](https://github.com/sleep2agi/agent-network/releases) 只保留到 2026-06-17 的 `v2.2.15`，不代表当前版本。桌面端安装包在 [agent-network-app releases](https://github.com/sleep2agi/agent-network-app/releases) 发布。

## 为什么两套并存

- **npm 包版本独立**：hotfix 可以只升一个包（比如只发一版 commhub-server 修 server bug，不强制 anet CLI 一起升）。每个包按 semver 独立演进。
- **bundle release 是早期的节奏锚点**：2026-06 之前每隔一段把"该一起升的"打包成 `v0.10.x` release 写在 GitHub releases 上。现在各包独立发版，变更记录见 [Changelog](/changelog)。

## 实操建议

- 查自己装了什么 → `anet -v`（4 个包都列）
- 查通道当前指向 → `npm view @sleep2agi/agent-network dist-tags`
- 查变更 → [Changelog](/changelog)；查单个包的全部版本 → `npm view @sleep2agi/agent-network versions`
- 升 latest → `anet upgrade` 一键全升，不用自己挑 wave
- 切 preview → `anet upgrade --channel preview`；切回稳定频道 → `anet upgrade --channel latest`

## 下一步

- [升级指南](/guide/upgrade) —— 跨版本迁移 / 不兼容变更
- [Changelog](/changelog) —— 完整变更日志

## 初始管理员密码的版本差异

- **`≥ 2.2.22-preview.4`**（2026-06-28，PR [#264](https://github.com/sleep2agi/agent-network/pull/264) 修 [#261](https://github.com/sleep2agi/agent-network/issues/261)；现在的 `latest` 与 `preview` 都在此范围）：首次 `anet hub start` 打印**一次性随机密码**，只显示这一次，请当场保存；首次登录提示改密。
- **`≤ 2.2.22-preview.3`（含 `2.2.21` 及更早）**：固定默认 `admin` / `anethub`，登录后必须立即 `anet passwd` 改密。

任何公网部署，无论哪个版本，都必须登录后立即 `anet passwd`。
