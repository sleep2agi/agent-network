# X Search Informant — anet × Grok Build X-search scenario

> **Goal**: Give anet `grok-build-acp` runtime nodes an **X (Twitter) search informant capability**, one of the two flagship scenarios for [#205](https://github.com/sleep2agi/agent-network/issues/205) (tracked in [#206](https://github.com/sleep2agi/agent-network/issues/206)).
> **Current scope**: the user pre-stages an X API key and a fetch script in their workspace; the LLM autoregressively calls `run_terminal_command` to drive that script.
> **Key difference vs. Scenario 2 video generation**: **NOT a 0 LOC integration** — depends on user-side X API setup. See "Prerequisites" below.

## One-liner

The Grok backend's native XSearch tool is **not exposed inside the ACP session**, **but the LLM bypasses the ACP isolation via `run_terminal_command` and invokes pre-existing X-fetching scripts in the user workspace** to retrieve real X data. anet itself ships **0 LOC of changes — but the user must complete the X API setup.**

## The simple user path

### Prerequisites (NOT 0 LOC — user-side setup)

Unlike image-to-video, X search requires the user to pre-stage these in the grok node's cwd:

1. **An X API key** — one of:
   - [twitterapi.io](https://twitterapi.io/) (third-party X data proxy, easier to obtain)
   - Official [X Developer Platform](https://developer.x.com/) (requires an X account application)
2. **A fetch script** in the user cwd, capable of `node fetch-script.js --query "..."` returning X data as JSON. Reference: Vincent's `auto_update_news.js` (uses twitterapi.io).
3. (Optional) `~/.claude/skills/` or a cwd-level `SKILL.md` describing the script's usage and where the API key lives — the LLM will `cat` such hint files first.

### Start a Grok node

```bash
# 1. One-time global step: log into Grok (browser OAuth)
grok login

# 2. cd into the project cwd (which already has the fetch script + the X API key env file)
anet node create grok-informant --runtime grok-build-acp
anet node start grok-informant
```

### Dispatch a search task

From any anet node (claude / codex / grok / a human):

```
commhub_send_task(
  alias="grok-informant",
  task="High-quality discussions in AI-Agent circles on X over the past 7 days — produce a markdown research report.
        Prioritise Sam Altman / OpenAI / Anthropic and other key accounts plus high-engagement threads"
)
```

LLM behaviour (SDK-verified, commhub `56173df0`):

1. `run_terminal_command cat ~/.claude/skills/vincent_update-news/SKILL.md` (find hint)
2. `run_terminal_command head -200 /home/vansin/ai-insight/auto_update_news.js` (read script)
3. `run_terminal_command node /home/vansin/ai-insight/auto_update_news.js --fetch-only` (run fetch)
4. ... 17 `run_terminal_command` calls in total + 2 `web_search` calls as fallback
5. Natural-language reply with 5 real x.com URLs

**Content verification**: `curl -I` against the surfaced URLs returns 5/5 real x.com HTTP 200s (Sam Altman / OpenAI / Anthropic / FransBakker9812 / minchoi, etc.).

## Key difference vs. Scenario 2 video generation

| Dimension | Scenario 2 image-to-video | Scenario 1 X search |
|---|---|---|
| anet LOC changes | **0 LOC** ✓ | **0 LOC** ✓ |
| User-side setup | none (URL goes straight into the prompt) | **required** (X API key + fetch script) |
| Trigger mechanism | Grok backend sees URL in prompt → auto-routes to `grok-imagine-video` | LLM uses `run_terminal_command` to run a user-workspace script |
| Verdict | 🟢 0 LOC integration | 🟡 Nuanced YES (depends on user workspace) |

## Prompt tips

- **Specify target accounts / keywords** — the LLM composes the fetch query (`auto_update_news.js --query "AI Agent"` etc.) from these.
- **Specify a 7-day / 24h window** — the fetch script uses it as a time filter.
- **Ask for a final markdown report** — including X URLs and context summary; the LLM weaves them into the natural-language reply.
- **Don't assume Grok has a built-in X API** — when dispatching, **do not** say "use your X-search capability"; the LLM won't find the tool and falls back to a vague `web_search`. Say directly "look up X / Twitter topic X, using the fetch script in this project to retrieve real data".

## Limits + follow-ups

| ID | Type | Description |
|---|---|---|
| **P1** | docs | A user-side onboarding guide for staging the fetch script + X API key (independent of anet — user handles their own setup) |
| P2 | feature | anet-bundled X informant template (e.g. `anet template install x-fetcher`) — reduce user-side setup friction |
| P2 | feature | Extend commhub `send_reply` MCP schema with a machine-readable list of fetched X URLs |
| P3 | docs | Document the Grok `run_terminal_command` escape-hatch behaviour (applies across scenarios) |

## Probe sources + references

- [Grok X-search capability probe (ZH)](../research/grok-x-search-capability-probe.md) — contains the ⚠ Erratum updating the verdict (R103+R107 carry-on)
- [Grok X-search capability probe (EN)](../research/grok-x-search-capability-probe.en.md)
- [Scenario 2 video-gen-marketing.en.md](./video-gen-marketing.en.md) — sibling scenario (image-to-video, 0 LOC)
- [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#206](https://github.com/sleep2agi/agent-network/issues/206) · [#204](https://github.com/sleep2agi/agent-network/issues/204) preview.7 isolated cwd prerequisite
- Vincent's `ai-insight` repo (real user-side setup sample, not in the anet repo): `/home/vansin/ai-insight/auto_update_news.js`

---

**Dispatch**: 通信龙 commhub `9e39963c` (#205 Scenario 1 docs amend)
**Author-Agent**: 通信文档马
