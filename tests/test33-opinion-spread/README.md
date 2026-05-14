# test33-opinion-spread (unit tests, Phase 1)

Pure structural / lookup unit tests for `opinionSpreadPrompt()` + `OPINION_TOPICS`
(`agent-network/bin/demos/opinion-spread-prompts.ts`, issue #72 Phase 1).

## Scope

| | |
|---|---|
| **In scope** | Prompt-template structural assertions, topic preset shape, cohort split math, anti-echo guards, cohort-symmetry safety |
| **Out of scope** | Live `anet demo opinion-spread` e2e (gated on 通信工程马 cli wire + cohort BatchOptions extension, then 通信测试马 will add a separate `testNN-opinion-spread-e2e/`) |
| **No infra needed** | Pure TypeScript, no LLM, no hub, no Docker network — just `bun:test` on the file pair |

## How to run

### Local (fastest)

```bash
cd agent-network
bun test bin/demos/opinion-spread-prompts.test.ts
```

### Docker (sandbox parity with qa-ut-02 pattern)

```bash
cd tests/test33-opinion-spread
docker build -t anet-test33 -f Dockerfile ../..   # build context = repo root
docker run --rm anet-test33
```

## What this protects against

- `OPINION_TOPICS` preset accidentally losing the `custom` trailing entry (CLI wizard relies on it for free-text input)
- `opinionSpreadPrompt()` worker branch silently producing the wrong stance string (e.g. 支持 cohort being labeled 反对 from a regression) — symmetry tests fail loud
- Cohort split math drift on odd-worker totals (5/10/20 vs 11/21 etc.) — split-math tests pin the formula
- LLM laziness regressions to "echo 占位" mode (sci-team Phase 2 had this bug, fixed in [9e206aa](https://github.com/sleep2agi/agent-network/commit/9e206aa)) — anti-echo guards assert "**不是** echo 占位" remains in both leader + worker prompts

## Follow-up (post cli wire)

Once 通信工程马's `demoOpinionSpreadCommand` + `BatchOptions.cohorts?` extension lands:

- Add `tests/testNN-opinion-spread-e2e/` (跟 test28-demo-debate-v2.1.2 同款 e2e shape): install published preview, start isolated hub, run `anet demo opinion-spread --count 6 --topic "AI 监管" --intern-api $TEST_KEY`, verify 6 nodes register + 1 主持人 + 2 支持 + 3 反对 (or 3+2 with odd absorption), verify lifecycle `anet batch stop opinion-spread`.
- 通信测试马 surface — not this PR.

Related: issue [#72](https://github.com/sleep2agi/agent-network/issues/72)
