# agent-node 2.5.0-preview.58

`.57` 之后改到 `agent-node/` 的提交（`files: ["dist","README.md"]`，除测试/注释外都进包）：

| 提交 | PR | 内容 |
|---|---|---|
| `3edc357d` | #1755 | **主角** —— app#225 节点规则文件（CLAUDE.md / AGENTS.md）远程读写：SSE `rules_file` 门铃处理器 + 连上后补拉 |
| `1b35b716` | #1723 | daemon 权限闸建议 `chmod go-w`，并说明下次 `npm install -g` 会改回去 |
| `8bdda047` | #1695 | daemon #1635 的 Fix 文案能 `bash -n` 过 |
| `f3a0295b` | #1682 | daemon `anet_bin_source` 报错点名真读的文件 + 免 root 的路 |
| `72ae02a4` | #1675 | Linux 自动装 claude 的兜底，`--prefix` 指构建机目录 |
| `49b93b8a` | #1662 | #1645 上下文压力打在成功路径上 |
| `5ff76435` | #1646 | codex / claude 超时报错说测到的那个数 |
| `96818ecc` | #1633 | 两条测试上限 20_000 → 60_000（测试文件，不进包） |
| `16542789` | #1612 | 两处「已发布最高是 .56」改成不会腐烂的写法（注释） |

## 这一版带给用户什么

桌面端（agent-network-app v0.2.43，#227）节点详情页的「节点规则」区块要节点端配合：
节点收到 hub 的 `rules_file` 门铃后 `get_rules_file_request` 拉请求，按自己的 `RUNTIME`
定文件名（`claude` → `CLAUDE.md`，其余 → `AGENTS.md`），只在 `process.cwd()` 下读/写
（临时文件 + rename，256 KB 上限），`ack_rules_file_request` 回报。

🔴 整条链路没有路径参数：hub 工具入参只有 node id + content；节点侧
`resolveRulesFilePath(workDir, runtime)` 的输入里没有任何调用方可控的东西。

没升到 `.58` 的节点：桌面端会在 60 s 后显示「节点没有响应：可能离线，或它的
agent-node 版本还不支持规则文件（需要 2.5.0-preview.58+）」，其它功能不受影响。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.58
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.58
# 🔴 门铃处理器在**长驻进程内** —— 换包对已经在跑的节点没有任何影响,必须重启:
anet daemon restart <daemon>        # 需要 anet ≥ 2.3.0-preview.74
# 早于 .74 的 anet 用两步:
anet node stop <name> && anet node start <name>
```

升级并重启之后,桌面端节点详情的「节点规则」区块从「节点没有响应」变成能读到内容;
没重启的节点表现和没升级一样(60 s timeout)。

## 证据

- `tests/test1755-rules-file-e2e`（真 hub + 真 agent-node，Docker）：10/10，含离线 60 s timeout
  与「文件名映射改成 pwned.md 套件必红」的 witnessed-red。
- `agent-node/src/runtime/rules-file.test.ts` 9 条（L0 + test725）；
  `server/src/rules-file-transport.test.ts` 10 条（test798）。

## promote 时的 must_contain

`GrokModelSwitchArgvError`（`.57` 起就有）不能区分 `.57` / `.58`；`.58` 独有的字符串用
`[rules-file] doorbell received`（agent-node/src/cli.ts 的 log 文案，`.57` 的 tarball 里没有）。
