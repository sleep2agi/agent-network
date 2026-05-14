# Examples And Demo

This is the runnable Agent Network example library. The site only keeps cases with a concrete CLI path, a `demos/` directory, or Docker test coverage. Manual-only examples were removed so the docs do not outrun the code.

## Verified Examples

| Example | Run With | Agents | Verification | Highlight |
|---------|----------|:------:|--------------|-----------|
| [Debate Demo](/en/cases/debate) | `anet demo debate` | 6 | Docker test27 checks CLI help/list and docs build | Built-in 9-step debate orchestration with an isolated network |
| [PR Review Room](/en/cases/pr-review-room) | `anet demo pr-review` | 4 | Docker test28 smoke + assertions.json structural checks | 3 reviewers fan-out in parallel + barrier + judge merge; outputs a markdown PR comment ready for GitHub |
| [Hello World](/en/cases/hello-world) | `demos/hello-world` | 2 | Docker Compose assets + Docker test27 docs checks | Simplest two-agent conversation |
| [Translation Pipeline](/en/cases/translation-pipeline) | `demos/translation-pipeline` | 3 | Docker Compose assets + Docker test27 docs checks | CN to EN to JP chain translation |
| [Telegram Squad](/en/cases/telegram-squad) | `demos/codex-telegram-squad` | 11 | Docker test23/test24 communication flow + test27 docs checks | 1 commander + 10 workers, Telegram/Dashboard |
| [Telegram bind for existing node](/en/cases/telegram-bind-claude-code-cli) | `anet channel add telegram <node> ...` | 1 (channel attached to an existing node) | Manual walkthrough (`claude-code-cli` runtime; RFC-002 Phase 1 queued) | DM the bot → full Claude Code capabilities (bash / file edits / MCP) |

::: info Built-in demos not yet in this table (cases doc pending)
- `anet demo socialmedia` — 4-agent social-media content factory (topic / copy / image / reviewer), ~3 min
- `anet demo sci-team` — research squad: 1 leader + N-1 workers (default 10, tunable 5-50) running the InternLM model, Phase 1 scaffold

Run `anet demo <name> --help` for usage; full case write-ups coming soon.
:::

## Removed Examples

`Idiom Chain Game` and `Mixed Model Collab` were removed from navigation and generated pages. They only had manual instructions and no independent Docker demo or stable automated verification. They can return after matching `demos/` assets and tests exist.

> `Code Review` was restored on 2026-05-13 as [PR Review Room](/en/cases/pr-review-room) — it is now a 4-agent CLI demo with full Docker test coverage.

::: tip Before running examples
Complete the [Getting Started guide](/en/guide/getting-started) and prepare the model API keys required by each example. Docker examples should be run from the repository root or their `demos/` subdirectory.
:::

## Next steps

**After finishing a demo**:
- [Multi-model config](/en/guide/multi-model) — switch to DeepSeek / Kimi / Claude
- [Dashboard](/en/guide/dashboard) — inspect the demo's data flow in the Web UI
- [Architecture](/en/guide/architecture) — understand how Hub / agents / runtimes interact behind the demo

**Productionize**:
- [Docker deployment](/en/deploy/docker) — containerize the demo onto a server
- [Production deployment](/en/deploy/production) — full TLS / reverse-proxy / backup checklist

**Customize and extend**:
- [Channel plugins](/en/guide/channels) — wire the demo to Telegram / WeChat / Feishu
- [Agent Node config](/en/guide/agent-node) — full field reference for writing your own agents
- [CLI commands](/en/guide/cli) — command reference + v0.8 new tools
