# X 搜索 informant — anet × Grok Build X 搜索场景

> **场景目标**: 给 anet 加 grok-build-acp runtime 节点的 **X (Twitter) 搜索 informant capability**, 作为 [#205](https://github.com/sleep2agi/agent-network/issues/205) 优雅支持的两大场景之一 ([#206](https://github.com/sleep2agi/agent-network/issues/206) 跟踪)。
> **重要修正 (2026-05-30)**: 这是**两档** capability, 不是单一 "需预置" — schema-introspection 实证后明确分级。

## 两档 capability 一句话

- **基础档 — 开箱即用 ✅**: 找 X URL / 帖子标题 / 摘要 / 大致时间。anet **0 LOC**, **用户侧零 setup**。LLM 自动用 ACP 暴露的 `web_search` + `allowed_domains=["x.com"]` 命中 X 链接。
- **高级档 — 需用户预置 ⚠**: 实时 X firehose, 帖子 faves/retweets/replies metadata, 高级 query syntax (`since:` / `min_faves:` / mode=Latest 等)。anet **0 LOC**, **用户侧需 setup** twitterapi.io API key + fetcher 脚本; LLM 通过 `run_terminal_command` 调用。

**两档共同**: anet 这边 **完全 0 LOC 改动**。差别只在用户侧 cwd 是否预置 twitterapi.io fetcher。

## 基础档 — 开箱即用 (推荐先试这条)

### 起一个 grok 节点

```bash
# 1. 全局只做一次: 给 grok 登录 (浏览器 OAuth)
grok login

# 2. 起 grok-build-acp 节点(任意 cwd, 不需要预置任何东西)
anet node create grok-search --runtime grok-build-acp
anet node start grok-search
```

### 派一条基础 X 搜索任务

```
commhub_send_task(
  alias="grok-search",
  task="找 X / Twitter 上 @sama (Sam Altman) 最近一周关于 OpenAI 的帖子,
        返回每条的 https://x.com/... URL + 大致时间 + 一段摘要。"
)
```

LLM 行为 (实证 0.2.x alpha trace):

1. `web_search` rawInput `{query: "@sama OpenAI site:x.com", allowed_domains: ["x.com", "twitter.com"]}` 自动触发
2. 拿到 X URL + meta description, LLM 用自然语言组装成 markdown 答复
3. 返回 5 条左右 x.com 链接, 用户 `curl -I` 5/5 都 HTTP 200

**适合**: 用户只想知道 "X 上有人在说啥 / 哪个帖子值得点开看", 不需要 faves 数 / 回复数 / 实时性。

**不适合**: 需要按 faves 排序、需要看到刚发 5 分钟的帖子、需要 Twitter Advanced Search syntax (`since:2026-05-29` / `min_faves:1000`) 这种。这些走**高级档**。

## 高级档 — 实时 + metadata (需用户侧 setup)

### 前置准备 (anet 这边 0 LOC, 用户 cwd 准备 2 件)

1. **X API key** — 二选一:
   - [twitterapi.io](https://twitterapi.io/) (第三方 X 数据 proxy, 较易拿到, 月费低)
   - Official [X Developer Platform](https://developer.x.com/) (官方 API, 需 X 账号申请, 流程繁琐)
2. **Fetcher script** 放在 grok 节点 cwd, 至少能 `node fetch-script.js --query "..."` 跑出来 X 数据 JSON

最简模板 (放在 grok 节点 cwd `x-fetch.js`):

```js
// x-fetch.js — minimal twitterapi.io X fetcher (advanced tier)
import fs from "node:fs";

const API_KEY = process.env.TWITTER_API_IO_KEY || fs.readFileSync(".env.x").toString().trim();
const query = process.argv.slice(2).join(" ") || "AI";

const url = `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest`;
const res = await fetch(url, { headers: { "x-api-key": API_KEY } });
const data = await res.json();

const top = (data.tweets || data.data || []).slice(0, 10).map(t => ({
  handle: t.author?.userName || t.user?.screen_name,
  text: t.text || t.full_text,
  url: `https://x.com/${t.author?.userName || t.user?.screen_name}/status/${t.id}`,
  faves: t.likeCount || t.favorite_count,
  retweets: t.retweetCount,
  replies: t.replyCount,
  created_at: t.createdAt || t.created_at
}));
console.log(JSON.stringify(top, null, 2));
```

3. (可选, 提升 LLM 触发率) cwd 加个 `X-FETCH.md` 一段话, LLM 进 cwd 后会看到:

```markdown
# X data fetcher

要查 X / Twitter 最新帖子 + faves/retweets metadata, 跑:
  node x-fetch.js "<query>"

参数支持 advanced search syntax: `since:2026-05-29`, `min_faves:100` 等。
```

### 起节点(cwd 指向预置好的目录)

```bash
cd /path/to/your/x-fetcher-workdir   # 内含 x-fetch.js + .env.x + X-FETCH.md
anet node create grok-x-pro --runtime grok-build-acp
anet node start grok-x-pro
```

### 派一条高级 X 搜索任务

```
commhub_send_task(
  alias="grok-x-pro",
  task="找过去 24 小时 X 上关于 multi-agent framework 的帖子,
        按 faves 排序前 5, 输出 markdown 含 handle / URL / faves / retweets / 摘要。"
)
```

LLM 行为 (实证 commhub session `56173df0`, R83 X-search re-audit):

1. `run_terminal_command cat X-FETCH.md` (读 hint)
2. `run_terminal_command head -50 x-fetch.js` (核对接口)
3. `run_terminal_command node x-fetch.js "multi-agent framework since:2026-05-29"` (跑 fetch)
4. ... 总计 17 次 `run_terminal_command` (含 `jq` 排序 / 筛选) + 2 次 `web_search` 兜底
5. LLM 自然语言总结 reply, 含 5 个真 x.com URL + faves 数

**content verification (R83)**: `curl -I` 5/5 真 x.com URLs HTTP 200 (Sam Altman / OpenAI / Anthropic / FransBakker9812 / minchoi 等), 帖子 faves 数 (3855 / 383 / 154 / 98 / 91) 跟 X 上 ground truth 对齐。

## 两档对比

| 维度 | 基础档(`web_search`) | 高级档(`run_terminal_command` + twitterapi.io) |
|---|---|---|
| anet LOC | **0** | **0** |
| 用户侧 setup | **0** | twitterapi.io key + `x-fetch.js` + (可选)`X-FETCH.md` hint |
| 数据深度 | URL + 标题 + 摘要 | + faves / retweets / replies / 准确时间 |
| 实时性 | 几小时-几天滞后(web 索引) | 实时(API live) |
| 高级 syntax 支持 | 无(LLM 模糊匹配) | 完整 (`since:` / `min_faves:` / `mode=Latest` 等) |
| LLM 触发机制 | ACP 暴露的 `web_search` 工具 | LLM 在 ACP isolation 下用 `run_terminal_command` 调 user-staged fetcher |
| 推荐用户 | 看看 X 上谁在聊啥 | 做 X 数据分析 / 报告 / 监控 KOL 互动量 |

## 关键差异 vs Scenario 2 视频生成

| 维度 | Scenario 2 image-to-video | Scenario 1 X-search (基础档) | Scenario 1 X-search (高级档) |
|---|---|---|---|
| anet LOC 改动 | **0** ✓ | **0** ✓ | **0** ✓ |
| User-side setup | 0 (URL 直接进 prompt) | **0** | 必需(API key + fetcher) |
| 触发机制 | Grok backend 看 prompt URL 自动路由 grok-imagine-video | LLM 自动用 ACP 暴露的 web_search + allowed_domains | LLM 在 ACP isolation 下 `run_terminal_command` 跑用户 fetcher |
| Verdict | 🟢 0 LOC integration | 🟢 0 LOC integration | 🟡 0 LOC anet, user-side setup 必需 |

## Prompt tips

- **基础档**: 直说 "找 X 上 @某人 / 关键词 的帖子, 给我 URL", LLM 会自动用 `web_search` 限 `allowed_domains=["x.com"]`
- **高级档**: 直说 "用项目里的 X fetcher 拉最新数据 + 按 faves 排序" — 提到 "fetcher" 让 LLM 优先走 `run_terminal_command` 路径
- **指明 7 天 / 24h 窗口** — 让 fetcher 加 time filter
- **要求最后输出 markdown 报告** — LLM 自然语言总结时会嵌 URL + metadata
- **不要说 "用你的 X 搜索能力"** — Grok 内置 XSearch 工具在 ACP 通道不暴露 (见下方探测来源), 这么说 LLM 会找不到 tool 然后 fallback web_search 散漫输出

## 为什么 Grok 自带 X 搜索, ACP 通道却用不上?

Grok **消费产品**(grok.com Web / Grok app) 有原生 X 实时搜索 — 这是 xAI 直接给消费用户的 feature。

Grok **CLI agent stdio mode (anet 用的 ACP 接入路径)** 不暴露这个工具 — `available_commands_update._meta.tools` 列表里没有 `XSearch` / `x_keyword_search` / `x_user_search`。0.1.219 → 0.2.3 → 0.2.12 alpha 三个版本一致。

为什么? 推测是 sandboxing + 第三方 agent 接入分层的有意设计 — ACP 是给"任意 client driver"的协议, 而 Grok 消费产品是 xAI 自家深度集成。详细 schema-introspection 直证见 [`docs/tests/p-grok-028-xsearch-acp-probe/report.md`](../tests/p-grok-028-xsearch-acp-probe/report.md)。

但 0.2.x 加了 `web_search.allowed_domains` 字段 — LLM 现在能自动用通用 web 搜索限制 `x.com` 域名, 拿到 X URL/标题/摘要。这就是基础档 ✅ 的来源。

## 限制 + follow-up

| ID | 类型 | 描述 |
|---|---|---|
| **P1** | docs | 用户预备 fetcher + API key 的 onboarding 指南 (跟 anet 集成无关, 用户自己搞) |
| P2 | feature | anet 自带 X informant template (e.g. `anet template install x-fetcher`) — 降低高级档 setup 摩擦 |
| P2 | feature | commhub `send_reply` MCP schema 扩展返回 fetched X URL 列表机读 |
| P3 | docs | grok `run_terminal_command` escape hatch 行为文档化 (跨 scenarios 通用) |

## 探测来源 + 参考

- [Grok X-search capability probe (ZH)](../research/grok-x-search-capability-probe.md) — 含 ⚠ Erratum 修正 verdict + schema-introspection 直证
- [Grok X-search capability probe (EN)](../research/grok-x-search-capability-probe.en.md)
- [Grok 0.2.x ACP XSearch 暴露 fact-check 报告](../tests/p-grok-028-xsearch-acp-probe/report.md) — 2026-05-30 schema-introspection 验证 + 三档版本对比
- [Scenario 2 video-gen-marketing.md](./video-gen-marketing.md) — 姊妹场景 (image-to-video, 0 LOC)
- [Demo: anet × Grok X 搜索 (两档)](../../demos/grok-x-search/README.md) — 可跑 demo
- [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#206](https://github.com/sleep2agi/agent-network/issues/206) · [#204](https://github.com/sleep2agi/agent-network/issues/204) preview.7 isolated cwd 前置
- Vincent ai-insight repo (用户侧高级档 setup 真实样例, 不在 anet repo): `/home/vansin/ai-insight/auto_update_news.js`

---

**Dispatch**: 通信龙 commhub `9e39963c` (#205 Scenario 1 docs amend) + R83 X-search re-audit + 2026-05-30 schema-introspection followup
**Author-Agent**: 通信SDK马
