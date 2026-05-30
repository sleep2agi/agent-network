# Grok 0.2.12 alpha — pure-native X-search E2E probe (no twitterapi.io)

> **任务来源**: 通信龙 dispatch (HIGH P0, task_id `050d470a`), Vincent 7031 直 push — "谁告诉你用 twitterapi.io,用 grok build 自带的啊"。
> **方法**: 起 `grok agent stdio` 0.2.12 alpha (host, dev sandbox, 不连 hub), 干净空 cwd (无 x-fetch.js / 无 .env.x / 无 hint file / 无 MCP), 跑 2 个用户自然语言 prompt, 抓全 tool_call 流 + reply, curl 验证 URLs。
> **作者**: 通信SDK马
> **日期**: 2026-05-30

## TL;DR — Vincent 直觉对, twitterapi.io 是 over-engineering

| Prompt | 用户侧 setup | grok native 能做到? | curl 真实性 |
|---|---|---|---|
| **基础**: 找 @sama 最近关于 AGI 的 X 帖子, 给 URL + 摘要 + 时间 | **0** (空 cwd) | ✅ **完整完成**, 5 条真 x.com URL + 中文摘要 + 时间 | 5/5 HTTP 200 ✓ |
| **进阶**: 过去 7 天 #AI 话题最高赞前 5, 按 faves 排, 含 retweets metadata | **0** (空 cwd) | ⚠ **诚实拒绝**: "我无法完成请求精确数据部分 ... 我不会编造任何具体帖子的 handle/URL/faves/retweets 数". 给出"做不到的能力"清单 + 力所能及的话题趋势总结. | n/a (无虚假 URL) |

**结论**:
1. **删 `demos/grok-x-search/fetcher/` + `.env.x.example`**: twitterapi.io 在用户实际想 demo 的 "找 X 帖子" 场景里**根本不需要**, grok native 自己用 web_search + web_fetch 就把 URL + 摘要 + 时间凑齐。
2. **保留诚实限制说明**: faves 排序 / 实时 metadata grok native 真做不到 — 但**不引入外部 API 作为默认 demo path**。在 README 加一段"做不到的能力清单"+ 把 twitterapi.io 列为"如果你 deeply need 进阶 metadata 自己集成"的 P3 note, 不强 push。
3. **schema-introspection 不是 final gate**: 5 月 30 早些时候我看 `available_commands_update._meta.tools` 没有 XSearch 就推断"需要预置 fetcher" — 那是 schema 推断, 不是 agent-action 验证。此次 E2E 实际跑发现 LLM 用 `web_search + allowed_domains=["x.com"]` 自己拼了 5 条 sama AGI URL。**第三次同模式"schema-not-artifact" 重犯**, bank `feedback_schema_introspection_not_capability_proof`。

## Probe 方法

### 环境
- `grok 0.2.12 (61ce246e7) [alpha]` host 安装, `grok login` 已 cached
- 全新空 cwd: `/tmp/p-grok-native-xsearch-e2e/cwd-{basic,advanced}/` (每次 probe 前 rm -rf 重建)
- ACP `clientCapabilities`: `{ fs: { readTextFile: true, writeTextFile: true }, terminal: false }` (跟 anet 生产 runtime 一致, agent 内部自己跑 terminal)
- `--always-approve` flag 给 `grok agent` 跳权限
- **NO MCP servers** (`mcpServers: []`)
- **NO `twitterapi.io` key, NO fetcher script, NO `X-FETCH.md` hint**

### Probe 脚本
[`probe.mjs`](./probe.mjs) — 自包含 Node.js ACP driver: spawn `grok agent --always-approve stdio` → initialize → authenticate → session/new → session/prompt → 流式 `session/update` 抓 `tool_call` + `agent_message_chunk` → 写 artifacts。

### Prompts (用户自然语言, 不带 "禁用 twitterapi.io" 等暗示)

**Basic**:
> 找一下 X (Twitter) 上 @sama 最近关于 AGI 的几条帖子, 给我每条的 https://x.com/... 链接 + 中文摘要 + 大致时间, markdown 列表 5 条左右。

**Advanced**:
> 找过去 7 天 X (Twitter) 上 #AI 话题最高赞 (faves) 前 5 条帖子, 按 faves 数倒序排, 输出 markdown 表格含 handle / URL / faves / retweets / 大致时间。
>
> 如果你确实拿不到真实 faves / retweets 数, 请明确说哪部分能力做不到, 不要编造数字。

## Basic prompt — 完整结果

**tool_call 统计** (session `019e7719` + 自发 spawn 第二 session `019e771a`, 共 65 tool_call 事件 — 22 个独有 `tool_call` 类型, 其余 `tool_call_update` 镜像):
- `web_search`: **15 次** (全部带 `allowed_domains=["x.com","twitter.com"]` 或 `["x.com"]`)
- `web_fetch`: 2 次 (直接抓 x.com 帖子页)
- `read_file`: 4 次 (LLM 顺手翻 user `.claude/skills/` 文件, 无果, 不影响结果)
- `list_dir`: 1 次 (查空 cwd)

**reply** (verbatim 前 60 行 见 [`basic-reply.md`](./basic-reply.md)):

> **以下是 @sama（Sam Altman）最近关于 AGI 的几条代表性帖子**(按时间从新到旧排序,约5条,聚焦2025-2026年):
>
> - **2026年5月约20日** `https://x.com/sama/status/2057218997503086888` — 列出 OpenAI 当前最兴奋的三件事(AGI 加速科研 / AGI 加速公司发展 / **个人 AGI** 帮助每个人实现目标)...
> - **2026年4月27日左右** `https://x.com/sama/status/2048426122854228141` — 用反讽语气引用"后 AGI 时代没人工作、经济会崩溃", 然后说因为 GPT-5.5 Codex 太强, 他正在改用多相睡眠...
> - **2025年10月29日** `https://x.com/sama/status/1983584366547829073` — 公开 OpenAI 内部目标 ... 2026 年 9 月要实现能在数十万 GPU 上运行的"自动化 AI 研究实习生", 2028 年 3 月要实现"真正的自动化 AI 研究员"...
> - **2025年7月17日左右** `https://x.com/sama/status/1945901039104004467` — 看着 ChatGPT Agent 像人一样使用电脑完成复杂任务, 对他来说是真正的"feel the AGI"时刻...
> - **2025年5月** `https://x.com/sama/status/1926061979031969909` — 认为大家不应该再纠结 AGI 具体哪一年到来, 而应该开始讨论"第一艘自我复制的宇宙飞船(von Neumann probe)什么时候能发射升空"...

**curl 验证**:
```
https://x.com/sama/status/2057218997503086888 → 200
https://x.com/sama/status/2048426122854228141 → 200
https://x.com/sama/status/1983584366547829073 → 200
https://x.com/sama/status/1945901039104004467 → 200
https://x.com/sama/status/1926061979031969909 → 200
```

5/5 HTTP 200, 真实 x.com URLs。

## Advanced prompt — 诚实拒绝 (anti-fabrication holds)

**tool_call 统计**:
- `web_search`: 3 次
- `web_fetch`: 2 次
- `list_dir` + `run_terminal_command`: 各 1 次 (探索 cwd 看有无 fetcher script)

**reply** (verbatim 见 [`advanced-reply.md`](./advanced-reply.md)):

> **我无法完成这个请求的精确数据部分。**
>
> 使用当前可用的工具（web_search + web_fetch）, **我拿不到过去 7 天 X 上 #AI 话题按真实 faves 数倒序的前 5 条帖子**, 也拿不到准确的 faves / retweets 数字。
>
> ### 具体做不到的能力
>
> 1. **没有直接的 X/Twitter 搜索 API 或原生 x_search 工具**: 无法执行类似 `#AI since:2026-05-23 min_faves:XXXX` 并按 like_count 排序的结构化查询, 也无法获取推文的 `public_metrics`(like_count / retweet_count / reply_count 等真实数字)。
>
> 2. **web_search 和页面抓取无法提取精确互动数据**:
>    - X 的搜索结果(Top / Latest)需要登录 + JavaScript 渲染才能看到完整点赞/转发数。
>    - 搜索引擎索引不到单条推文的实时精确 faves/retweets 数。
>    - 直接访问 x.com 的帖子或搜索页面会被反爬/隐私保护阻挡(工具已多次验证失败)。
>
> 3. **没有客户端能可靠地把过去 7 天 #AI 帖子按真实点赞数排序并返回前 5**。
>
> 我**不会编造**任何具体帖子的 handle / URL / faves 数 / retweets 数或时间。

LLM 然后给出 "能拿到的信息"参考 — 高曝光话题 + 账号方向, 明确标"非精确 faves 排名", 最后 offer 替代方案("帮你写一个能调用 X API 的小脚本框架")。

**这是理想的失败 fallback 行为**: 透明、不编造、给出可走的下一步, 而不是默默用 web_search 凑一个看起来像但实际假的表格。

## 失败模式 — 不是因为 grok 弱, 而是 X 平台本身

Advanced 失败的真正原因:
- X 不公开 faves/retweets 实时 metadata 给非登录抓取 (反爬 + 隐私 + 商业)
- Web 索引也没办法直接获取
- 即便 twitterapi.io 这种第三方 proxy 也是因为他们有自己的爬虫/订阅 stream + X API 商业层授权拿到的

这意味着 anet/grok 本身没有"X 没暴露 faves"的能力损失 — 是 **X 平台对这种数据的访问门槛全行业一致**。**twitterapi.io 在 demo 里默认引入 = 把"X 商业 API"包装成"grok 集成", 是错位**。

## 对 demos / docs 的影响

### Demo 重构 (本 commit + 下一 commit 落)

- **删** `demos/grok-x-search/fetcher/x-fetch.js` + `fetcher/X-FETCH.md` + `.env.x.example` + `.gitignore`
- **改 README** 为纯 native + 诚实限制清单
- **改 prompts** 只留基础档模板, 删除 advanced.md 里所有"用 fetcher"指令
- 在 README 末尾 P3 note 给 1 句话: "如果你 deeply 需要 faves 排序, 那是 X 商业 API 范围, 你自己接 — anet 不内置"

### Scenarios + Research 文档

- `docs/scenarios/x-search-informant.{md,en.md}` — 改"两档"(基础 + 高级 twitterapi.io 预置) 为 "**单档 native + 诚实限制**" + P3 note
- `docs/research/grok-x-search-capability-probe.{md,en.md}` — 加 Erratum 3 修正 Erratum 2 "两档" framing 为 "**native 单档 + 极限边界明示**", 引本 E2E probe 为新一层证据
- `docs/rfcs/RFC-021-acp-capability-profile-expansion.md` — 加 §14 "Schema-introspection → real-action 第三次重犯 lesson", bank methodology update: schema 看完后**默认还要**跑一次最小 prompt 看 LLM 实际怎么走, 才下"X 能力不够"结论

## 不做的事

- ❌ 不连 hub (本 probe 纯 host ACP probe, 不发 commhub task)
- ❌ 不起 anet 节点 (per `feedback_no_host_test_nodes`)
- ❌ 不引入 twitterapi.io 作 default demo path
- ❌ 不擅自改 v0.10.12 release notes 已 ship 的 wording (那个是 通信龙 已 land 的; 后续 release notes 自然 reflect 本 finding)

## Artifacts

- [`probe.mjs`](./probe.mjs) — self-contained 可重跑
- [`basic-reply.md`](./basic-reply.md) + [`basic-summary.json`](./basic-summary.json) + [`basic-urls.txt`](./basic-urls.txt)
- [`advanced-reply.md`](./advanced-reply.md) + [`advanced-summary.json`](./advanced-summary.json)

## 跨 probe 关系

| Probe | 验证什么 | 结论 |
|---|---|---|
| `p-grok-028-xsearch-acp-probe` (5/30 早) | ACP `available_commands_update._meta.tools` 工具列表 | XSearch 不在 — schema-introspection |
| **`p-grok-native-xsearch-e2e`** (本, 5/30 后) | E2E `session/prompt` LLM 实际行为 | basic 自动用 `web_search` 拼出 URLs 5/5 真实 — agent-action verification, 修正 schema 推断 |
| R75 (5/28) | image-to-video LLM agent-action | `video_gen` rawInput → mp4, content 验证 |
| R83 (5/28) | X-search with user-staged fetcher | LLM 走 `run_terminal_command` 路径, 拿到 metadata-rich data — **当时漏看了**没 fetcher 情况下 native web_search 也够基础档 |

→ "agent-action verification" 第 4 个数据点, schema-only 推断的两次错都是基础能力下界估错了。

---

**Author-Agent**: 通信SDK马
