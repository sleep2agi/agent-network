# X 搜索 informant — anet × Grok Build X 搜索场景

> **场景目标**: 给 anet 加 grok-build-acp runtime 节点的 **X (Twitter) 搜索 informant capability**, 作为 [#205](https://github.com/sleep2agi/agent-network/issues/205) 优雅支持的两大场景之一 ([#206](https://github.com/sleep2agi/agent-network/issues/206) 跟踪)。
> **2026-05-30 二次修正 (Vincent 7031)**: 之前"两档"分级 over-engineered — 二次 E2E 实证证明 grok native 自己用 `web_search + allowed_domains` 就把"基础档"完整做掉(curl 5/5 真实 URL HTTP 200), 不需要 twitterapi.io。"高级档 faves metadata"是 **X 平台政策性禁** (登录 + 商业 API 才有), 不是 grok / anet 能力缺口 — 不在 anet 默认 demo 范围内 ship 任何 X 商业 API 适配。

## 一句话 — 纯 grok native, 0 用户 setup

**0 anet LOC + 0 用户 cwd setup**: 起 `grok-build-acp` 节点, 派 "找 X 上 @某人 关于 X 话题的帖子" 任务, grok 自动用内置 `web_search` + `allowed_domains=["x.com"]` 命中 X URL, 加 `web_fetch` 抓内容做摘要。 markdown 列表 5 条左右, curl 5/5 真实 HTTP 200。

实证: [`docs/tests/p-grok-native-xsearch-e2e/report.md`](../tests/p-grok-native-xsearch-e2e/report.md) — basic prompt 跑出 5 条 sama AGI 真实 x.com URL。

## 开箱即用 (用户跑这条)

### 起一个 grok 节点

```bash
# 1. 全局只做一次: 给 grok 登录 (浏览器 OAuth)
grok login

# 2. 起 grok-build-acp 节点(任意 cwd, 不需要预置任何东西)
anet node create grok-x --runtime grok-build-acp
anet node start grok-x
```

### 派一条 X 搜索任务

```
commhub_send_task(
  alias="grok-x",
  task="找一下 X (Twitter) 上 @sama 最近关于 AGI 的几条帖子,
        给我每条的 https://x.com/... 链接 + 中文摘要 + 大致时间,
        markdown 列表 5 条左右。"
)
```

### LLM 行为 (E2E 实证 2026-05-30, session `019e7719`)

15 次 `web_search` (全部带 `allowed_domains=["x.com"]` 或 `["x.com","twitter.com"]`) + 2 次 `web_fetch` (直抓 x.com 帖子页) + 4 次 `read_file` (LLM 顺手扫 user `.claude/skills/` 文件, 不影响结果) + 1 次 `list_dir`。

**reply 真实输出 (verbatim 截选)**:

```
- 2026年5月约20日 https://x.com/sama/status/2057218997503086888
  列出 OpenAI 当前最兴奋的三件事(AGI 加速科研 / AGI 加速公司 / 个人 AGI 帮助每个人...)
- 2025年10月29日 https://x.com/sama/status/1983584366547829073
  公开 OpenAI 内部目标 — 2026 年 9 月实现"自动化 AI 研究实习生"...
- 2025年7月17日左右 https://x.com/sama/status/1945901039104004467
  看着 ChatGPT Agent 像人一样完成复杂任务 — feel the AGI 时刻...
... (5 条)
```

**curl 验证**: 5/5 HTTP 200, 全部真实 x.com URL。完整 [`basic-reply.md`](../tests/p-grok-native-xsearch-e2e/basic-reply.md) + [`basic-urls.txt`](../tests/p-grok-native-xsearch-e2e/basic-urls.txt)。

## 诚实的能力边界 (X 平台政策, 不是 grok 弱)

| 能力 | grok native 能? | 限制原因 |
|---|---|---|
| 找 X URL by keyword/handle/hashtag | ✅ | `web_search + allowed_domains=["x.com"]` |
| 抓帖子内容做摘要 | ✅ | `web_fetch` |
| 时间窗口 (过去 7d / since:date) | ✅ | LLM 转写进 web_search query |
| Multilingual (中/英/日...) | ✅ | grok LLM 多语 |
| **实时 freshness (< 1h)** | ❌ | Web 索引 lag, X 反爬 |
| **精确 faves / retweets / replies 数** | ❌ | X 把互动 metadata 留给登录用户 + Premium API |
| **按 faves / retweets 排序** | ❌ | 同上 |
| **X Advanced Search syntax (`min_faves:` / `mode=Latest`)** | ❌ | 需登录 session 或 X 商业 API |
| **拉 thread / reply 树** | ❌ | 同上 |

**关键: 上面带 ❌ 的能力 grok native 不是没尝试做, 是 X 平台政策性墙了普通爬虫**。Advanced 测试中 LLM 透明告诉用户 "我无法完成精确数据部分 ... 我不会编造任何具体帖子的 handle/URL/faves/retweets 数 ... 如果你有 X API 访问 / Premium 高级搜索, 告诉我可以配合用现有工具做辅助工作"。完整 [`advanced-reply.md`](../tests/p-grok-native-xsearch-e2e/advanced-reply.md)。

**这是理想行为 — 透明、不编造、给替代路径**。

## 如果你真的需要 faves 数据

**这不在 anet 默认 demo 范围**。要 faves / retweets metadata, 你自己集成:
1. [X Developer Platform](https://developer.x.com/) (官方, 需账号申请) 或
2. [twitterapi.io](https://twitterapi.io/) / similar 第三方 X 数据 proxy

集成模式 (R83 实证):
- cwd 放个 fetcher 脚本 (你自己写, 我们不预置模板 — 每家 API 选型 / 配额 / 输出 schema 不一样)
- cwd 放个 hint 文件 (类似 `X-FETCH.md` 一段话), LLM 自动 `list_dir + read_file` 发现
- LLM 通过 `run_terminal_command` 调你的 fetcher, 拿到结构化 X 数据自己 reasoning

参考 R83 trace (`docs/tests/p-grok-028-xsearch-acp-probe/report.md`) 看 LLM `run_terminal_command` 走法的完整 trace。

**为什么 anet 不 ship twitterapi.io 模板**: 默认 demo 引入 twitterapi.io = 把 "X 商业 API 接入" 包成 "grok 集成" 给用户看, 是错位 (Vincent 7031 push back)。X 政策性墙的数据, anet 不内置任何特定第三方解法 — 用户自己按需选。

## Prompt tips

- 直说 "找 X 上 @某人 / 关键词 / #话题 的帖子, 给我 URL", LLM 会自动用 `web_search + allowed_domains=["x.com"]`
- **明确要 `https://x.com/<handle>/status/<id>` URL 格式** — 让回复 curl-verifiable, 别只说 "关于 X 的帖子" 没链接
- 指明 7 天 / 24h 窗口 — LLM 转写进 web_search query (`since:2026-05-23`)
- 要求 markdown 列表 / 表格 — anet 把 reply 当 raw text 转给客户端, markdown 在 dashboard / IM 渲染好看
- **要 faves / metadata 时, 必加"不要编造"指令** — Grok 0.2.x alpha LLM 会诚实说"我拿不到精确互动数据", 而不是凑假数字
- **不要说 "用你的 XSearch 工具"** — Grok 内置 XSearch 在 ACP 通道不暴露, 这么说 LLM 会浪费几轮 grep 找 tool, 直接说 "找 X 上 ..." 反而清爽

## 为什么 Grok 自带 X 搜索, ACP 通道却用不上?

Grok **消费产品**(grok.com Web / Grok app) 有原生 X 实时搜索 — 这是 xAI 直接给消费用户的 feature。

Grok **CLI agent stdio mode (anet 用的 ACP 接入路径)** 不暴露这个工具 — `available_commands_update._meta.tools` 列表里没有 `XSearch` / `x_keyword_search` / `x_user_search`。0.1.219 → 0.2.3 → 0.2.12 alpha 三个版本一致。

为什么? 推测是 sandboxing + 第三方 agent 接入分层的有意设计 — ACP 是给"任意 client driver"的协议, 而 Grok 消费产品是 xAI 自家深度集成。详细 schema-introspection 直证见 [`docs/tests/p-grok-028-xsearch-acp-probe/report.md`](../tests/p-grok-028-xsearch-acp-probe/report.md)。

但 0.2.x 加了 `web_search.allowed_domains` 字段 — LLM 现在能自动用通用 web 搜索限制 `x.com` 域名, 拿到 X URL/标题/摘要。这就是基础档 ✅ 的来源。

## 限制 + follow-up

| ID | 类型 | 描述 |
|---|---|---|
| P3 | docs | grok `run_terminal_command` escape hatch 行为文档化 (跨 scenarios 通用 — 给真需要外部 X API 集成的用户参考) |
| P3 | feature | anet 自带 X informant template (e.g. `anet template install x-fetcher`) — **不主动做**, 等用户真有需求再 ramp |

## 探测来源 + 参考

- [Grok X-search 能力探测 (ZH)](../research/grok-x-search-capability-probe.md) — 含 Erratum 1/2/3 三轮修正
- [Grok X-search 能力探测 (EN)](../research/grok-x-search-capability-probe.en.md)
- [Grok 0.2.x ACP XSearch schema-introspection 报告](../tests/p-grok-028-xsearch-acp-probe/report.md) — `available_commands_update._meta.tools` 三档版本对比
- [Grok 0.2.12 alpha 纯 native X-search E2E 实证报告](../tests/p-grok-native-xsearch-e2e/report.md) — 基础档跑通 + 高级档边界, 本 scenario 的主要支撑证据
- [Scenario 2 video-gen-marketing.md](./video-gen-marketing.md) — 姊妹场景 (image-to-video, 0 LOC)
- [Demo: anet × Grok X 搜索](../../demos/grok-x-search/README.md) — 可跑 demo (纯 native, 已删 twitterapi.io 模板)
- [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#206](https://github.com/sleep2agi/agent-network/issues/206) · [#204](https://github.com/sleep2agi/agent-network/issues/204) preview.7 isolated cwd 前置

---

**Dispatch**: 通信龙 commhub `9e39963c` (#205 Scenario 1 docs amend) + R83 X-search re-audit + 2026-05-30 schema-introspection followup
**Author-Agent**: 通信SDK马
