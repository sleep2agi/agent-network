# 版本号体系

Agent Network 有两套版本号并行使用，第一次看可能困惑。这页讲清楚怎么读、哪个算 latest、什么时候各看哪个。

> 📋 **哪个整体版本对应哪些包版本**（权威矩阵，持续回填）：[docs/version/](https://github.com/sleep2agi/agent-network/blob/main/docs/version/README.md)

## 你会看到的两组数字

| 出现位置 | 例子 | 是什么 |
|---|---|---|
| `anet -v` 顶行 | `anet v2.2.21` | npm 包 `@sleep2agi/agent-network` 的版本 |
| `anet -v` Components | `agent-node` / `commhub-server` / dashboard 各自版本 | 各 npm 包独立的 patch / minor（确切版本以你机器上 `anet -v` 的实际输出为准）|
| [GitHub releases](https://github.com/sleep2agi/agent-network/releases) tag | `v0.10.15` | **bundle release** —— 几个 npm 包同步发版的命名锚点 |

## "latest" 指哪个

**面向用户操作**：`anet upgrade` 一键把 4 个 npm 包全升到 npm `latest`。每个包页面的 latest 标签即为权威，见 [@sleep2agi on npm](https://www.npmjs.com/org/sleep2agi)。

**面向 release 追踪**：每个 bundle release 的 [GitHub releases](https://github.com/sleep2agi/agent-network/releases) notes 里写清了那一波各 npm 包的确切版本号——**以该 release 的 notes 为准**。想知道自己现在装的确切版本，用 `anet -v`（4 个包都列）。⚠️ 自 `v0.10.15` 起，各包多为按需独立发小版本，npm `latest` 通常已领先最近一次 bundle wave——所以别把某个 `v0.10.x` tag 硬对成"当前 latest"，当前 latest 一律以 `anet upgrade` / npm 包页为准。

## 为什么两套并存

- **npm 包版本独立**：hotfix 可以只升一个包（比如只发一版 commhub-server 修 server bug，不强制 anet CLI 一起升）。每个包按 semver 独立演进。
- **bundle release 是节奏锚点**：每隔一段把"该一起升的"打包成 `v0.10.x` release 写在 GitHub releases 上，方便用户一次性看完整一波的 changelog 而不用翻 4 个 npm 页。

## 实操建议

- 查自己装了什么 → `anet -v`（4 个包都列）
- 查 release 节奏 / 一个 wave 包含哪些 fix → [GitHub releases](https://github.com/sleep2agi/agent-network/releases)
- 查单个包独立 hotfix → npm registry 上该包的 versions 列表
- 升 latest → `anet upgrade` 一键全升，不用自己挑 wave
- 切 preview → `anet upgrade --channel preview`；切回稳定频道 → `anet upgrade --channel latest`

## 下一步

- [升级指南](/guide/upgrade) —— 跨版本迁移 / 不兼容变更
- [Changelog](/changelog) —— 完整变更日志
