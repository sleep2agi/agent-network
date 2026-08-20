# v2.3.0-preview.40 / agent-node 2.5.0-preview.32 — release notes

grok 共存（`grok-build-cli`）这一版做完两件事：**收录 grok 1.0.5**，以及**支持 Windows**。
两者此前都完全跑不通 —— 不是"体验不好"，是 `anet node create --runtime grok-build-cli`
之后 `anet node start` 必定失败。

## Install · `@sleep2agi/agent-network@2.3.0-preview.40` · `@sleep2agi/agent-node@2.5.0-preview.32` · `@sleep2agi/commhub-server@0.9.0-preview.29`

```bash
# CLI（用户入口）
npm install -g @sleep2agi/agent-network@2.3.0-preview.40

# 每个 agent 的运行时（向导会自动取；写死版本便于可复现部署）
npm install -g @sleep2agi/agent-node@2.5.0-preview.32

# commhub server —— `anet hub start` 会自动取；只在直接用 CLI 时才需显式安装
npm install -g @sleep2agi/commhub-server@0.9.0-preview.29
```

## Upgrade

```bash
anet upgrade
# 或按包升级
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
# commhub 在下次 `anet hub start` 时自动刷新
```

## Headline 1 — grok 1.0.5 可用（此前被版本门硬拒）

版本门从「**恰好等于** `grok 0.2.93 (f00f96316d)`」改为**已验证 build 白名单**。
刻意不做版本区间比较：新 build 会改 PTY / 审批菜单 / Leader 契约，区间会让没验过的 build 自动通过。

🔴 收录 1.0.5 的关键发现：**1.0.5 的交互式 TUI 不再自动拉起 Leader**。
厂商文档 `18-sandbox.md` 原文：请求非 `off` 的 sandbox profile 时
"The agent runs **in-process**, not through the shared leader … but **still refuses the leader**"。
而共存永远请求 sandbox ⇒ 那个 build 上永远没有 Leader。
实测三组佐证：等 10s / 等 60s / 一个普通已认证 `grok` TUI 跑 25s —— 都没有 socket。

⇒ 把「TUI 会不会自动起 Leader」做成 **per-build 能力**，无 Leader 的 build 跳过等待与绑定，
并**反向 fail-closed**：声明无 Leader 的 build 上若真出现 socket，直接报错。

## Headline 2 — Windows 支持（`grok-build-cli` 共存）

原来是一句 `process.platform !== "linux"` 整体拒绝。现在是**能力模型**
（ipc / kernelSandbox / procfs / posixFileModes / homeIsolationHidesVendorSkills）：
不支持时报错**说出缺什么**，能跑但有损失时**逐条打印**。

Windows 实测（Windows 11 build 26200 / node v24.18.0 / grok 1.0.5）：
```
[grok-copresence] TUI ready session=… attach=…\run\attach.sock
已注册到 CommHub · SSE connected
```
具体改动：命名管道替代 Unix socket 与 flock、PATHEXT + npm 真二进制解析、
Windows 家目录三件套隔离、Windows 必需系统环境变量、保护路径归一为正斜杠、
POSIX 模式位与 uid 校验按平台分流。

## 🔴 Windows 上一条【无法达成】的保证（启动时逐条打印）

隔离 HOME **挡不住厂商技能发现**。实测把 `USERPROFILE`/`HOME`/`HOMEDRIVE`/`HOMEPATH`/`GROK_HOME`
全部重定向后，`grok inspect --json` 仍读到 `C:\Users\<u>\.agents\skills\...`。

处置不是放松断言：
- 可隔离的外部来源（plugins / marketplaces / lspServers / mcpServers）**仍然硬拒**
- 已生效的权限规则（`loaded` / `sources` 非空）**仍然硬拒**
- 已证明隔离不了的（skills / agents、以及**未生效**的 skipped 规则）⇒ **逐条列出路径**并在启动时打印

## 其它

- `$HOME` 里 `anet node create` 出来的共存节点此前**无法启动**（注册表是 cwd 相对，
  而 folder trust 拒绝 `$HOME`）⇒ cwd 不可授信时回退到节点自有目录，并同步搬运 MCP 载荷
- 跨厂商兼容矩阵从 4 格补到 13 格（实测 `13/13 → 0/13`）
- 新增 1.0.5 发现面的 fail-closed 断言：`skills` / `agents` / `plugins` /
  `marketplaces` / `lspServers` / `externalCompat` / `managedSettings*`

## Verification (pre-publish)

- agent-node 全量 **1330 pass / 0 fail（98 个文件）**
- 变异测试：Linux 那批 6 条、Windows 那批 5 条，**全部见证红、还原全绿**
  （其中一条最初存活 ⇒ 说明没有断言在看它 ⇒ 补测试后复验会红）
- 端到端：Linux `create → start → attach` 全通；Windows `TUI ready + 注册 + SSE connected`
- 两侧都做了 **hub 日志独立复核**，不只看节点自己的输出
