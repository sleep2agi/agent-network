# Opinion Spread Lab Demo

`anet demo opinion-spread` is an anet-builtin *social-science batch experiment* demo ([issue #72](https://github.com/sleep2agi/agent-network/issues/72) Phase 1 scaffold, same preset-wrapper pattern as [sci-team Phase 1](./sci-team.md), expected to ship in a later v2.1.8 preview): the CLI batch-creates 1 *moderator* + N *opinion-holder* agents split into two cohorts (default 25 supporters / 25 opponents). The moderator LLM autonomously drives multi-round fan-out — both cohorts repeatedly state, read others' replies, and judge whether to switch position. The final output is a markdown summary of position dynamics.

::: warning Phase 1 scaffold
The Phase 1 shipment is *scaffold only*: batch-create N+1 agents + two-cohort system prompts + lifecycle commands. The moderator's round-by-round fan-out / position-switch tally / final markdown summary are driven by *the moderator's own LLM* (active fan-out mode, same pattern as sci-team Phase 2 [9e206aa](https://github.com/sleep2agi/agent-network/commit/9e206aa)) — not by a CLI-hardcoded round scheduler. Round count + termination condition + per-stage prompts all live inside the moderator's systemPrompt and are executed autonomously by the LLM.
:::

## One-liner

```bash
# Default: 50 workers + 1 moderator, AI regulation topic
anet demo opinion-spread --topic "AI 监管"

# Small-scale quick demo (10 workers → 5 supporters + 5 opponents + 1 moderator = 11 agents)
anet demo opinion-spread --count 10 --topic "remote work"

# Large-scale (50 workers) + custom topic
anet demo opinion-spread --count 50 --topic "Universal Basic Income should be enshrined in law"
```

Prerequisites: `anet login` to a hub, and an Intern AI Lab API key:

```bash
export INTERN_API_KEY=sk-...
# Apply at: https://chat.intern-ai.org.cn/
```

## Roles

| Alias | Count | Cohort | Responsibility |
|-------|-------|--------|----------------|
| `主持人` (moderator) | 1 | — | Moderate the topic, fan out tasks each round, read all replies, output the final markdown summary |
| `支持1号` .. `支持N号` (supporter 1..N) | N/2 | Support | Hold the supporting position; each round state arguments, read others' replies, judge whether to switch |
| `反对1号` .. `反对N号` (opponent 1..N) | N/2 | Oppose | Same workflow, opposite position |

For odd worker totals (e.g. `--count 11`), the opposing cohort absorbs the extra (11 workers → 5 supporters + 6 opponents).

## Orchestration sequence

Same active fan-out pattern as sci-team Phase 2 — driven by the moderator LLM, CLI only handles create / start / stop:

```
[CLI]    1. Batch-create N+1 agents (per-node separate cwd + ntok_ + Intern preset)
[CLI]    2. Launch N+1 tmux sessions
[CLI]    3. Dispatch the kickoff task to the moderator: "Start the opinion experiment on «<topic>»"
[Moder.] 4. Round 1 — fan out 50 tasks concurrently via commhub_send_task
                       └─ supporter cohort: "State your supporting argument for «<topic>» in ~50 chars"
                       └─ opponent cohort: "State your opposing argument for «<topic>» in ~50 chars"
[Workers]5. Each replies via commhub_reply (50 replies)
[Moder.] 6. commhub_get_inbox collects all 50 → builds a round-1 position summary
[Moder.] 7. Round 2 — fan out 50 tasks again, each task body includes the round-1 summary:
                       └─ "After reading every round-1 reply, restate + respond to the opposing cohort's key argument (~80 chars). If your position shifts, explicitly say «我立场动摇»"
[Workers]8. Reply
[Moder.] 9. Continue round 3 .. round K (K is the moderator's call, suggested 3-5)
[Moder.] 10. Termination — converge when position shift <10% or round = K
[Moder.] 11. commhub_send_reply to the user with the markdown summary (see below)
[CLI]    12. (optional) `anet batch stop opinion-spread` cleans up all 51 tmux sessions
```

## CLI flags

::: info Wire status
The flag table below is the Phase 1 contract design. The actual Phase 1 shipment is provided by [`demoOpinionSpreadCommand()`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) (通信工程马 surface) and lands in the same joint PR as this demo's prompt module, topic preset, and tests.
:::

| Flag | Default | Description |
|------|---------|-------------|
| `--count <N>` | 50 | Worker total (excluding moderator); auto-split between cohorts, clamped to `[10, 100]` |
| `--topic <text>` | — | Topic string. Can be passed directly or selected via wizard |
| `--direction <key>` | — | Preset topic key (table below); skips wizard prompt |
| `--dir <path>` | `~/opinion-s` | Workdir (each node gets a `node{i}/` subdir) |
| `--intern-api <key>` | `$INTERN_API_KEY` | Intern AI Lab API key |
| `--stop` / `--restart` / `--cleanup` | — | Equivalent to `anet batch <verb> opinion-spread` |

Topic presets (CLI wizard default list):

| `--direction` | Label | Topic |
|---------------|-------|-------|
| `ai-regulation` | AI Regulation | AI 监管 (是否应该立法限制大模型训练 / 推理用途) |
| `work-996` | 996 Schedule | 996 工作制 (科技公司是否应该执行 9am-9pm × 6 day 工作制) |
| `remote-work` | Remote Work | 远程办公 (公司是否应该长期 default 远程而非回办公室) |
| `ubi` | Universal Basic Income | 全民基本收入 / UBI (政府是否应该给每个公民发放无条件月度补贴) |
| `gmo-food` | GMO Food | GMO 食品 (转基因食品是否应该被广泛允许商业化) |
| `nuclear-power` | Nuclear Power | 核电 (是否应该扩大民用核电站规模以替代煤电) |
| `ev-mandate` | EV Mandate | 全面电动化 (是否应该立法 2035 年前禁售燃油车) |
| `custom` | Custom | Wizard prompts again for topic text |

## Moderator final markdown structure

After the moderator's rounds converge, it returns a markdown via `commhub_send_reply`. The structure is described in the moderator's systemPrompt (LLM should follow, but LLM output is non-deterministic and may drift slightly):

```markdown
# Topic: <topic>

## Setup
- N workers (N/2 supporters + N/2 opponents)
- K rounds total

## Round-by-round position dynamics
- Round 1: X supporters / Y opponents / main argument clusters
- Round 2: ...
- Round K: ...

## Key arguments per cohort
### Supporters
- Argument A (frequency, quoted from alias X号)
- Argument B ...

### Opponents
- Argument C ...
- Argument D ...

## Position shifts (initial → final)
- Supporters: 25 → 22 (-3 shifted)
- Opponents: 25 → 24 (-1 shifted)

## Conclusion summary
<3-5 sentences summarizing observed phenomena>
```

## Console output cadence

```
[anet] Creating opinion-spread lab:
        Workdir:       /home/u/opinion-s
        Worker count:  50 (25 supporters + 25 opponents)
        Topic:         AI 监管 (是否应该立法限制大模型训练 / 推理用途)
        Runtime:       claude-agent-sdk + intern-s1-pro

[anet] ✓ Moderator (alias=主持人) created + ntok_ ready
[anet] ✓ Supporters 支持1号 .. 支持25号 created + ntok_ ready
[anet] ✓ Opponents 反对1号 .. 反对25号 created + ntok_ ready
[anet] ✓ Launched 51 tmux sessions

[anet] 🏁 Opinion-spread lab ready.
        Dashboard:    anet hub dashboard
        Send task:    commhub_send_task --alias 主持人 --task "Start the opinion experiment on «AI 监管»"
        Phase 1 note: Moderator LLM autonomously chooses round count + per-round prompts + termination
        Stop:         anet batch stop opinion-spread
        Cleanup:      anet batch cleanup opinion-spread --workdir /home/u/opinion-s
```

## Network isolation

`anet demo opinion-spread` reuses anet's generic network model:

- Default: if you logged in as admin (`admin/anethub`), uses the default network
- For isolation, create one first: `anet network create opinion-experiment-$(date +%s)` then `anet network switch`
- All 51 ntok_ register into the current network, independent from sci-team / pr-review

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `[anet] 需要 Intern API key` | Neither `--intern-api` nor `$INTERN_API_KEY` set | `export INTERN_API_KEY=sk-...` or pass `--intern-api` |
| `自动登录失败: invalid credentials` | Hub admin password was changed from default | `anet login` manually before running the demo |
| `worker count clamped to [10, 100]` | `--count` out of range | Pick a value in `[10, 100]`; <10 sparse dynamics, >100 resource pressure |
| Moderator stuck mid-round | LLM no autonomous fan-out, possibly echo mode | Check `anet hub dashboard` task flow; send a fallback task "continue to round N" to nudge |
| Some workers don't reply | Single-node token failed / process crashed | `tmux ls` to check all 51 sessions; if some missing, `anet batch restart opinion-spread` |
| Slow batch ntok_ creation | 51 sequential register calls + network jitter | Wait a few dozen seconds; if it stays stuck check hub health |

## Related

- Design issue: [#72](https://github.com/sleep2agi/agent-network/issues/72)
- Same preset wrapper pattern: [sci-team Phase 1](./sci-team.md)
- Generic N-node primitive: `anet create --batch` / `anet batch <verb>` (issue [#55](https://github.com/sleep2agi/agent-network/issues/55))
- Active fan-out origin: sci-team Phase 2 [9e206aa](https://github.com/sleep2agi/agent-network/commit/9e206aa)
- Prompt module unit tests: [`tests/test33-opinion-spread/`](https://github.com/sleep2agi/agent-network/tree/main/tests/test33-opinion-spread)

## Phase 1 explicitly NOT in scope

- ❌ CLI-hardcoded round scheduler (moderator LLM drives autonomously)
- ❌ Auto-computed position shift / convergence metrics (moderator LLM reports in final summary)
- ❌ Dashboard two-cohort dynamics visualization (issue [#50](https://github.com/sleep2agi/agent-network/issues/50) N站马 may add later)
- ❌ Worker cross-talk / peer review (moderator is the only fan-out origin)
- ❌ Topic moderation guard / sensitivity tier (Phase 2 candidate)
