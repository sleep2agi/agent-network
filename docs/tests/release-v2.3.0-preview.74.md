# agent-network 2.3.0-preview.74

`.73` 之后有 3 个提交改到了 `agent-network/`，且都落在 `files: ["dist"]` 覆盖的范围内
（`bin/cli.ts` 与 `src/` 都编进 `dist`）—— **这一条是查过的，不是假设**：合进 main 不等于进 tarball。

| 提交 | PR | 内容 |
|---|---|---|
| `3371eabc` | #1601 | **`anet daemon restart <name>`** —— 重启 daemon 不再需要用户拼两条命令 |
| `b9d53f57` | #1604 | `PINNED_SERVER_VERSION` → `0.9.0-preview.44`，并对齐第三处 server pin |
| `11bbb5d2` | #1589 | `describeCreateRejection` —— 拒绝载荷走同一份修法表 |

## 为什么这一版值得发

`anet daemon restart` 在 `.73` 里**不存在**。实测（容器内跑真包）：

```
$ npx @sleep2agi/agent-network@2.3.0-preview.73 daemon --help
Subcommands:
  init / start / up / list          ← 没有 restart
```

文档那一页是诚实的，自带「你的版本有没有这条？没有的话用两步」的提示，所以用户不会卡住；
但 #1601 的价值要到这一版才真正到用户手里。

## 版本戳同步

| 位置 | 值 |
|---|---|
| `agent-network/package.json` | `2.3.0-preview.74` |
| `agent-network/package-lock.json` | 同上（2 处） |
| `agent-network/src/opencode-agent-node-pair.ts` `PAIRED_AGENT_NETWORK_VERSION` | 同上 |
| `docs-site/docs/guide/getting-started.md` `version-claim` + 表格行 | 同上 |
| `docs-site/docs/en/guide/getting-started.md` 同上 | 同上 |

全仓复扫 `2.3.0-preview.73`：**0 处遗留**（本目录下的历史 release notes 除外）。

## 一条随版本失效的断言，已重新验过

两份 getting-started 里有一行：「生成密码的 `server/src/auth.ts` 自 `.49` 发布起**零提交**，逻辑逐字未变」。
这是上一版写下的事实，换版本号时**不能照抄**——它的前提也换了。重新量过：

```
git log origin/main --since=2026-08-27 --oneline -- server/src/auth.ts   →  0
```

仍然成立，才搬到 `.74`。

## 发布方式

走 GitHub Actions（`release-gate (v0)` 发 preview）。**不从本机 publish，不从非 main 分支出对外产物。**
`latest` 保持 `2.3.0-preview.47` 不动 —— 升 `latest` 需要 owner ACK。
