# Grok Build Runtime Evaluation

Date: 2026-05-18
Owner: 通信牛
Issue: https://github.com/sleep2agi/agent-network/issues/164

## Verdict

Recommendation: **Wait, then prototype `grok-build-acp` first**.

Grok Build is promising as a third runtime lane for Agent Network, but it is still an early beta and currently gated behind SuperGrok Heavy. The strongest integration path is not a raw xAI model API wrapper. It is either:

1. `grok-build-cli`: spawn `grok -p ... --output-format streaming-json`, similar to `claude-code-cli`.
2. `grok-build-acp`: spawn `grok agent stdio` and speak ACP JSON-RPC, which is cleaner for long-running agent-node integration.

The main advantage is not just model quality. The concrete value for Agent Network is **runtime redundancy**: Claude Code, Codex, and Grok Build can become three independent coding-agent execution lanes, reducing quota/vendor outages and giving different nodes different strengths.

## Confirmed Facts

Sources checked on 2026-05-18:

- xAI Grok Build docs: https://docs.x.ai/build/overview
- xAI Grok Build launch post: https://x.ai/news/grok-build-cli
- xAI headless and ACP docs: https://docs.x.ai/build/cli/headless-scripting
- xAI modes and commands: https://docs.x.ai/build/modes-and-commands
- xAI skills/plugins docs: https://docs.x.ai/build/features/skills-plugins-marketplaces
- xAI remote MCP tools: https://docs.x.ai/developers/tools/remote-mcp
- xAI pricing: https://docs.x.ai/developers/pricing
- xAI streaming docs: https://docs.x.ai/developers/model-capabilities/text/streaming

Confirmed from official docs:

- Grok Build is an official xAI coding-agent CLI, launched as early beta on 2026-05-14.
- It is initially available to SuperGrok Heavy subscribers.
- It supports interactive TUI usage through `grok`.
- It supports API-key auth for non-browser environments via `GROK_CODE_XAI_API_KEY`.
- It supports headless execution with `grok -p`.
- It supports `--output-format plain|json|streaming-json`.
- It supports session control flags: `--session-id`, `--resume`, and `--continue`.
- It supports `--cwd`, model selection, and auto-approval mode.
- It exposes an ACP stdio mode: `grok agent stdio`.
- It supports skills, plugins, hooks, MCP servers, and subagents.
- It reads Claude Code configuration/instructions and AGENTS.md-style files.
- xAI API supports streaming, function/tool calling, server-side tools, remote MCP tools, and OpenAI-compatible API usage.

Not confirmed yet:

- Whether Grok Build CLI is stable enough across versions for production automation.
- Whether `streaming-json` schema is documented and stable.
- Whether ACP event schema is stable enough for Agent Network progress mapping.
- Whether SuperGrok Heavy subscription auth is acceptable for headless server nodes.
- Whether Grok Build can run cleanly in Docker without browser login when only API key is present.
- Whether it can expose exact token/cost usage in headless/ACP output in a way anet can persist.

## Capability Matrix

| Capability | Grok Build status | Agent Network impact |
|---|---:|---|
| Official coding-agent CLI | Confirmed | Makes `grok-build-cli` feasible |
| Headless mode | Confirmed | Required for agent-node runtime |
| JSON final output | Confirmed | Enough for minimal reply loop |
| Streaming JSON | Confirmed | Enables progress mapping if schema is stable |
| Session id / resume | Confirmed | Required for long-running node continuity |
| ACP stdio | Confirmed | Best fit for structured long-running runtime adapter |
| MCP support | Confirmed | Could reuse anet MCP/tool surface if transport/auth fit |
| Plugins/skills/hooks | Confirmed | Good match for repo-specific behavior |
| Claude Code compatibility | Confirmed | Migration path from existing Claude Code node configs may be easier |
| API key auth | Confirmed | Needed for Docker/server deployment |
| Docker/CI operation | Not confirmed | Must be probed before implementation |
| Stable event schema | Not confirmed | Main blocker for dashboard-quality progress |
| Cost/quota reporting | Partly confirmed at API level | Need CLI/ACP-level probe |

## Runtime Options

### Option A: `grok-build-cli`

Implementation shape:

- Add `grok-build-cli` to `RuntimeName`.
- `agent-node` spawns:
  - `grok -p <task> --cwd <workdir> --session-id <id> --output-format streaming-json`
  - or `grok -p <task> --resume <id> --output-format streaming-json`.
- Map JSON stream events to existing `NodeEvent`/progress kinds.
- Store session id in node config.

Advantages:

- Smallest implementation.
- Similar to existing `claude-code-cli` supervision pattern.
- Good enough for first prototype.

Risks:

- CLI output schema may not be stable.
- Process-per-turn overhead.
- Harder to support mid-turn control beyond what CLI exposes.
- Auto-approve mode must be carefully gated; default should not be unsafe.

Estimated LOC:

- `agent-network/bin/cli.ts`: 30-60 LOC.
- `agent-node/src/runtime/grok-build-cli.ts`: 200-350 LOC.
- Tests/docs: 150-250 LOC.

### Option B: `grok-build-acp`

Implementation shape:

- Add `grok-build-acp` runtime.
- `agent-node` spawns `grok agent stdio`.
- Use JSON-RPC methods:
  - `initialize`
  - `authenticate`
  - `session/new`
  - `session/prompt`
  - listen for `session/update`.
- Map ACP session updates to Agent Network progress events.

Advantages:

- More structured than parsing CLI output.
- Better fit for long-lived node process.
- Closer to an IDE/orchestrator integration path.
- Session state and update stream are more explicit.

Risks:

- ACP schema compatibility needs a spike.
- Need timeout, child watchdog, restart/resume logic.
- Needs careful stderr/stdout isolation.

Estimated LOC:

- `agent-node/src/runtime/grok-build-acp.ts`: 350-550 LOC.
- shared process supervision/event mapper: 100-200 LOC if reusable.
- tests/docs: 200-350 LOC.

### Option C: `grok-sdk`

Implementation shape:

- Use xAI API / SDK directly.
- Expose anet tools through function calling or remote MCP.
- Build our own file/shell/tool loop.

Advantages:

- More control over tool policy and cost tracking.
- Could avoid needing Grok Build CLI availability.
- Works with normal xAI API billing if model/tool access is enough.

Risks:

- Re-implementing coding-agent behavior is larger scope.
- We need to provide file edit, shell, diff, and approval semantics ourselves.
- Less likely to match Grok Build's native coding-agent behavior.

Recommendation:

- Do not start here unless Grok Build CLI/ACP fails capability probes.

### Option D: `xai-model-provider` only

Implementation shape:

- Add Grok models as a vendor preset for existing SDK-style runtime where possible.

Advantages:

- Fastest path for model diversity.
- Useful for non-coding chat/review tasks.

Risks:

- It is not a true coding-agent runtime.
- It does not solve autonomous file/shell workflows unless wrapped by an existing agent engine.

Recommendation:

- Treat as separate model-provider work, not the main Grok Build runtime.

## Comparison With Existing Runtimes

| Runtime | Strength | Weakness | Grok relevance |
|---|---|---|---|
| `claude-code-cli` | Mature coding CLI, good repo edits, session resume | Vendor quota pressure, CLI integration fragility | Grok Build is closest equivalent |
| `claude-agent-sdk` | Programmatic SDK, structured control | Tool behavior and permissions vary by SDK | Grok SDK path would be analogous but bigger |
| `codex-sdk` | Good fallback, strong code review/coding lane | Runtime path still maturing in anet | Grok can become third fallback lane |
| `codex-cli-mcp` / stdio-style | Structured subprocess protocol | Event mapping and watchdog complexity | Grok ACP stdio is similar and likely best |
| `grok-build-cli` | Native xAI coding CLI, Claude/AGENTS compatibility, subagents | Early beta, SuperGrok Heavy gate, unknown schema stability | Good prototype target |
| `grok-build-acp` | Structured stdio integration | Requires ACP spike and robust supervision | Best long-term target if stable |

## Expected Advantages for Agent Network

1. **Quota redundancy**
   - Current operational pain: Claude Code nodes can run out of quota; Codex nodes can carry work, but adding Grok gives a third independent provider lane.
   - Grok should be treated as fallback-capable only after headless Docker and session-resume probes pass.

2. **Runtime diversity**
   - Different agent roles can use different runtimes:
     - Claude Code: primary mature coding worker.
     - Codex: review, code reasoning, targeted implementation, fallback coding.
     - Grok Build: exploratory coding, large-context analysis, X/web-connected tasks, alternate coding worker.

3. **Configuration compatibility**
   - Grok's documented Claude Code and AGENTS.md compatibility reduces migration friction for existing repos.
   - It may read existing project instructions without needing duplicate `.grok` setup.

4. **Structured orchestration path**
   - ACP stdio gives a clearer adapter boundary than screen-scraping a TUI.
   - This aligns with anet's direction of process-supervised runtime adapters.

5. **MCP/tool ecosystem**
   - Grok's MCP support means anet can potentially expose CommHub tools directly or reuse existing MCP servers.
   - Remote MCP support also creates a route for hosted tools, but auth/network isolation must be tested.

6. **Parallel subagents**
   - Grok Build advertises subagents and worktree integration.
   - This may overlap with anet batch/team primitives. The integration should not blindly nest unbounded subagents under anet batch; concurrency limits are required.

## Main Risks

### R1: Early beta product risk

Grok Build launched as early beta. CLI flags and event schema may change. Runtime implementation should be experimental and version-gated.

Mitigation:

- Add runtime behind explicit `--runtime grok-build-acp` / `grok-build-cli`.
- Do not make it default.
- Add `grok --version` capture into node status.
- Gate tests by exact CLI version.

### R2: Subscription/auth risk

The launch post says Grok Build is first available to SuperGrok Heavy subscribers. API key mode exists, but we need to prove API-key-only auth works in Docker/headless mode.

Mitigation:

- Phase 0 Docker probe with only `GROK_CODE_XAI_API_KEY`.
- No browser login, no user cookie, no local account dependency.

### R3: Tool safety risk

Grok supports auto-approval and tool execution. In anet, unattended nodes must not default to unsafe permissions.

Mitigation:

- Default to ask/limited mode where possible.
- For headless, define an explicit safe policy:
  - no production host paths,
  - no inherited secrets except allowlisted env,
  - Docker test sandbox only,
  - no `--always-approve` by default until safe behavior is proven.

### R4: Event mapping risk

`streaming-json` and ACP `session/update` need schema probes. We should not assume they map cleanly to RFC-003 progress kinds.

Mitigation:

- Phase 0 capture fixtures for:
  - final answer only,
  - file edit,
  - shell command,
  - tool error,
  - resume.
- Check fixtures into `docs/tests/grok-runtime-fixtures/` if license permits.

### R5: Nested agent concurrency risk

Grok subagents plus anet batch/team can multiply concurrency unexpectedly.

Mitigation:

- Runtime config should include `maxSubagents` or disable Grok subagents in Phase 1 if possible.
- Dashboard should show a child-process count if available.

### R6: Secret exposure risk

Coding agents inspect repo files and run tools. Grok Build compatibility with Claude Code/AGENTS config may also load local hooks/plugins.

Mitigation:

- Phase 1 runtime must not load untrusted project hooks by default unless user opts in.
- Document that `.grok`, `.claude`, and `AGENTS.md` can influence behavior.
- Docker E2E must verify no secret-like env values are printed into logs/config.

## Integration Recommendation

### Phase 0: Capability probe, no anet code

Goal: prove Grok Build can be a headless, Docker-safe coding runtime.

Required probes:

1. Install:
   - `curl -fsSL https://x.ai/cli/install.sh | bash`
   - record `grok --version`.
2. Auth:
   - `GROK_CODE_XAI_API_KEY=xai-... grok -p "Say ok" --output-format json`.
   - run in Docker without browser/cached login.
3. Streaming:
   - `grok -p "Explain this temp repo" --output-format streaming-json`.
   - save event schema.
4. Resume:
   - `grok -p "Remember token abc" --session-id anet-probe`.
   - `grok -p "What token did I give you?" --resume anet-probe`.
5. File edit:
   - temp git repo, ask it to edit one file, inspect diff.
6. ACP:
   - spawn `grok agent stdio`.
   - run `initialize`, `authenticate`, `session/new`, `session/prompt`.
   - capture `session/update` events.
7. MCP:
   - provide a minimal local MCP server or no-op tool.
   - verify whether Grok can call it headlessly.
8. Safety:
   - verify default permission behavior in headless mode.
   - verify whether `--always-approve` is required for file writes.

Exit criteria:

- If Docker API-key-only auth fails: **No-go** for runtime; keep as manual CLI only.
- If ACP works: implement `grok-build-acp`.
- If ACP fails but `streaming-json` works: implement `grok-build-cli`.
- If both fail: wait.

### Phase 1: Experimental runtime

Scope:

- Runtime names:
  - `grok-build-acp` preferred.
  - `grok-build-cli` fallback.
- CLI:
  - `anet node create ... --runtime grok-build-acp`.
  - env key: `GROK_CODE_XAI_API_KEY`.
  - config fields: `model`, `session`, `flags`, `permissionMode`.
- agent-node:
  - spawn child process.
  - authenticate.
  - poll inbox.
  - submit task.
  - stream progress.
  - send final reply.
  - report status including runtime version.
- Tests:
  - Docker-only capability test.
  - No production hub.
  - Skip if `GROK_CODE_XAI_API_KEY` is absent.

Non-goals:

- No dashboard-specific Grok UI.
- No automatic runtime fallback scheduler yet.
- No nested Grok subagent visualization.
- No cost optimizer.

### Phase 2: Runtime fallback policy

Only after Claude/Codex/Grok each have green Docker smoke:

- Add runtime fallback policy:
  - preferred runtime,
  - fallback runtime list,
  - quota/error classification,
  - cooldown window,
  - task retry semantics.
- Example:
  - `claude-code-cli -> codex-sdk -> grok-build-acp`.
  - `codex-sdk -> grok-build-acp -> claude-code-cli`.

This should be separate from Grok runtime implementation; otherwise scope will sprawl.

## Minimal Test Matrix

| Test | Required? | Notes |
|---|---:|---|
| Install in Docker | Yes | No global local package edits |
| API-key-only auth | Yes | No browser/cookie dependency |
| `grok -p` final answer | Yes | Basic headless path |
| `streaming-json` event fixture | Yes | Required for progress |
| `--session-id` + `--resume` | Yes | Required for long-running nodes |
| ACP stdio initialize/auth/session | Yes | Determines preferred implementation |
| File edit in temp repo | Yes | Confirms coding-agent behavior |
| MCP no-op tool call | Should | Determines CommHub tool path |
| Permission mode safety | Yes | Avoid unsafe unattended default |
| Token/cost usage exposure | Should | Needed for Dashboard usage UI |
| Multi-turn task with CommHub | Phase 1 | End-to-end anet runtime |

## Open Questions

1. Is `grok agent stdio` ACP stable and versioned?
2. Does ACP expose tool start/end events, file edits, shell commands, errors, and token usage?
3. Does `streaming-json` include enough event types to map to current progress kinds?
4. Can `GROK_CODE_XAI_API_KEY` fully replace browser login for all headless operations?
5. What are the exact SuperGrok Heavy vs API billing boundaries for Grok Build?
6. Can subagents be disabled or capped from CLI/config?
7. Does Grok Build load project hooks by default in headless mode?
8. Does it support network-proxy/offline-restricted Docker environments?
9. What is the CLI upgrade channel and can we pin a version?
10. Does the xAI ToS permit unattended coding-agent use through Agent Network?

## Proposed Issue Follow-ups

1. Create `RFC-016-grok-build-runtime.md` only after Phase 0 probes pass.
2. Create `tests/test-grok-build-capability/` Docker probe.
3. Add runtime fallback design to the long-term Codex/Claude/Grok redundancy roadmap.

## Bottom Line

Grok Build is worth tracking and likely worth prototyping, but not yet worth direct production implementation without a capability probe. The likely best design is:

```text
Phase 0: Docker capability probe
Phase 1: experimental grok-build-acp runtime
Phase 1 fallback: grok-build-cli if ACP is insufficient
Phase 2: runtime fallback policy across Claude / Codex / Grok
```

The strongest near-term value is **operational backup**: when Claude Code is out of quota and Codex capacity is constrained, Grok can become another coding-agent lane. The biggest blocker is **headless/server reliability**, not model capability.
