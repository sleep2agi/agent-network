# X 搜索 informant — anet × Grok Build X 搜索场景

> **场景目标**: 给 anet 加 grok-build-acp runtime 节点的 **X (Twitter) 搜索 informant capability**, 作为 [#205](https://github.com/sleep2agi/agent-network/issues/205) 优雅支持的两大场景之一 ([#206](https://github.com/sleep2agi/agent-network/issues/206) 跟踪)。
> **当前 scope**: user workspace 预备 X API key + fetch script, LLM 自主调用 `run_terminal_command` 跑该 script.
> **关键差异 vs Scenario 2 视频生成**: **NOT 0 LOC integration** — 依赖用户预先 setup X API. 见下方 "前置准备".

## 一句话

Grok backend native XSearch tool 在 ACP session 不暴露, **但 LLM 用 `run_terminal_command` 绕过 ACP isolation 跑 user workspace 已有的 X 抓取脚本**, 拿到真 X 数据。anet 这边 **0 LOC 改动 但 用户侧 setup 必需**.

## 给用户看的简单路径

### 前置准备 (NOT 0 LOC — 用户侧 setup)

跟 image-to-video 不同, X 搜索需要用户预先在 grok 节点 cwd 准备:

1. **X API key** — 二选一:
   - [twitterapi.io](https://twitterapi.io/) (第三方 X 数据 proxy, 较易拿到)
   - Official [X Developer Platform](https://developer.x.com/) (官方 API, 需 X 账号申请)
2. **Fetch script** 放在 user cwd, 至少能 `node fetch-script.js --query "..."` 跑出来 X 数据 JSON. 参考 Vincent `auto_update_news.js` (用 twitterapi.io)
3. (可选) `~/.claude/skills/` 或 cwd-level SKILL.md 写明该 script 用法 + API key 在哪 — LLM 会先 cat 这种 hint file

### 起一个 grok 节点

```bash
# 1. 全局只做一次: 给 grok 登录 (浏览器 OAuth)
grok login

# 2. 进项目 cwd (cwd 里有 fetch-script 跟 X API key env file)
anet node create grok-informant --runtime grok-build-acp
anet node start grok-informant
```

### 派一条搜索任务

来自任意 anet 节点 (claude / codex / grok / 人):

```
commhub_send_task(
  alias="grok-informant",
  task="过去 7 天 AI Agent 圈 X 上的高质量讨论, 整理一份调研报告 markdown.
        优先 Sam Altman / OpenAI / Anthropic 等关键账号 + 高互动量 thread"
)
```

LLM 行为 (SDK 实证 commhub `56173df0`):

1. `run_terminal_command cat ~/.claude/skills/vincent_update-news/SKILL.md` (找 hint)
2. `run_terminal_command head -200 /home/vansin/ai-insight/auto_update_news.js` (读 script)
3. `run_terminal_command node /home/vansin/ai-insight/auto_update_news.js --fetch-only` (跑 fetch)
4. ... 17 次 run_terminal_command 总计 + 2 次 web_search 兜底
5. LLM 自然语言总结 reply, 含 5 个真 x.com URL

**content verification**: `curl -I` 5/5 real x.com URLs HTTP 200 (Sam Altman / OpenAI / Anthropic / FransBakker9812 / minchoi 等).

## 关键差异 vs Scenario 2 视频生成

| 维度 | Scenario 2 image-to-video | Scenario 1 X-search |
|---|---|---|
| anet LOC 改动 | **0 LOC** ✓ | **0 LOC** ✓ |
| User-side setup | 0 (URL 直接进 prompt) | **必需** (X API key + fetch script) |
| 触发机制 | Grok backend 看 prompt URL 自动路由 grok-imagine-video model | LLM 用 `run_terminal_command` 跑 user workspace script |
| Verdict | 🟢 0 LOC integration | 🟡 Nuanced YES (依赖用户 workspace) |

## Prompt tips

- **明确目标账号 / 关键词** — LLM 用这些组装 fetch query (`auto_update_news.js --query "AI Agent"` 之类)
- **指明 7 天 / 24h 窗口** — fetch script 用作 time filter
- **要求最后输出 markdown 报告** — 包含 X URL + 上下文摘要, LLM 自然语言总结时会嵌进去
- **不要假定 grok 自带 X API** — 派任务时**不要**说 "用你的 X 搜索能力" (LLM 找不到 tool 会 fallback web_search 散漫). 直说 "查 X / Twitter 上的 X 话题 + 用项目里的 fetch script 拉真数据".

## 限制 + follow-up

| ID | 类型 | 描述 |
|---|---|---|
| **P1** | docs | 用户预备 fetch script + X API key 的 onboarding 指南 (跟 anet 集成无关, 用户自己搞) |
| P2 | feature | anet 自带 X informant template (e.g. `anet template install x-fetcher`) — 降低 user setup 摩擦 |
| P2 | feature | commhub `send_reply` MCP schema 扩展返回 fetched X URL 列表机读 |
| P3 | docs | grok run_terminal_command escape hatch 行为文档化 (跨 scenarios 通用) |

## 探测来源 + 参考

- [Grok X-search capability probe (ZH)](../research/grok-x-search-capability-probe.md) — 含 ⚠ Erratum 修正 verdict (R103+R107 carry-on)
- [Grok X-search capability probe (EN)](../research/grok-x-search-capability-probe.en.md)
- [Scenario 2 video-gen-marketing.md](./video-gen-marketing.md) — 姊妹场景 (image-to-video, 0 LOC)
- [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#206](https://github.com/sleep2agi/agent-network/issues/206) · [#204](https://github.com/sleep2agi/agent-network/issues/204) preview.7 isolated cwd 前置
- Vincent ai-insight repo (用户侧 setup 真实样例, 不在 anet repo): `/home/vansin/ai-insight/auto_update_news.js`

---

**Dispatch**: 通信龙 commhub `9e39963c` (#205 Scenario 1 docs amend)
**Author-Agent**: 通信文档马
