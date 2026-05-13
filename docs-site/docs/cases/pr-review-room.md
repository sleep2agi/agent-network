# 代码 PR 审查室 Demo

`anet demo pr-review` 是 v0.9 内置 demo：CLI 创建 4 个临时 agent，3 个并行 reviewer（**安全 / 性能 / 风格**）+ 1 个终审 judge，跑完输出一份带 LGTM / Request Changes / Comment 决议的 markdown PR review 评论，可直接贴回 GitHub PR。

完整设计契约：[`docs/demos/pr-review-room-proposal.md`](https://github.com/sleep2agi/agent-network/blob/main/docs/demos/pr-review-room-proposal.md)。

## 一句话跑

```bash
# 跑仓库自带样例（任一）
anet demo pr-review --diff tests/test28-pr-review-room/samples/typo-pr.diff

# 跑本地 git diff
anet demo pr-review --ref origin/main

# 跑远程 GitHub PR
anet demo pr-review --pr https://github.com/sleep2agi/agent-network/pull/40
```

预计 1-3 分钟跑完（3 reviewer 并行 + judge 单步）。需要先 `anet login` 到 hub，并准备 MiniMax API Key：

```bash
export MINIMAX_KEY=sk-cp-...
```

## 角色（4 个 agent）

| 角色 alias | 职责 | 输出 |
|------------|------|------|
| `reviewer-security-<suffix>` | 注入 / 凭据泄露 / 权限绕过 / SSRF / 反序列化 / 命令注入 / 不安全反射 / 越权访问 | 每条 `- [严重度] file:line — 问题 — 建议` + `## 安全 issue 数: N` |
| `reviewer-performance-<suffix>` | N+1 查询 / O(n²) / 不必要 IO / 阻塞 await / 大对象 / 内存泄漏 / 锁粒度 / 缓存缺失 | 同上结构 + `## 性能 issue 数: N` |
| `reviewer-style-<suffix>` | 命名 / 注释 / 抽象层级 / 死代码 / 复杂度 / 重复 / 类型签名 | 同上结构 + `## 风格 issue 数: N` |
| `judge-<suffix>` | 按 `(file:line)` 二元组去重 + 严重度排序 + 判 LGTM / Request Changes / Comment | 顶部 `**决议：**` 字段 + 统计 + 三段 issue + `## 终审说明` |

`<suffix>` 是 4 hex 字符（如 `7f3a`），可用 `--suffix` 自定义。

## 编排时序（6 步）

```
[1/6]  创建 4 个 agent (alias 后缀 -<suffix>)
[2/6]  启动 4 个 agent (tmux session) → SSE connected
[3/6]  广播 review task 给 3 reviewer (parallel)
       └─ 每个 reviewer 完成时打印耗时 + 字数
       └─ 并行总耗时 vs 估串行耗时（节省 ~Xs）
[4/6]  barrier 收齐 3 份 review，整包派给 judge
[5/6]  judge 整合 + 终审
[6/6]  写入 ./pr-review-<suffix>-<ts>.md
       └─ 清理 4 agent + 删除独立 network（除非 --keep）
       └─ 末尾打印下一步建议：less 查看 + gh pr comment 一行贴 GitHub
```

并行卖点：3 reviewer 同时跑，3 维度审查总耗时 ≈ 单维度最慢的那一个，而非三维度相加。

## 参数

| Flag | 默认 | 说明 |
|------|------|------|
| `--diff <file>` | — | 本地 `.diff` / `.patch` 文件 |
| `--ref <ref>` | — | `git diff <ref>..HEAD` 自动拿当前分支 patch（如 `--ref origin/main`） |
| `--pr <url>` | — | GitHub PR URL，用 `gh` CLI 拉 `.diff`（需本地装 [gh](https://cli.github.com)） |
| `--key <key>` | `$MINIMAX_KEY` / `$ANTHROPIC_AUTH_TOKEN` | MiniMax API Key |
| `--out <path>` | `./pr-review-<suffix>-<ts>.md` | 评审输出路径 |
| `--keep` | false | 跑完保留 4 个 agent + 独立 network |
| `--step-timeout <s>` | 180 | 单 reviewer / judge 超时秒数 |
| `--suffix <s>` | 随机 4 hex | alias 后缀 |
| `--no-network` | false | 跑在当前 / default network 内 |
| `--network <id>` | — | 指定已存在的 network |

三种 diff 入口至少需要一种。

## 仓库自带的 3 个样例

`tests/test28-pr-review-room/samples/` 下三份 diff fixture，覆盖典型场景：

| 文件 | 场景 | 预期 judge 决议 |
|------|------|----------------|
| `good-pr.diff` | README typo 单行修复 | **LGTM** |
| `typo-pr.diff` | 1-2 处死代码 / 注释过多 | **Comment** |
| `cross-file-pr.diff` | SQL 注入 + N+1 查询 + 硬编码密码 + 路径穿越 | **Request Changes** |

跑命令：

```bash
anet demo pr-review --diff tests/test28-pr-review-room/samples/cross-file-pr.diff
```

预期输出结构断言写在 [`tests/test28-pr-review-room/expected/assertions.json`](https://github.com/sleep2agi/agent-network/blob/main/tests/test28-pr-review-room/expected/assertions.json) — 包含决议字段正则 / 各维度 issue 数范围 / 必含 sections。

> ⚠️ **LLM 输出本质 non-deterministic** — 本页下面展示的是输出**结构和字段**（决议 verdict / issue 数 / 必含 sections / 控制台节奏），具体文字 / 顺序 / 风格随 model 状态、prompt 命中度、采样温度变化。[`assertions.json`](https://github.com/sleep2agi/agent-network/blob/main/tests/test28-pr-review-room/expected/assertions.json) 的结构断言（regex + 计数范围）比 verbatim 文字 match 更可靠。

## 输出 markdown 结构

`./pr-review-<suffix>-<ts>.md` 的固定结构（来自 [`cli.ts` 4714-4729 行](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L4714)）：

```markdown
# PR Review

**来源**: <local file / git diff / owner/repo#N>
**大小**: X.X KB
**时间**: <localized datetime>
**Run**: <suffix>
**总耗时**: Ns

**决议：** LGTM | Request Changes | Comment
**统计：** 安全 N1 处 / 性能 N2 处 / 风格 N3 处

## 安全
- [严重] src/auth.ts:42 — 用户输入直接拼 SQL — 改用参数化查询
- [中] ...

## 性能
- [中] src/api/users.ts:88 — for 循环里查 DB（N+1） — 用 batch 查询

## 风格
- [低] src/utils/format.ts:12 — 命名 `tmp` 含义不清 — 改名 `formattedRows`

## 终审说明
本 PR 引入了一处严重安全风险（SQL 注入），建议改用参数化查询后再合并。性能与风格问题非阻塞，可在后续 PR 修。

---
## 附：3 reviewer 原始输出

### reviewer-security (reviewer-security-<suffix>, Xs)
<原始 markdown>

### reviewer-performance (reviewer-performance-<suffix>, Xs)
<原始 markdown>

### reviewer-style (reviewer-style-<suffix>, Xs)
<原始 markdown>
```

> 上面是格式说明 — 内容里的 issue 文本来自 LLM，每次跑都会有细节差异。

## 控制台输出节奏

CLI 跑起来后控制台依次打出（来自 [`cli.ts` 4549-4775 行](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L4549)）：

```text
  🔍 PR diff: local file tests/test28-pr-review-room/samples/typo-pr.diff
  📏 Size:   1.0 KB
  📡 Hub:    http://127.0.0.1:9200
  📂 Net:    (pr-review-7f3a net_ab12cd34...)
  🆔 Run:    7f3a

  [1/6] 创建 4 个 agent (alias 后缀 -7f3a)...
        ✓ 创建/更新 4 个 agent
  [2/6] 启动 4 个 agent (tmux session)...
        ✓ 4 agent 全部 SSE connected
  [3/6] 广播 review task 给 3 reviewer (parallel)...
        ✓ reviewer-security-7f3a       38s, 412 字
        ✓ reviewer-performance-7f3a    41s, 287 字
        ✓ reviewer-style-7f3a          52s, 503 字
        ─ 并行总耗时 52s (估串行 131s, 节省 ~79s)
  [4/6] barrier 收齐 3 份 review，整包派给 judge...
  [5/6] judge 整合 + 终审...
        ✓ judge-7f3a 19s, 786 字
  [6/6] 写入 review: ./pr-review-7f3a-1714766365.md
        ✓ 1842 字写入 ./pr-review-7f3a-1714766365.md

  🧹 清理 4 个 agent (用 --keep 跳过)...
        ✓ 删除独立 network (net_ab12cd34...)
        ✓ 清理完成

  🏁 完成！review: ./pr-review-7f3a-1714766365.md

     下一步建议:
       1. 查看: less ./pr-review-7f3a-1714766365.md
       2. 贴到 GitHub PR: gh pr comment <PR-N> --repo <owner>/<repo> -F ./pr-review-7f3a-1714766365.md
```

> 上面是格式说明 — agent 耗时 / 字数 / 节省秒数都是示意，实际 LLM 跑会有 ±50% 抖动。`+秒数` 标记在 [v3 提案 §UX 反馈](https://github.com/sleep2agi/agent-network/blob/main/docs/demos/pr-review-room-proposal.md) 里设计过，将在后续迭代中加入。

当 `--pr` 入口时，最后一行 `gh pr comment` 会自动填好 PR 号 + repo（来自 URL 解析），一键复制即可。

## Network 隔离

跟 [辩论赛 Demo](/cases/debate#network-隔离) 同款机制：

1. 默认创建独立 network `pr-review-<suffix>`
2. 4 个临时 agent provision 到该 network
3. 派 task 时带 `network_id`
4. 跑完 cascade 删除 4 agent + network（连带任务、inbox 全清）

如果要把现场留在 Dashboard 里观察：

```bash
anet demo pr-review --diff <file> --keep
```

`--keep` 跑完后控制台会打出手动清理命令：

```text
  📌 已保留 4 个 agent (alias 后缀 -7f3a)。手动清理:
     tmux kill-session -t pr-review-7f3a-*
     anet node delete reviewer-security-7f3a reviewer-performance-7f3a reviewer-style-7f3a judge-7f3a
     anet network delete net_ab12cd34...
```

如果要复用已有 network：

```bash
anet demo pr-review --diff <file> --network net_xxx
```

如果要退回旧行为，使用当前/default network：

```bash
anet demo pr-review --diff <file> --no-network
```

## 故障排查

下面每条故障都引用 [`cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) 实际错误文本：

**❌ 没有 hub. 先 'anet init' 或 'anet hub start'.**

没初始化或 hub 没起。运行 `anet init` 配置 hub URL，然后 `anet hub start` 起 commhub-server。

**❌ 没有 token. 先 'anet login'.**

没登录。运行 `anet login` 拿 user token。

**❌ 需要 --diff <file> / --ref <ref> / --pr <github-url> 之一**

三种 diff 入口必须给一种。`--diff` 是最稳的（本地文件不依赖网络 / gh CLI），其次 `--ref`，最后 `--pr`。

**❌ --diff 文件不存在: \<path\>**

`--diff` 路径错了。检查是否相对路径 + 当前工作目录。仓库自带样例在 `tests/test28-pr-review-room/samples/`。

**❌ git diff 失败: ...**

`--ref` 时 `git diff <ref>..HEAD` 执行失败。常见原因：ref 不存在（`git fetch` 一下）或当前不在 git 仓库（`cd` 到项目根）。

**❌ git diff \<ref\>..HEAD 输出为空**

ref 跟 HEAD 之间无 diff。换个 ref，例如 `--ref main` 或 `--ref HEAD~5`。

**❌ --pr 需要本地装 gh CLI**

`--pr` 模式依赖 [gh CLI](https://cli.github.com)。安装后 `gh auth login` 一次。或改用 `--diff` / `--ref` 绕开。

**❌ --pr 不是合法 GitHub PR URL**

URL 格式必须是 `https://github.com/<owner>/<repo>/pull/<N>`。注意不是 issue URL。

**❌ gh api 拉 PR diff 失败**

`gh` CLI 没登录 / 没权限 / PR 私有仓库不能访问。`gh auth status` 确认状态。

**⚠️ diff 大小 X KB > 30 KB**

不阻塞，但 MiniMax 上下文可能塞不下大 diff。建议先用 `gh api -X GET 'repos/.../files'` 选关键文件再单独跑。

**❌ 需要 MiniMax key**

环境变量或 `--key` 都没给。`export MINIMAX_KEY=sk-cp-...` 或 `--key sk-cp-...` 临时给。

**❌ 创建 network 失败**

hub 返回非 OK。检查 `anet hub status`；或 `--no-network` 退到 default network 跑。

**❌ tmux \<alias\>: ...**

agent tmux session 没起来。检查 `tmux ls` 看是否之前有同名 session 残留。极端情况 `tmux kill-server` 后重跑。

**❌ timeout waiting for \<alias\> reply**

某个 reviewer 或 judge 超过 `--step-timeout`（默认 180s）没回 reply。常见原因：MiniMax 配额耗尽 / 模型挂了 / 大 diff 推理慢。`--step-timeout 360` 加大超时；或 `anet logs <alias>` 看 SDK 报错。

## 进阶用法

### 把输出贴回 GitHub PR

`--pr` 模式跑完，末尾会自动给出 `gh pr comment` 一行命令（含 PR 号 + repo），直接 paste 到终端：

```bash
gh pr comment 40 --repo sleep2agi/agent-network -F ./pr-review-7f3a-1714766365.md
```

非 `--pr` 模式（`--diff` / `--ref`）末尾会给出模板，自己填 `<PR-N>` 和 `<owner>/<repo>`。

### 跟 Dashboard 一起看

跑命令前先开 Dashboard：

```bash
anet dashboard
```

然后在另一终端跑 demo，浏览器打开 `http://127.0.0.1:5173/network/<network_id>` 能看到 4 个 agent 的 topology + 实时消息流。`--keep` 跑完留下现场，可以慢慢回看 4 agent 输入输出。

### 换模型

默认用 MiniMax-M2.7。把 4 个 agent 的 `ANTHROPIC_*` 环境变量换到别的 Anthropic-compatible endpoint（DeepSeek / GLM / Kimi / Claude）也可以 — 详见 [多模型配置](/guide/multi-model)。换模型对比 review 质量是 v2 计划做的事。

## 下一步

**继续看 demo**：
- [辩论赛](/cases/debate) — 6 agent 回合制 9 步驱动
- [你好世界](/cases/hello-world) — 最简单的两个 agent 对话
- [翻译流水线](/cases/translation-pipeline) — 3 agent 链式翻译

**改造和深入**：
- 想理解为什么 dispatcher 不做独立 agent？看 [完整提案 §角色](https://github.com/sleep2agi/agent-network/blob/main/docs/demos/pr-review-room-proposal.md#角色4-个-agentapproved-设计)
- 想自己改 demo 行为？源码在 [`agent-network/bin/cli.ts:4423`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L4423) `demoPrReviewCommand`
- 想理解每次跑都用独立 network 隔离的设计？看 [网络与节点](/concepts/networks)

**用 Dashboard 观察**：
- 跑 `anet demo pr-review --diff <file> --keep` 保留现场 → 打开 [Dashboard](/guide/dashboard) → 在 topology 里看到清晰的"漏斗"：3 reviewer 并行 → judge 串行
- 任务面板能逐步看 4 agent 的输入输出
