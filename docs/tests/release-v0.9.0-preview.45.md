# commhub-server 0.9.0-preview.45

## 为什么发这一版

app#225 桌面端「节点规则」区块调的是 hub 的五个新工具（`read_node_rules_file` /
`write_node_rules_file` / `get_rules_file_result` 给客户端，`get_rules_file_request` /
`ack_rules_file_request` 给节点），它们在主仓 #1755（`3edc357d`）里进 main，
但 npm 上的 `.44` 没有 —— 旧 hub 对桌面端表现为 `Tool read_node_rules_file not found`，
区块显示「当前 Hub 版本还没有规则文件工具，请先升级服务器」。

`.44` 之后改到 `server/` 的提交（`files: ["src","bin"]`，源码直发，除测试外都进包）：

| 提交 | PR | 内容 |
|---|---|---|
| `3edc357d` | #1755 | **主角** —— 节点规则文件五个工具 + 表 `node_rules_requests` + 门铃 `rules_file` |
| `b3b546db` | #1687 | external-schedule-edits 四个时间列按 UTC 解析，垃圾串不再 500 |
| `33035d2f` | #1651 | 服务端两处按 UTC 解析无时区时间戳 |
| `72ea5e4f` | #1632 | 「这个节点根本没有 daemon」不再说成「请显式传 daemon_node_id」 |
| `0a794fda` | #1643 | 19 个 beforeAll 显式 30 s 超时（测试） |
| `96818ecc` | #1633 | 两条测试上限 20_000 → 60_000（测试） |
| `7534dbc1` | #1613 | pushUserEvent 注释修正 |
| `57f4d1ac` | #1717 | CONTRIBUTING Quick start（文档） |

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.45
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.45
# hub 需要重启才会用新逻辑;新表 node_rules_requests 在启动时 CREATE TABLE IF NOT EXISTS,不用迁移
```

验收（SOP §2.5 四步）：

```bash
npm view @sleep2agi/commhub-server dist-tags.preview        # 期望 0.9.0-preview.45
npm pack @sleep2agi/commhub-server@0.9.0-preview.45
tar -xzf *.tgz
grep -rc 'read_node_rules_file'        package/src   # 期望 >0
grep -rc 'node_rules_requests'         package/src   # 期望 >0
grep -rc 'daemon_cannot_create_nodes'  package/src   # 正控:期望 >0
```

🔴 **判据先在已发布的 `.44` 上量过两侧**（2026-09-02 10:5x，`npm pack` 后裸 grep）：

```
.44:  read_node_rules_file        = 0    ← 目标串上一版确实不存在
.44:  node_rules_requests         = 0    ← 同上
.44:  daemon_cannot_create_nodes  = 11   ← 正控:grep 在这份产物上确实有效
```

这个包 `files: ["src","bin"]`、没有 build 脚本，发的是 TypeScript 源码，可以裸 grep；
**别把这条判据照抄到 `agent-network`**（那个包混淆，裸 grep 恒 0，见 SOP §2.5）。

promote 时 `must_contain` = `node_rules_requests`。

## 🔴 本次**故意没有**改 `PINNED_SERVER_VERSION`

`agent-network/bin/cli.ts` 里的 `PINNED_SERVER_VERSION` 保持原值。原因同 `.44` 那版：
`release-gate` 的 gate 2 拿这个常量去 `npm view` 核对**是否已发布**，提前写进去会让
发它的那个 run 被自己的 pin 卡死（2026-08-27 发 `.33` 时实测过）。

顺序是两步：1. 先发 `.45`（本 PR）；2. `.45` 出现在 npm 上之后，再单独改常量
（`tests/test766-bunx-preflight` 里那个字面量随第 2 步一起改）。

## 发布方式

`release-gate (v0)` workflow_dispatch：`package=commhub-server version=0.9.0-preview.45 publish=true`，
四道门全绿才 `npm publish --tag preview`。本机不发包。
