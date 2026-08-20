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
| `@sleep2agi/commhub-server` | `agent-network/bin/cli.ts` `PINNED_SERVER_VERSION` 常量 | code constant（钉死具体版本）|
| `@sleep2agi/agent-network-dashboard` | `agent-network/bin/cli.ts` `dashboardReleaseTag()` 函数 | code function（默认返回 npm dist-tag `preview`，`ANET_DASHBOARD_VERSION` env 可覆盖）|

> commhub-server 走 `PINNED_SERVER_VERSION` 常量（钉死具体版本号，需随 release sync）；dashboard
> **不钉版本** —— `dashboardReleaseTag()` 默认拉 `@preview` dist-tag，所以 dashboard 发新 preview 后
> anet 会自动跟随，无需改 cli.ts。两者都属于 release management 数据，**不是业务逻辑**。

::: tip R261 校准：docs 已无 hardcoded npm 版本，移出 Live versions
R212/R213/R215/R225/R251/R253 chain 已经把 `docs-site/docs/guide/runtimes.md` + `agent-node.md` + `sdk-deep-dive.md` + `upgrade.md` + `deploy/npm.md` + `faq.md` 等 user-facing doc 内的 hardcoded npm 版本号（`@2.1.7` / `@2.3.0` / `MiniMax-M2.7` / Bun `>= 1.0` 等）**全部清除**，改成「查 npm latest tag / npm 包页 dist-tags」或 vendor 名（无版本）。原 docs reference 两行（runtimes / agent-node + agent-network 跨 6 doc）已经不再需要 release sync。

未来加新 doc 时**不要再写硬版本号**（reviewer 拦截，rationale：每 release drift 一次维护负担，让 doc 引导用户去 npm 包页查最新 latest 比 doc 自己钉死可靠）。

~~例外（保留快照）：sdk-deep-dive.md L14 用 `agent-node@2.3.1-preview.0` 做 snapshot pin~~ —— **R367 (2026-05-14) 已取消该例外**：[`docs-site/docs/guide/sdk-deep-dive.md` L14](https://github.com/sleep2agi/agent-network/blob/main/docs-site/docs/guide/sdk-deep-dive.md#L14) 的 `cli.ts:NNN` 行号引用改成「对照 GitHub `main` 校准」（不再 pin 具体 preview 版本），跟其余 doc 一致。现在 **没有 docs 还在安装命令里 pin npm 版本号**了。

> 🔴 **但「没有任何 doc 提版本号」是错的,别照这句话跳过检查。**
> 有一类版本号是**故意**留着的:限定信道的**行为断言** ——「在 latest `2.2.21` 上
> 你会看到裸崩,在 preview 上会被 preflight 拦下」。这类断言**去掉版本号就失去意义**,
> 所以 R367 没有、也不该把它们清掉。代价是:**latest 或 preview 一发布,它们立刻变成假的**,
> 而且是危险的那种假 —— 会告诉用户一道已经存在的安全 preflight 不存在。
>
> 逐次发版必须重新核对的位置(**12 个路径**,下表 12 行 = 12 个文件 ——
> 不要把 zh/en 合成一行数,分母数错会漏核。
> 这张表的分母被修正过两次:7 → 8 → 12。**加新的信道断言时,同时把它加进这张表**,
> 否则下一个人照着一份"看起来完整"的清单去核,漏掉的那几页永远不会被发现):
>
> | 文件 | 行 | 断言 |
> |---|---|---|
> | `docs-site/docs/guide/getting-started.md` | 19–20 | latest `2.2.21` 裸崩 / preview `2.3.0-preview.x` 被拦 |
> | `docs-site/docs/en/guide/getting-started.md` | 19–20 | 同上(英文) |
> | `docs-site/docs/deploy/clean-server.md` | 21–22 | 同上 |
> | `docs-site/docs/en/deploy/clean-server.md` | 21–22 | 同上(英文) |
> | `docs-site/docs/troubleshooting.md` | 29、37 | preview 有 preflight / latest 没有 |
> | `docs-site/docs/en/troubleshooting.md` | 29、37 | 同上(英文) |
> | `docs-site/docs/guide/versioning.md` | 11 | `anet -v` 顶行示例 `anet v2.2.21` |
> | `docs-site/docs/en/guide/versioning.md` | 11 | 同上(英文) |
> | `docs-site/docs/guide/windows.md` | 102 | 跨盘 `anet --version` 崩溃是哪个通道的现状 |
> | `docs-site/docs/en/guide/windows.md` | 102 | 同上(英文) |
> | `docs-site/docs/guide/dashboard.md` | 313、328 | `anet -v` 应显示 `2.3.0-preview.N` / preview 不自动 promote |
> | `docs-site/docs/en/guide/dashboard.md` | 314、329 | 同上(英文) |
>
> **核对方法不是 grep,是真机装。但不同断言要各跑各的 —— 一次探针不能替所有:**
>
> | 断言 | 核法 | 2026-08-13 状态 |
> |---|---|---|
> | latest 裸崩 / preview 被 preflight 拦 | 干净容器装对应通道、**不装 bun**,跑 `anet hub start` | **已实测**:latest `2.2.21` 仍裸崩(`syscall: 'spawn bunx'`, `code: 'ENOENT'`);preview 被拦 |
> | `anet -v` 顶行示例 | 装 latest 后跑 **`anet -v`**,比对顶行 | **已实测**:干净容器装 latest 后 `anet -v` 顶行正是 `anet v2.2.21`,与 `versioning.md` 一致 |
> | 安装命令里的版本 pin | 比对 npm dist-tag 与文中命令 | **不适用**:上表各页的安装命令全是裸 `npm i -g @sleep2agi/<pkg>`,一个都不钉版本。这一行保留为**负向不变量** —— 每次发版确认「没有新出现钉版本的安装命令」 |
>
> 🔴 **原来那次探针只证明了第一行**,把它当成「整张表都成立」是证据越权 ——
> **一次运行只能证明它实际执行过的那条路径。**
> 后来我把第二行也真跑了(另起一个干净容器跑 `anet -v`),第三行查完是不适用。
> **记一笔:我一度把这两行标成「未实测」就交付了。标注不确定性是诚实的,
> 但当那个不确定性两分钟就能消除时,标注会变成不去消除它的借口。**
>
> 当前坐标(便于下次比对)—— **注意是哪个包**:
>
> | 包 | latest | preview | 为什么是它 |
> |---|---|---|---|
> | `@sleep2agi/agent-network` | `2.2.21` | `2.3.0-preview.40` | **preflight 实现在 `agent-network/bin/cli.ts`,上表断言核的就是它** |
> | `@sleep2agi/commhub-server` | `0.8.8` | `0.9.0-preview.29` | 只在 preflight 通过之后才相关,**不是上表断言的坐标** |
>
> 我第一版在这里记的是 commhub-server 的版本 —— **记错了包**。被核的是 CLI 的
> preflight,却钉了 server 的 dist-tag,下次比对会比错对象。
> preview 版本每次发版都变,重核时以 npm dist-tag 实际值为准,别照抄这里。
>
> 上表第一行的实测证据:`docs/tests/report-latest-channel-preflight.txt`
> (含复现命令、两个通道的原始输出、以及它**不覆盖**哪两条断言)。
:::

::: tip R? 校准（2026-08-17）：测试套件里的版本号已改为「从源码常量派生」，不再需要 release sync

`tests/test386-opencode-agent-node-gate` 与 `tests/test384-opencode-local-package-e2e` 原先各自
硬编码了 `OPENCODE_AGENT_NETWORK_VERSION` / `OPENCODE_AGENT_NODE_VERSION` 这一对
（test386 有 5 处断言 + 3 处夹具，test384 有 run.sh 默认值 + Dockerfile ARG）。

走 preview.40 的 dry-run 时发现：**sync 脚本会升常量，但不碰这些文件，所以照本 SOP 发版
必然产生一个红**——而最省力的「修法」是把断言里的数字改成新的，那等于让测试永远只抄一遍
当前值、不再检查任何东西。

现在它们在运行时从 `agent-network/src/opencode-agent-node-pair.ts` 读常量（读不到就
fail-closed，不拿空串去 grep——空串 grep 恒真会把断言变成永远通过），夹具的 `version`
由 run.sh 在使用前改写。**不要把它们加进 Live versions 表**：加进去等于给已经自洽的东西
再钉一份，反而会漂。
:::

### B. Frozen snapshots（永不动）

每条记录都是某个历史时刻的快照，跟着 release sync 改反而失真。

🔴 **机制说明(此前这里写的是「脚本主动跳过」,不准确)**:
`sync-pinned-versions.sh` **没有跳过名单** —— 它是**白名单式**的,只改被
`register <pkg> <file>` 显式登记过的文件。所以下面这些路径之所以安全,
是因为**它们从来没被 register**,不是因为有一条规则在挡它们。

这个区别很实际:**往下面这张表里加一条,不会产生任何保护效果** ——
真正要做的是「不要 register 它」。反过来,一旦有人 register 了某个路径,
这张表拦不住。

下列路径当前未被 register:

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
cd <你的 agent-network 仓库根>   # 即 git clone sleep2agi/agent-network 的本地目录
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

🔴 **文档 PR 合进 `main` ≠ 文档上线。** `docs-site` 那个 Vercel 项目**没接 git 自动部署**，
必须有人手动跑一次 `vercel --prod`，步骤见 [`deploy/docs-site/README.md`](../deploy/docs-site/README.md)。
漏了不会报错，只会让 anet.sh 和 `main` 静默分叉——实测发生过停在 36 小时前、
以及冻结近 14 天。所以 Step 9 的**终点是站点上线**，不是 PR 被合。

### Step 10：发版收尾——取远端核（🔴 缺了这步的发版可能是零效果）

前面所有步骤都在**本地**或**某个 release 分支**上。发版真正结束的判据只有一个：
**这些改动已经在 `origin/main` 上**。

```bash
git fetch origin main
# ① 三个包的版本号
for p in agent-network agent-node server; do
  git show origin/main:$p/package.json | python3 -c \
    "import json,sys;d=json.load(sys.stdin);print(d['name'],d['version'])"
done
# ② PINNED 链（见 §3 第 2 条）
git show origin/main:agent-network/bin/cli.ts | grep 'PINNED_SERVER_VERSION *='
# ③ OpenCode 精确配对 pin（两个常量必须分别等于对应包的 preview tag）
git show origin/main:agent-network/src/opencode-agent-node-pair.ts | \
  grep -E 'OPENCODE_AGENT_(NETWORK|NODE)_VERSION *='
# ④ 与 npm 上的 preview tag 逐一比对，必须相等
npm view @sleep2agi/<pkg>@preview version
```

**判据是「远端 main 上是什么」，不是「我提了 bump PR」。**

#### ③ 枚举版本位要用注册表，不要手写

上面的 ①② 是**手写的子集**，而手写子集会漏 —— 2026-08-13 就漏了一处
（`agent-network/src/opencode-agent-node-pair.ts`，详见 #745）。
权威枚举在 `scripts/sync-pinned-versions.sh` 顶部的 `register` 区：

```bash
./scripts/sync-pinned-versions.sh <pkg> <新版本>     # 默认 dry-run
# 🔴 非零退出 = 注册表里有目标已从文件里消失，这份清单不再覆盖它们。
#    此时不要把它的输出当作"所有版本位都已同步"的证据。
```

🔴 **注册表与「手动 pin」的边界已经变了,以下是当前事实(2026-08-13 核对):**

| pin | 为什么不自动同步 |
|---|---|
| `agent-network/src/opencode-agent-node-pair.ts` | ⚠️ **已改为自动同步** —— 脚本第 71 / 80 行现在 register 了 `OPENCODE_AGENT_NETWORK_VERSION` 与 `OPENCODE_AGENT_NODE_VERSION`。此前本表写「故意不自动同步」,理由是自动跟随会抹平那条 `intentionally fails when either package is bumped independently` 的绊线。**两种做法各有取舍,当前生效的是自动同步**;若要恢复「必须重新验证才能改」的语义,需要把那两行 register 去掉,并在此说明。见 #745。 |

所以 Step 10 的完整做法是：**跑一遍注册表同步（看它是否非零退出）+ 单独确认上表里的手动 pin**。

#### ④ 发布之后,核对**已发布产物**里的 pin(①②③ 都只看源码)

🔴 前面三条查的全是**源码**。源码对了不等于**用户装到的包**对了 ——
发布是在某个时刻打包的,之后合进 `main` 的 pin 修复**不会**回到已发布的产物里。

2026-08-13 实测:`main` 上 opencode 配对 pin 已修成 `.39/.31`、绊线测试全绿,
而 `npm pack @sleep2agi/agent-network@preview` 拆开,
`dist/src/opencode-agent-node-pair.d.ts` 里仍是 `agent-node@2.5.0-preview.28` ——
**因为那个 preview 是在修复之前发布的**。当时 issue 已按「fixed」收口,
而用户装上去仍然起不来。

```bash
./scripts/verify-published-pins.sh preview      # 或 latest
# 0 一致 / 1 有不一致 / 2 取不到产物 / 3 零覆盖
```

它有三条刻意的性质,别绕过:

- **只采信阳性命中** —— 已发布 `dist/cli.js` 是 minified 的,
  「找不到」不可信(拿已知必在的常量做对照会命中 0);`.d.ts` 才保留完整字面量。
  拿不准时它报「无法判定」,不会假装一致;
- **报分母**,并在一个 pin 都没抽到时 `exit 3` —— 零覆盖的检查与坏掉的检查
  在输出上无法区分;
- pin 清单**从源文件抽取**,不手写子集(手写子集正是 ③ 里说的那次漏)。

**判据:发版收尾时 ①②③ 全绿、但 ④ 非零,说明这次发的包里没有那条修复 ——
要么补发,要么在相关 issue 里把「fixed」限定为「fixed on main, not yet published」。**
实测踩过：bump PR 开着没合的那段时间，npm 上 server 已经是新版，
但 `main` 上 `PINNED_SERVER_VERSION` 还是旧版——**任何人从 main 切一次版，
CLI 都会去拉旧 server，这次发版等于白发，且不产生任何报错**。

---

## 3. 跨包同时发版

如果同一个 PR 要发多个包（例如同时升 `agent-network` + `agent-node`）：

1. 每个包 **分别** 跑一遍 Step 1～Step 5（每包一个 commit）。
2. push 后 **顺序 publish**：先发底层依赖（commhub-server → agent-node → agent-network），
   后发上层。理由：anet CLI 用 `PINNED_SERVER_VERSION` fetch 一个**已存在**的 server 版本。
3. 🔴 **发了 commhub-server 就必须同步改 `PINNED_SERVER_VERSION`**
   （`agent-network/bin/cli.ts`）。`anet hub start` 拉哪个 server 由这个常量决定，
   **只发包不改常量 = 这次 server 发版零效果**：用户升级 CLI 后 CLI 仍然拉旧 server。
   所以顺序是**先发 server → 改 pin → 再发 CLI**（反过来 CLI 会拉到不存在的版本，
   `bunx` 报 ETARGET）。改完按 Step 10 取远端核。
4. 升 latest 同样按依赖顺序进。

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
