# agent-node 2.5.0-preview.114

自 `.113`（发版合并 `30ecfc86`，#2411）以来，`agent-node/` 有 6 个改动（`git log 30ecfc86..origin/main -- agent-node/`）：

| 提交 | PR | 内容 |
|---|---|---|
| 078540c5 | #2418 | #603：macOS 上 daemon 启动的子进程 PATH 加入 `/opt/homebrew/bin`、`/opt/homebrew/sbin` |
| 0589c4df | #2417 | #596：daemon 的 `stop_node` / `delete_node` 真正关掉 Codex TUI 共存节点 |
| ecb5a3f0 | #2422 | #448 回归：按字节读 `/proc/<pid>/environ`，中文名节点不再每个任务都被拒 |
| 54a9ba37 | #2421 | #594 第 1 步：codex 节点向 Hub 上报登录指纹和「与几个节点共用登录」 |
| 38f27f36 | #2424 | #612 第 1 步：起 codex app-server 前先等内存 / 负载降下来 |
| ec30acac | #2420 | #605：`create_node` 的 `flags.timeout` 统一按毫秒 |

（另：#2423 只修测试 test656，不进包。）

## 你会看到的变化

- **中文名的 codex 节点恢复可用（#2422）。** 从 `.96` 起，别名含中文（或其他非 ASCII 字符）的 `codex-app-server` 节点每个任务都报 `refusing to use the owned app-server … (#448 fail-closed)`，原因是读 `/proc` 环境变量时把 UTF-8 当成了 latin1，路径永远对不上。现在按字节严格解码，中文路径能正确比对；无法解码的仍按「不一致」拒绝，安全性不变。卡死 app-server 的自动恢复对中文名节点也一并修好。
- **在 App 里停止 / 删除 Codex TUI 共存节点，会真的停掉（#2417）。** 以前 daemon 的 `stop_node` / `delete_node` 只结束桥接进程，codex app-server、TUI 和两个 tmux 会话还在跑。现在 daemon 会在节点目录里执行 `anet node stop <别名>`，按节点身份标记收尾，不会碰别的节点；收尾失败时回 `stop_failed` 并保留节点目录。同时修掉：启动器 5 秒内正常退出时被误判为 `runtime_capability_check_failed`、进而吊销正在运行节点的令牌的问题。
- **Mac 上 daemon 能找到 Homebrew 装的 bun / tmux / codex（#2418）。** Apple 芯片 Mac 的 Homebrew 装在 `/opt/homebrew/bin`，以前 daemon 子进程的 PATH 里没有它，在 Mac 上用 App 建共存节点会因找不到这些工具而失败（按代码推断，未在真 Mac 上复现）。Linux / Windows 不变。
- **超时单位统一为毫秒（#2420）。** `create_node` 的 `flags.timeout` 以前按 `1..86400` 校验（像秒），节点却按毫秒执行：填 `600` 想要 10 分钟，实际是 0.6 秒，所有任务都超时。现在 daemon 和本地 `update_node_config` 统一为：`0`（不限）或 `1000..3600000` 毫秒（例：`600000` = 10 分钟），`1..999` 直接拒绝并说明原因。已有节点配置不迁移；如果你的节点 `timeout` 是按秒填的小数字，请用 `update_node_config` 改成毫秒。
- **起 codex app-server 前先看机器余量（#2424）。** 可用内存低于 4 GB 或 1 分钟负载高于 2 × CPU 核数时，节点会等待（每 15 秒复查，日志说明原因），最多等 10 分钟后照常启动，不会一直起不来。可用 `ANET_START_MIN_MEM_MB`、`ANET_START_MAX_LOAD_PER_CPU`、`ANET_START_GATE_MAX_WAIT_SEC` 调整，`ANET_START_MEM_GATE=0` 关闭。只作用于 agent-node 自己拉起的 app-server（共存的 `<别名>-appsrv` 不受管），批量升级时仍请分批（每批 ≤3 个）。
- **codex 节点上报登录指纹（#2421）。** 节点向 Hub 报告 `health.codex_login = { fingerprint, shared_with, shared_home_with, codex_home }`：指纹是 refresh token 哈希的前 8 位，不含任何令牌、账号或邮箱。`shared_with > 0` 表示有别的节点和它共用同一个 Codex 登录，会互相踢下线。这一版只上报数据，还没有界面；冲突提示照旧打印在节点日志里，但只在冲突节点集合变化时打印。

## 与 Hub 的配合

- #2420 和 #2421 都有 Hub 侧改动，**不在当前 Hub `0.9.0-preview.106` 里**（它们在 `.106` 发版之后才合入）。在 `.106` Hub 上：
  - `create_node` 的 `flags.timeout` 仍被 Hub 按 `1..86400` 先校验一次，所以 `600000` 会被 Hub 拒绝；`1000..86400` 两边都接受，按毫秒执行。
  - `codex_login` 字段会被旧 Hub 丢弃，不影响其他健康信息和派活。
- 等下一个 Hub 版本发布后，两边规则一致。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.114
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.147 @sleep2agi/agent-node@2.5.0-preview.114
```

升级后要重启节点和 daemon（`anet daemon restart <名字>`）才生效。
- 🔴 **两个包一起升级**（`agent-network@2.3.0-preview.147 ↔ agent-node@2.5.0-preview.114`）。
- 发布顺序：先 agent-node `.114`，再 agent-network `.147`，两者来自同一个合并提交。

## 证据

- #2422：真实子进程带中文 `CODEX_HOME` 的检查在 origin/main 上复现出生产报错原文，修复后通过；test725 agent-node 单测 2410 pass / 0 fail；test745 agent-network 单测 PASS。
- #2417：新 Docker 套件 `tests/qa-daemon-stop-codex-copresence`（真 Hub + 真 `anet daemon up` + 真 tmux + 真 codex）origin/main PASS=25 FAIL=15 → 修复后 PASS=40 FAIL=0。
- #2418：`create-node-daemon.test.ts` 新增按平台的 PATH 测试，在 origin/main 上 6 红；test725 2387 pass / 0 fail。
- #2420：新 Docker 套件 `tests/qa-create-node-timeout-ms` origin/main PASS=6 FAIL=7 → 修复后 PASS=14 FAIL=0。
- #2421：`codex-login-health.test.ts` 8 个测试，含「上报字段、警告、写出的文件里都不出现令牌」。
- #2424：`start-resource-gate.test.ts` 10 个测试；去掉门调用后接线测试变红。
- 均未在真实生产节点上验证；Mac 上的 PATH 修复需要 Mac daemon 升级重启后才生效。

## promote 时的 must_contain

`"version": "2.5.0-preview.114"`
