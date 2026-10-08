# CommHub v0.9.0-preview.115

本版只包含 `0.9.0-preview.114`（发版合并 `5b3f75a4`，#2500）之后合入的两项 Hub 改动：

| 提交 | PR | 内容 |
|---|---|---|
| `07e537e3` | #2502 | 建节点和改名拒绝换行、制表符、C0/C1 控制字符及 Unicode 行分隔符；新增只读存量 alias 扫描脚本 |
| `a76412c3` | #2504 | MCP `schedule_update` 新增可选 `base_revision`；版本落后时返回 `revision_conflict` 和 `current_revision`，不写库 |

`git log 5b3f75a4..a76412c3 -- server/` 只列出以上两个提交。

## 你会看到的变化

- **节点名更安全。** 新建节点或改名时，alias 含控制字符会返回 `node_alias_invalid`，避免日志与定时任务来源前缀被拆行。普通 Unicode、中文和既有合法名字不受影响。
- **定时任务编辑可防止覆盖。** Agent 可把上次读到的 revision 作为 `schedule_update.base_revision` 传回；若当前 revision 已变化，Hub 返回 `revision_conflict` 与 `current_revision`，调用方应刷新后重试。不传该参数的旧 Agent 保持原有行为。
- **存量只读盘点。** `bun server/scripts/scan-node-aliases.ts <数据库副本>` 只读列出不合规 alias，不自动修改。生产盘点应只对只读副本运行。

## 数据库、兼容与回滚

- 本版没有数据库 schema 变更，也没有新增必填配置。
- 可以回滚到 `0.9.0-preview.114`；回滚后控制字符校验和 `base_revision` 冲突保护消失，已有数据不会被改写。
- `.111` 的令牌签发器约束继续有效：同一数据库上的签发进程必须保持同版本，不能回滚到 `.111` 或更早版本。

## 检查

- `tests/hub-release-compat`（Docker，一次性 Hub，`--cpus=2`）：候选 main `a76412c3` 加版本号，基线 npm `0.9.0-preview.114`，App `desktop-v0.2.222`。
  - A1 / A2：各 `steps=62`、`unexpected=0`、`check_failures=0`。
  - B：`.114 → .115 → .114 → .115`，`upgrade_check_failures=0`；旧 App 的完整任务列表保持逐字节一致。
  - `tools/list` 只给 `schedule_update` 增加一个可选属性，既有工具和必填参数不变。
- #2502：Hub create / rename 回归与去掉校验的变异已通过；只读扫描在生产库只读副本上结果为 0 条不合规记录。
- #2504：SQLite 真 HTTP 与工具字节门 27/27；PostgreSQL ladder level 6 / floor 6（schedule Agent 15/15）；去掉 revision 比较的变异按预期失败。

本说明不代表已发布。只允许通过 `release.yml` 从包含上述改动的完整 main SHA 发布：
包 `@sleep2agi/commhub-server`，版本 `0.9.0-preview.115`，渠道 `preview`。

## Install

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.115
```

安装命令本身不会切换生产进程。

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.115
```

升级前先备份数据库，并按生产 runbook 验证版本与健康检查。

## 回滚

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.114
```

回滚到 `.114` 不需要回退数据库；控制字符校验和 `base_revision` 保护会暂时不可用。不要覆盖已发布版本，包内不含生产数据、用户、网络成员或密钥。
