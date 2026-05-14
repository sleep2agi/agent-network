# RELEASE-SOP — 跨包 release 同步 SOP

> 适用范围：`@sleep2agi/agent-network` / `@sleep2agi/agent-node` /
> `@sleep2agi/commhub-server` / `@sleep2agi/agent-network-dashboard`
> 任一包发版时，跑这份 SOP 把版本号同步到所有 hardcoded 引用位置。

---

## 0. 版本号在仓库里的两种 lifecycle

仓库里出现的 `@sleep2agi/<pkg>@X.Y.Z` 字串分两类，**只有第一类需要 sync**：

### A. Live versions（每次 release 必须 sync）

跟着 `npm latest` dist-tag 走的"现行推荐版本"。用户照这些文档/脚本装的就是这一份。

| package | 位置 | 类型 |
|---|---|---|
| `@sleep2agi/commhub-server` | `agent-network/bin/cli.ts` `PINNED_SERVER_VERSION` 常量 | code constant |
| `@sleep2agi/agent-network-dashboard` | `agent-network/bin/cli.ts` `PINNED_DASHBOARD_VERSION` 常量 | code constant |

> cli.ts 的两个 `PINNED_*` 常量是 release management 数据：anet 启动时 fetch 哪一版的
> commhub-server / dashboard 就靠它们。属于 sync 范围，**不是业务逻辑**。

::: tip R261 校准：docs 已无 hardcoded npm 版本，移出 Live versions
R212/R213/R215/R225/R251/R253 chain 已经把 `docs-site/docs/guide/runtimes.md` + `agent-node.md` + `sdk-deep-dive.md` + `upgrade.md` + `deploy/npm.md` + `faq.md` 等 user-facing doc 内的 hardcoded npm 版本号（`@2.1.7` / `@2.3.0` / `MiniMax-M2.7` / Bun `>= 1.0` 等）**全部清除**，改成「查 npm latest tag / npm 包页 dist-tags」或 vendor 名（无版本）。原 docs reference 两行（runtimes / agent-node + agent-network 跨 6 doc）已经不再需要 release sync。

未来加新 doc 时**不要再写硬版本号**（reviewer 拦截，rationale：每 release drift 一次维护负担，让 doc 引导用户去 npm 包页查最新 latest 比 doc 自己钉死可靠）。

~~例外（保留快照）：sdk-deep-dive.md L14 用 `agent-node@2.3.1-preview.0` 做 snapshot pin~~ —— **R367 (2026-05-14) 已取消该例外**：[`docs-site/docs/guide/sdk-deep-dive.md` L14](https://github.com/sleep2agi/agent-network/blob/main/docs-site/docs/guide/sdk-deep-dive.md#L14) 的 `cli.ts:NNN` 行号引用改成「对照 GitHub `main` 校准」（不再 pin 具体 preview 版本），跟其余 doc 一致。现在 **没有 docs 还 pin npm 版本号**了。
:::

### B. Frozen snapshots（永不动）

每条记录都是某个历史时刻的快照，跟着 release sync 改反而失真。`sync-pinned-versions.sh`
**主动跳过**这些路径：

- `docs-site/docs/changelog.md` / `docs-site/docs/en/changelog.md`
- `docs-site/docs/v0.8.0/**`（整套历史归档版本的 docs）
- `docs/archive/**`
- `docs/evolution-log.md`
- `docs/upgrade-v2.md`
- `docs/sdk-upgrade-*.md`（baseline 报告）
- `tests/test-npm-security/`、`tests/test28-demo-debate-v2.1.2/`、
  `agent-network/tests/docker-e2e/run-e2e.sh`（测试 fixture 钉死版本）

> 加新文档时遵守这条原则：把"现行推荐版本"留在 Live versions 表里，把"某版本的固化
> 记录"放进 Frozen snapshots 区。

---

## 1. Pre-release sanity check（动手前必跑）

发版前先确认上下文，避免覆盖错版本号：

```bash
# 1. 拿到目标 pkg 当前 latest + preview tag
npm view @sleep2agi/agent-network dist-tags
npm view @sleep2agi/agent-node dist-tags
npm view @sleep2agi/commhub-server dist-tags
npm view @sleep2agi/agent-network-dashboard dist-tags

# 2. worktree 起在干净分支，避免污染主仓
cd /home/vansin/agent-orchestra
git fetch origin main
git worktree add ~/anet-work/release-<pkg>-<ver> -b release/<pkg>-<ver> origin/main
cd ~/anet-work/release-<pkg>-<ver>

# 3. 先 dry-run 看 sed 会改哪几处
./scripts/sync-pinned-versions.sh @sleep2agi/<pkg> <new-version>
```

dry-run 输出里 **逐条核对每个 diff hunk**：
- 版本号方向对吗（升不是降）？
- 包名边界正确吗（agent-network 不会误改 agent-network-dashboard）？
- 命中的位置全都是 Live versions 列出的吗？

任何一条不对就停。

---

## 2. 发版 checklist

下面以"发 `@sleep2agi/agent-node@2.3.2-preview.0` preview"为例。其它包同理替换。

### Step 1：改 sub-package `package.json`

```bash
cd agent-node
# 编辑 package.json，把 "version" 改成新版本
# (npm version 命令会自动 tag + commit，本流程不用，手动改避免噪音)
```

### Step 2：跑 sync 脚本

```bash
cd ..   # 回到 repo root
# 先 dry-run
./scripts/sync-pinned-versions.sh @sleep2agi/agent-node 2.3.2-preview.0
# 看 diff OK 再 apply
./scripts/sync-pinned-versions.sh @sleep2agi/agent-node 2.3.2-preview.0 --apply
```

脚本只会改 Live versions 表里登记的位置，且 sed 严格锚定常量名 + 包名边界，不会
意外飞掉到别处。

### Step 3：本地 build verify

```bash
cd agent-node
npm install
npm run build
cd ..
```

如果改的是 `agent-network` 包，跑 `cd agent-network && npm run build` 确认 cli
能编。

### Step 4：人工 review `git diff`

```bash
git diff --stat
git diff   # 翻一遍每个 hunk
```

确认：
- 改动只在 `package.json` + sync 脚本登记的位置
- 没有意外 untracked / 误删 / 误改其它行

### Step 5：commit

```bash
git add agent-node/package.json docs-site/docs/...   # 按 git status 列的
git commit -m "chore(release): @sleep2agi/agent-node 2.3.2-preview.0"
```

> Conventional Commits：`chore(release): ...` 或 `release: ...`。
> 不加 `Co-Authored-By` 类 footer（OSS rule，见仓库 commit history）。

### Step 6：publish preview

```bash
cd agent-node
npm publish --tag preview
```

> 默认就是 `--tag preview`，**永远不要直接 `--tag latest`**。

### Step 7：等待窗口 ≥ 30 分钟 + owner explicit ACK

两阶段发版规则（release-preview-first，见 [CONTRIBUTING.md §Release process](../CONTRIBUTING.md)）：

- 第一阶段：`npm publish --tag preview` 后，**至少 30 分钟**真实环境烟测
- 第二阶段：owner 或 lead **显式 ACK** 后才能升 latest
- 30 分钟内发现 bug：发新 preview 覆盖，不要急着 dist-tag latest

只 publish 不升 latest 也是合法终态——很多 preview 永远停在 preview 也 OK。

### Step 8：升 latest（owner ACK 之后）

```bash
npm dist-tag add @sleep2agi/agent-node@2.3.2-preview.0 latest
# verify
npm view @sleep2agi/agent-node dist-tags
```

### Step 9：通知通信文档马同步 release docs

通过 CommHub：

```
commhub_send_task(alias="通信文档马",
  task="@sleep2agi/agent-node@2.3.2 已 dist-tag latest，
        请走 R 系列 round 同步 docs-site changelog + release notes")
```

---

## 3. 跨包同时发版

如果同一个 PR 要发多个包（例如同时升 `agent-network` + `agent-node`）：

1. 每个包 **分别** 跑一遍 Step 1～Step 5（每包一个 commit）。
2. push 后 **顺序 publish**：先发底层依赖（commhub-server → agent-node → agent-network），
   后发上层。理由：anet CLI 用 `PINNED_SERVER_VERSION` fetch 一个**已存在**的 server 版本。
3. 升 latest 同样按依赖顺序进。

---

## 4. Sync 脚本约定

`scripts/sync-pinned-versions.sh` 设计原则：

- 默认 **dry-run**，必须显式 `--apply` 才动文件
- sed pattern 精确锚定 `const NAME = "..."` 字面值，**不动 declaration 周围 logic**
- docs 模板加包名边界保护：`@sleep2agi/agent-network@` 不会误中
  `@sleep2agi/agent-network-dashboard@`
- 版本号格式校验：必须是 `X.Y.Z` 或 `X.Y.Z-tag.N`
- 跑完打印 `git diff --stat` 摘要，提示人 review 后再 commit

新加 hardcoded 引用位置时，编辑脚本顶部 `register <pkg> <file>` 区添一行就够，不动逻辑。

---

## 5. 出错回滚

如果 publish 完发现版本有大问题：

```bash
# 不要 unpublish（npm 24h 之后禁 unpublish 且影响信誉）
# 改用 dist-tag 把 latest 指回上一稳定版本：
npm dist-tag add @sleep2agi/<pkg>@<old-stable> latest
# 然后立刻发一个修复版 preview，重走完整 SOP
```

docs / cli.ts 里的版本号回滚：

```bash
./scripts/sync-pinned-versions.sh @sleep2agi/<pkg> <old-stable> --apply
git diff && git commit -m "chore(release): rollback @sleep2agi/<pkg> to <old-stable>"
```

---

## 6. 维护这份 SOP

发现新 hardcoded 位置时按这个流程补：

1. 用 `grep -rnE '@sleep2agi/(agent-network|agent-node|commhub-server|agent-network-dashboard)@?[0-9]'` 全仓扫
2. 判断是 Live versions 还是 Frozen snapshot
3. 如果是 Live：
   - 加进本文档 §0.A 表格
   - `scripts/sync-pinned-versions.sh` 顶部加一行 `register <pkg> <file>`
   - 跑 dry-run verify 命中
4. 如果是 Frozen：补到 §0.B 列表里说明为什么不动

维护：发现遗漏或新增 hardcoded 位置时直接改本文档 + sync 脚本。改动走 PR 流程，
Tier 1 review（通信龙 / 通信SDK马）通过后 merge。
