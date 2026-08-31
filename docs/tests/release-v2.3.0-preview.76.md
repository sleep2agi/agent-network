# `@sleep2agi/agent-network@2.3.0-preview.76`

## 为什么发这一版：**一整批「命令没坏，但它说的话没用」**

`.75` 之后 main 上进了 22 个改到包内容的 PR。它们几乎全是同一族：
**命令跑通了、退出码是 0，而它印给用户的那句话要么指错方向、要么排版歪掉、要么根本是乱码。**

| 用户敲的 | `.75` 会看到 | `.76` |
|---|---|---|
| `anet daemn` | `Did you mean: anet demo?`（指向另一个真实存在、干别的事的命令） | `Did you mean: anet daemon?` |
| `anet goal --help` | 126 行**全局**帮助 | `anet goal <command>` |
| `anet info 通信IM妞` | `Node "…" not found.`（就这一句） | `Did you mean "通信IM牛"?（anet node ls lists all 16）` |
| `anet demo` | `[32m●[0m debate …`（**字面量乱码**，4 处） | `● debate …` |
| `anet node ls` | 中文别名把每一行推歪；`claude-code-cli` 顶偏 STATUS | 每行列位一致 |
| `anet doctor` | `○ stopped`（没说量的是什么） | `○ 本机无存活进程 (.pid 记的 308103 已不在)` |
| `anet info` 的 `updated:` | `2026-08-31 00:23:11`（UTC 值裸打，UTC+8 用户读成 8 小时前） | `… UTC（2 分钟前）` |

## 逐条

### 帮助与提示指错方向

- **#1665** did-you-mean 名单是**手写**的，旁边写着 "keep in sync" —— 已经漂了 4 个：
  `daemon` / `grok` / `opencode` / `quickstart`，恰好是最新最可能被半记住敲错的那批。
  配了一道**从 switch 反推**的门，不再是第五张手写名单。
- **#1668 / #1670** `anet goal/token/batch/opencode/network/channel/session --help` 打的是全局帮助。
  而这些命令**各自都在自己的函数里写了 `sub === "--help"` 分支** —— 那几段 help 一次都没被执行过。
  同一个 bug 的第三次（`#240` 修过 hub，`#717` 修过 daemon）。
- **#1667** `Node "x" not found.` 光秃秃地出现在 16 处，而**同一个文件里**另有 7 处跟着
  `Create it first: …`。现在按「0 个节点 / 有相近的 / 有节点但没相近的」三种现实分开说。
- **#1652** 认不出的 daemon 子命令不再被导向「会改变状态」的那几个。
- **#1644 / #1649** `anet status` 不再把 blocked 说成 "not progressing"；offline 分「刚停」与「掉了三天」。

### 排版：三层，逐层修

- **#1663** 单元格先折叠空白再截断（任务正文里的换行会打断整张表）+ 按**显示列**补齐。
- **#1671 / #1673** 列宽写死：`node ls` 的 RUNTIME 是 14 而 runtime 名最长 16；
  `status`/`tasks` 的 STATUS 是 8 而 `delivered` 是 9。改成从**唯一真源/本次数据**算。
- **#1674** 还有 9 处补齐在数**码元**不数显示列 —— 本机 alias 几乎全是中文。
- **#1677** `anet demo` 的 8 处颜色码**没有 ESC 前缀**，用户看到的是字面量 `[32m`。
  本文件里带 ESC 的真上色共 **0** 处 ⇒ 修法是删掉，不是补 ESC。

### 时间与诊断

- **#1664 / #1653** hub 的时间戳是**无时区的 UTC**，裸打给 UTC+8 用户会读成 8 小时前。
  🔴 这不是假想：2026-08-31 有人据此差点报出「舰队心跳陈旧 8.3 小时」。
- **#1672** `doctor` 说 `stopped`、`node ls` 说 `idle` —— 两个都是真的，它们量的不是同一件事
  （本机 `.pid` vs CommHub）。现在各自说清量的是什么，并明说两者可以不一致。
- **#1655 / #1656 / #1660** doctor：三个 runtime CLI 报实际版本；CommHub 行同时摆出
  「hub 自报」与「本机钉的」；**0 个节点不再报成 error**（那是全新安装的预期状态）。
- **#1636 / #1637 / #1657** Windows 归属探测：整张进程表只枚举一次（实测单次调用占 waited 的 96%），
  且把耗时**打在成功路径上** —— 只在失败时说话的仪表验不了自己促成的修复。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.76
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.76
# daemon 是长驻进程,换包要重启才生效:
anet daemon restart <daemon>
```

## 边界

- 本条只发 `@sleep2agi/agent-network`。`agent-node`（3 个提交）与 `commhub-server`（2 个提交）
  同样有未发布改动，**不在本次范围**。
- 版本 pin（`PINNED_SERVER_VERSION` / `dashboardReleaseTag`）**未随本次改动** ——
  按 RELEASE-SOP：本次要发的版本不能提前写进那些常量，否则 `release-gate` 的 gate 2 会拿它去
  `npm view` 核对而卡死这一发。
