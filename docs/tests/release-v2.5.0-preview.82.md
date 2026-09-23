# agent-node 2.5.0-preview.82

`.81` 之后 `agent-node/` 两个提交:

| 提交 | PR | 内容 |
|---|---|---|
| c67ec9fc | #1971 | 显式选择 codex 二进制并在启动日志打印(#1969) |
| b3bf3182 | #1968 | grok 共存 option A:未验证 grok 的拒起报错附可复制的恢复命令(#1615);grok-build-cli 各入口标「预览」 |

## 本版修的是什么

**#1969 codex 太旧**:agent-node 依赖 `@openai/codex ^0.133.0`,干净安装(私有前缀 / 新机器 / npx)会在 `agent-node/node_modules` 嵌套 codex 0.133,codex-sdk 用它 → 新模型(如 `gpt-5.6-sol`)首件即 `400 The '<model>' model requires a newer version of Codex`。DEV 旧的全局安装能用,是碰巧解析到了全局装的 codex CLI。2026-09-23 滚动 DEV 30 台 codex-sdk 节点时在金丝雀上抓到。

改法:按顺序选 codex 二进制并传给 SDK 的 `codexPathOverride`:① 节点配置 `codexBin`;② 环境变量 `ANET_CODEX_BIN`;③ PATH 上的 `codex`,**仅当**其 `--version` ≥ 内置 `@openai/codex` 版本;④ 否则用 SDK 内置。每次版本探测 3 秒超时,失败即落到下一项。启动日志一行 `[codex] binary: <path> (<version>) source=<config|env|path|bundled>`。`codexBin` 进 profile 白名单;**不**进 hub `update_node_config`(它指定节点要执行的可执行文件,远程可改 = 远程执行)。

**#1968 grok 共存(预览)**:PATH 上的 grok 未经验证时,拒起报错会在 `~/.grok/downloads`、`~/.grok/bin` 里找已验证版本并给出可复制的 `GROK_BINARY=<path> anet node start <alias>`;找不到就明说。`anet setup` / `anet node create` 选择器与 help、文档 grok-tui / grok-copresence(中英)都标「预览 / Preview」并指向稳定的 `grok-build-acp`;运行时 id 不变,已有节点不受影响。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.82
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.108 @sleep2agi/agent-node@2.5.0-preview.82
```

🔴 **两个包要一起升。** 配对是精确的(`.108 ↔ .82`)。升级后看每个 codex 节点启动日志里的 `[codex] binary:` 行,确认选到的版本够新;宿主 PATH 上没有更新的 codex 时,装一个(`npm i -g @openai/codex@<当前>`)或在节点配置写 `codexBin`。

## 证据

- `codex-bin.test.ts` 10 pass(假 codex 可执行文件);`profile-serialize-codex-bin.test.ts` 2 pass;codex 相关套件 138 pass / 0 fail;六个变异(去掉「不比内置旧」判断、override 不传到 SDK、env 先于 config、无超时、旧序列化器等)各红一条,恢复全绿。
- 在 Node 下(不是 Bun)跑构建产物:找到内置 codex 0.133.0,选了 PATH 上更新的 codex —— Bun 不强制 `exports`,单测覆盖不到 `ERR_PACKAGE_PATH_NOT_EXPORTED` 那个坑,这一条只有 Node 真跑能证明。
- grok 套件 299 pass / 0 fail;`grok-binary-pin.test.ts` 新增 4 条,两处变异各红一条。
- typecheck 棘轮 81 = 基线;doc symbol/source pins、version claims rc=0。

## 未覆盖(明写)

- 依赖下限(`@openai/codex ^0.133.0`)本版未抬,需要先做兼容性核对。
- `report_status` 尚未上报选到的 codex 路径/版本(只在节点日志)。
- 发出后在 DEV 一台 `gpt-5.6-sol` 节点上用**干净前缀**安装验一次(不做前缀手工修补),确认日志选到 PATH 上的新 codex 且首件正常。

## promote 时的 must_contain

`"version": "2.5.0-preview.82"`
