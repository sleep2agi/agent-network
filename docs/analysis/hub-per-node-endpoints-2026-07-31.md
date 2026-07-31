# Hub per-node endpoints — enumeration for App parity row 4 V2 decision

**As of `origin/main = 71b3d896` on 2026-07-31 (Beijing).** Written to support the mobile-app "single-node detail screen" (parity checklist row 4) V2 decision. Reader from a future date: hub adds a route → this doc is stale. Re-enumerate before trusting.

## TL;DR

- Hub is a single-file `Bun.serve` dispatcher. Real source: `server/src/server.ts` (3118 L). `server/src/index.ts` is an 11-line **shim** that just calls `startHub()` — do NOT read `index.ts` as authoritative.
- **50 pathname-matched routes** in `server.ts` at this SHA. **8 of them are per-node** (path-parameterized on `node_id` / alias / session name).
- Config **read** is over REST (`GET /api/nodes/{id}/config`). Display metadata **writes** are over REST (`PUT .../attrs`, `PUT .../avatar`). Runtime-config **writes** are NOT over REST — they go through the MCP tool `update_node_config` (RFC-024 hub-config-apply pipeline).
- **App parity row 4 V2 decision = (b')**: display metadata (`display_name` / `team` / `tags` / `avatar_url`) editable in-app; runtime `model` / `flags` shown read-only (no gate button, no "not supported" text — just plain text vs input styling). Rationale in [§ V2 decision](#v2-decision).

## Enumeration scope

- **Source file**: `server/src/server.ts` at `git rev-parse origin/main:server/src/server.ts = 37971c8fbb313bfe8cdfa5d78e311e3accd516a7`.
- **Dispatcher**: `Bun.serve({ fetch(req) { ... } })` at L642+ inside `server.ts`. There is NO express-style `app.get()` / no external router file / no dynamic route-registration. Every route is a top-level branch inside the fetch handler.
- **Matcher patterns**: two forms in-source —
  - Exact string equality: `if (url.pathname === "…") { … }`
  - Regex parameterization: `const m = url.pathname.match(/^\/…\/([^/]+)\/…$/); if (m) { … }`
- **Reproduce this enumeration** — run against origin/main (not your working checkout — see [§ We got this wrong the first time](#we-got-this-wrong-the-first-time)):
  ```
  git worktree add /tmp/hub-audit origin/main
  cd /tmp/hub-audit
  grep -nE 'url\.pathname === "|url\.pathname\.match\(' server/src/server.ts | wc -l
  # → 50 as of 71b3d896
  ```

## All 50 REST routes (positive enumeration)

Grouped by broad topic. Method column shows the primary method; some routes multiplex GET/PUT via a nested `req.method === ...` branch inside the handler — those are noted `GET+PUT`.

### Meta / connectivity (4)

| # | Line | Method | Path | Notes |
|---|---|---|---|---|
| 1 | 650 | GET/POST | `/mcp` | MCP-over-HTTP entry (all MCP tools) |
| 2 | 1227 | GET | `/health` | version + subs stats (SSE per-tenant since preview.24) |
| 3 | 1358 | GET | `/api/stats/sse` | live SSE subscriber snapshot |
| 4 | 1373 | GET | `/api/status` | rollup status |

### Auth (11)

| # | Line | Method | Path |
|---|---|---|---|
| 5 | 816 | GET | `/api/license` |
| 6 | 831 | POST | `/api/license/activate` |
| 7 | 854 | POST | `/api/auth/register` |
| 8 | 869 | POST | `/api/auth/login` |
| 9 | 907 | GET | `/api/auth/me` |
| 10 | 916 | PUT | `/api/auth/me` |
| 11 | 940 | POST | `/api/auth/password` |
| 12 | 961 | POST | `/api/auth/node-token` (creates node token; body-scoped by alias) |
| 13 | 1031 | GET | `/api/auth/tokens` |
| 14 | 1040 | POST | `/api/auth/tokens` |
| 15 | 1055 | DELETE | `/api/auth/tokens/{id}` |

### Networks + members (9)

| # | Line | Method | Path |
|---|---|---|---|
| 16 | 1067 | GET | `/api/networks` |
| 17 | 1082 | POST | `/api/networks` |
| 18 | 1097 | GET+PUT+DELETE | `/api/networks/{id}/members[/{uid}]` (multiplexed) |
| 19 | 1135 | POST | `/api/networks/{id}/invite` |
| 20 | 1151 | POST | `/api/networks/join` |
| 21 | 1163 | GET | `/api/users` |
| 22 | 1174 | GET+PUT | `/api/networks/{id}` |

### Node lifecycle + rename (4)

| # | Line | Method | Path |
|---|---|---|---|
| 23 | 980 | POST | `/api/node-rename/prepare` (2PC step 1; body-scoped) |
| 24 | 998 | POST | `/api/node-rename/commit` (2PC step 2; body-scoped) |
| 25 | 1014 | POST | `/api/node-rename/abort` (2PC rollback; body-scoped) |
| 26 | 2399 | DELETE | `/api/nodes/{id}` |

### Servers (2)

| # | Line | Method | Path |
|---|---|---|---|
| 27 | 1443 | GET | `/api/servers` |
| 28 | 1515 | GET | `/api/server/{host}/(health\|agents)` (per-host, NOT per-node) |
| 29 | 2647 | GET | `/api/host-supervisors` |

### **Per-node config + display** (see [§ Per-node routes](#per-node-routes) below)

| # | Line | Method | Path |
|---|---|---|---|
| 30 | 2449 | GET | `/api/nodes/{id}/config` |
| 31 | 2503 | PUT | `/api/nodes/{id}/attrs` |
| 32 | 2598 | PUT | `/api/nodes/{id}/avatar` |
| 33 | 2765 | GET | `/api/nodes` (list; supports `?node_id=` `?alias=` filters) |

### Uploads / files (2)

| # | Line | Method | Path |
|---|---|---|---|
| 34 | 1641 | POST | `/api/upload` |
| 35 | 1921 | GET+HEAD | `/api/files/{path}` |

### Tasks + messaging (7)

| # | Line | Method | Path |
|---|---|---|---|
| 36 | 2048 | POST | `/api/task` |
| 37 | 2196 | POST | `/api/broadcast` |
| 38 | 2295 | GET | `/api/messages` |
| 39 | 2308 | GET | `/api/stats` |
| 40 | 2385 | GET | `/api/task_events` |
| 41 | 2822 | GET | `/api/tasks?/{id}` (single task lookup; `tasks?` = both `/task/{id}` and `/tasks/{id}`) |
| 42 | 2837 | GET | `/api/tasks` (list) |

### Diagnostics (3)

| # | Line | Method | Path |
|---|---|---|---|
| 43 | 2348 | GET | `/api/server-logs` |
| 44 | 2364 | GET | `/api/audit-log` |
| 45 | 2873 | GET | `/api/completions` |

### Tmux + WS + SSE (5)

| # | Line | Method | Path |
|---|---|---|---|
| 46 | 642 | WS upgrade | `/ws/tmux/{name}` — per-node tmux WebSocket attach |
| 47 | 702 | GET (SSE) | `/events/network/{netId}` — per-network event stream |
| 48 | 723 | GET (SSE) | `/events/{sessionName}` — per-session event stream |
| 49 | 2243 | GET | `/api/tmux/{name}` — capture pane snapshot |
| 50 | 2267 | POST | `/api/tmux/{name}/send` — send keys to tmux |

## Per-node routes

Filtered from the 50: **8 REST routes** whose target is a single node (parameterized on `node_id` / alias / session name in the path), plus **3 body-scoped** where the path is fixed but the alias sits in the POST body, plus **1 MCP tool** for authoritative runtime-config writes.

### Path-parameterized (5)

| Line | Method | Path | Purpose |
|---|---|---|---|
| 642 | WS | `/ws/tmux/{name}` | Human tmux terminal attach |
| 723 | GET SSE | `/events/{sessionName}` | Per-session push stream (candidate log source for parity row 6) |
| 2243 | GET | `/api/tmux/{name}` | tmux screen snapshot (pull, complement to SSE push) |
| 2267 | POST | `/api/tmux/{name}/send` | Send keystrokes to a node's tmux |
| 2399 | DELETE | `/api/nodes/{id}` | Delete node |
| 2449 | GET | `/api/nodes/{id}/config` | **V2 read source** — returns `{ok, node_id, alias, network_id, config_revision, model, flags, config_update_capable}` |
| 2503 | PUT | `/api/nodes/{id}/attrs` | **V2 write — display metadata**: `display_name` / `team` / `tags`. Optimistic lock via `attrs_revision`, 409 on stale base. |
| 2598 | PUT | `/api/nodes/{id}/avatar` | **V2 write — avatar_url**. Validation: http/https only, ≤2048 chars, no control chars (`avatar-validate.ts`) |

### Body-scoped per-node (3)

| Line | Method | Path | Alias location |
|---|---|---|---|
| 961 | POST | `/api/auth/node-token` | request body |
| 980 | POST | `/api/node-rename/prepare` | request body |
| 998 | POST | `/api/node-rename/commit` | request body |
| 1014 | POST | `/api/node-rename/abort` | request body |

### MCP tool (1) — the authoritative runtime-config write path

| Registered at | Tool | Notes |
|---|---|---|
| `server/src/tools.ts:1691` | `update_node_config` | Writes `patch_json` into `node_config_updates` table (RFC-024 apply pipeline). Agent-node polls, applies, PUTs back an ack that bumps `config_revision`. Not a REST endpoint — reachable only over `/mcp`. |

Sibling MCP tools mentioned in `server.ts:2041-2072` (didn't fully audit): `restart_node`, and F-B reaper for stale pending updates.

### Not per-node — commonly confused

- `/api/server/{host}/(health|agents)` (L1515) — parameter is a `host_supervisor` **host name**, not a node alias. One host has N nodes. Excluded.
- `/api/nodes` (L2765) — list all nodes, supports `?node_id=` `?alias=` filters but returns an array. Useful as fallback ("get one node by alias") only because `GET /api/nodes/{id}` doesn't exist and `GET /api/nodes/{id}/config` returns only the config projection, not the full row.

## V2 decision

**Chosen: (b') — display metadata editable, runtime config read-only.**

### What lands in the app's single-node detail screen (parity row 4 V2)

| Field | Source | UI treatment |
|---|---|---|
| alias | V1 already (from `Session`) | plain text, top of card |
| status / updated_at / current task | V1 already | plain text, health block |
| `display_name` | `GET /api/nodes/{id}/config` → returns via `nodes` row | **editable input** — `PUT /api/nodes/{id}/attrs` |
| `team` | same | **editable input** — same PUT |
| `tags` | same | **editable input** — same PUT |
| `avatar_url` | `GET /api/nodes/{id}/config` → hub row | **editable** — `PUT /api/nodes/{id}/avatar` (URL text input, validation client + server) |
| `model` | `GET /api/nodes/{id}/config` → `snapshot.model` | plain text (read-only) |
| `flags` | `GET /api/nodes/{id}/config` → `snapshot.flags` | plain text list (read-only) |
| `config_update_capable` | same | not shown directly; used to gate any future edit UI when write path lands |

**No "edit" button that greys out.** No "not supported" placeholder text. Read-only fields are just plain text; editable fields have input-style borders. The user reads the shape and knows.

### 409 conflict on attrs writes

`PUT /api/nodes/{id}/attrs` requires `base_attrs_revision`. If another editor changed the row between the GET and the PUT, the hub returns 409 with the current row. App must:
- NOT silently drop the change.
- NOT force-overwrite.
- Show "有人先改了，刷新后重试" (or equivalent), refresh the row, let the user re-apply.

Same contract mirror as `update_node_config` (see comment at `server.ts:2496`).

### Not in scope of V2

- Editing `model` / `flags` — requires MCP `update_node_config` from the app, which needs an MCP client or a REST wrapper endpoint. Separate work item, hub-authz-affecting, not P1 for parity row 4.
- Editing `alias` / `node_name` — must go through the 2PC rename chain at `/api/node-rename/*` (L980-1014) to cascade sessions + api_tokens + SSE cleanup. Design was surfaced in #146; a single-table UPDATE would strand the node.
- Log stream (parity row 6) — separate PR, but the backend is already there: `GET /events/{sessionName}` (per-session push) or `GET /events/network/{netId}` (per-network push). No hub work needed for row 6's read path.

## We got this wrong the first time

This section is intentionally in the doc, not just in commit history. **The reader who's about to enumerate hub routes for a different reason needs this warning more than they need the correct table above.**

### Failure 1 — author enumerated the wrong file

**Symptom**: reported 44 total routes, no `/api/nodes/{id}/config`, no `PUT .../attrs`, no `PUT .../avatar`. Concluded "V2 has no write API".

**Root cause**: the enumeration ran against `server/src/index.ts` on branch `phase0/grok-agent-leader-wire` (a 2040-line flat implementation from before a refactor). On `origin/main`:
- `server/src/index.ts` = **11-line shim** (`startHub()` only)
- Real source = `server/src/server.ts` (**3118 lines**)
- The 6-route diff between the two versions contained **4 of the 5 per-node routes that the V2 decision hinged on**.

The reported "no write API" was a true statement about the wrong file, not a true statement about main.

**Fix**: for any enumeration whose reader treats it as a claim about the current state of main, `git fetch origin main` and enumerate from `origin/main` (via a fresh worktree if the working checkout is on another branch). Pin the SHA and file blob-SHA in the report.

### Failure 2 — lead reviewer used a name-shaped grep

**Symptom**: reviewing the author's original report, the lead ran `grep -E 'api/nodes/.*attrs'` against `server.ts` — got 0 hits — nearly re-confirmed the author's "no PUT" claim.

**Root cause**: in the source, the routes are declared as regex literals: `url.pathname.match(/^\/api\/nodes\/([^/]+)\/attrs$/)`. The slashes are escaped (`\/`), so the literal string `api/nodes/` does NOT appear consecutively in the source. `grep 'api/nodes'` misses the escape-form.

**Fix**: to prove "route X does not exist", enumerate all `url.pathname === ...` and `url.pathname.match(...)` lines and read them — do not grep for the route's substring shape. `grep -E 'pathname[^)]*nodes'` catches escaped-slash forms; `grep 'api/nodes'` doesn't.

### Common shape of both failures

Both showed as **0 hits**. Both were on-track to be read as **"does not exist"**. Neither reflected reality.

The general form (already recorded in-team as "grep proves presence, not absence"; see `feedback_grep_scope_must_be_in_the_sentence.md` and `feedback_enumerate_against_origin_main_not_working_checkout.md`) is: **when your query returns 0 and you want to conclude "X does not exist", you have to prove your query *would have found* X if it existed** — either by running it against a known-positive fixture, or by switching to positive enumeration.

## Time-validity

- SHA pinned: `origin/main = 71b3d896` at write time (2026-07-31, Beijing).
- File blob pinned: `server/src/server.ts = 37971c8f…`.
- **Reader in the future**: run the "Reproduce this enumeration" command above. If `wc -l` returns a number other than 50, this doc is out of date on route count. If the file blob-SHA has changed, individual line numbers in the tables above are stale even if the count matches. Re-classify against the current source before relying on any specific line.

## Related

- Parity checklist row 4 (`docs/app-vs-web-parity-checklist.md`) — V1 (health card) shipped as app PR #17 / `9e8f819`.
- `docs/rfcs/RFC-024*` — the runtime-config apply pipeline that `update_node_config` participates in.
- Cross-team feedback:
  - `feedback_enumerate_against_origin_main_not_working_checkout` (post-mortem of Failure 1)
  - `feedback_grep_scope_must_be_in_the_sentence` (general form both failures fit)
