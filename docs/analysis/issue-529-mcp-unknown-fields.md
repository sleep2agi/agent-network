# Issue #529 — MCP unknown-field policy audit

Date: 2026-08-09

## Outcome

Do **not** apply `.strict()` across all MCP tools. The safe next step is an
observe-then-tighten rollout:

1. wrap one canary tool with a top-level passthrough schema;
2. log only sorted unknown **key names**, then strip again before its handler;
3. measure real callers before choosing strict mode per tool;
4. require persisted side-effect tools to echo what was actually stored.

This audit changes no production tool behavior. `test629` is an executable
feasibility probe for the proposed wrapper and a source inventory gate.

## Facts

- `server/src/tools.ts` contains **41** `server.tool(...)` registrations.
- Every top-level registration uses the deprecated raw-shape form. None has an
  explicit top-level unknown-field policy.
- The installed real `@modelcontextprotocol/sdk` converts a raw shape to a Zod
  object and parses before calling the handler. Its default object policy strips
  unknown keys. `test629` proves `{known, typo}` reaches the handler as
  `{known}` while the call still succeeds.
- The current audit log cannot answer which callers send unknown fields: the
  only copy is discarded before project code runs. Historical caller breakage
  therefore cannot be measured retrospectively.
- Nested high-risk payloads are a separate boundary. For example provider probe
  result objects already use nested `.strict()` schemas; this proposal must not
  loosen them.

## Inventory and caller surface

| Group | Tools | Known first-party callers | Strict-mode risk |
|---|---|---|---|
| SkillHub | `submit_skill`, `list_skills`, `get_skill`, `review_skill` | Dashboard server proxy and MCP clients | Medium; public/private clients can drift independently |
| Agent lifecycle | `report_status`, `report_completion`, `get_inbox`, `ack_inbox`, `get_all_status`, `get_session_status` | `agent-network`, `agent-node`, test/legacy packages | High; old long-running binaries are present in production |
| Messaging/task | `send_task`, `send_message`, `send_reply`, `send_ack`, `retry_task`, `get_task`, `list_tasks`, `cancel_task`, `reassign_task`, `broadcast`, `get_completions` | LLM MCP calls, node bridges, SDK client, Dashboard flows | Highest; LLM-generated arguments and third-party clients are open-ended |
| Node config | `update_node_config`, `get_config_update`, `ack_config_update`, `restart_node`, `list_host_supervisors` | Dashboard/Hub and agent-node | Medium; version skew is known |
| Daemon create/stop | `create_node`, `get_create_request`, `ack_create_request`, `stop_node`, `delete_node`, `get_stop_request`, `ack_stop_request`, `list_my_children` | agent-node daemon and Hub | High; cross-version orchestration must keep working |
| Secrets/providers | `upsert_network_secret`, `list_network_secrets`, `upsert_provider`, `list_providers`, `probe_provider_model`, `get_probe_results`, `get_probe_request` | Dashboard/Hub and probe daemon | High; never log values, and retain nested strict schemas |

Static source calls cover only first-party code. They cannot prove that an LLM,
an older installed package, or a third-party MCP client sends no extra fields.
That unbounded caller set is the reason a global strict migration is unsafe.

## Option assessment

### A. Lint requiring `.strict()` or `.passthrough()`

Useful only after registrations have an explicit policy wrapper. Enabling such a
lint today would fail all 41 tools without telling us which callers would break.
Keep the exact inventory gate now; later replace each manifest entry with an
explicit `observe`, `strict`, or documented legacy policy.

### B. Passthrough plus shape telemetry — recommended

Use `registerTool` with a top-level `z.object(shape).passthrough()` so project
code can see unknown key names. The wrapper must then parse the same value with
`z.object(shape).strip()` before invoking the existing handler. This preserves
the current handler contract.

Telemetry requirements:

- key names only; never values;
- tool name, authenticated caller class, package/version when already known;
- sorted/deduplicated keys with length/count caps;
- rate-limited logs plus aggregate counters;
- no relaxation of nested `.strict()` schemas.

Start with `send_reply`: it produced the original symptom, now echoes persisted
attachments, and has direct regression coverage. Canary telemetry is a separate
runtime PR and deployment decision.

### C. Echo persisted fields — required complement

Echoes let a well-behaved caller compare intent with stored state, and #507 has
already used this pattern. Echoes do not protect a caller that ignores the
response and cannot identify arbitrary future typo fields, so they complement
rather than replace telemetry.

### D. Per-tool strict canary

Only consider strict mode after a named tool has a representative observation
window with zero unexplained unknown keys. Test both failure directions:

- removing strict mode must admit the targeted typo;
- enabling strict mode must not break the recorded legacy/forward-compatible
  caller corpus.

## Implementation doors

1. **Telemetry PR:** one `send_reply` wrapper, real MCP wire test, value-leak
   negative test, rate-limit test, and handler byte-equivalence test.
2. **Observation window:** record counts by tool/caller class; resolve each key
   as typo, legacy, or forward-compatible extension.
3. **Policy PR:** choose strict/strip/observe per tool. Never sweep strict across
   the class.

The issue's evaluation scope is complete when this audit and probe are reviewed.
Production telemetry and any strict migration remain separately reviewable
follow-ups.
