# Code Review

Reviewed files:
- [server/src/auth.ts](/home/vansin/agent-orchestra/server/src/auth.ts:1)
- [server/src/index.ts](/home/vansin/agent-orchestra/server/src/index.ts:1)
- [server/src/db.ts](/home/vansin/agent-orchestra/server/src/db.ts:1)

## Findings

### 1. High: authenticated users can write into arbitrary networks through MCP `send_task`

`/mcp` only force-binds `network_id` when the bearer token itself is network-scoped. User login tokens (`utok_`) carry `network_id = null`, so `registerTools()` falls back to the client-supplied `network_id` with no membership or role validation. `send_task` then inserts directly into `inbox` and `tasks` for that arbitrary network.

References:
- [server/src/index.ts:159](/home/vansin/agent-orchestra/server/src/index.ts:159)
- [server/src/index.ts:165](/home/vansin/agent-orchestra/server/src/index.ts:165)
- [server/src/tools.ts:10](/home/vansin/agent-orchestra/server/src/tools.ts:10)
- [server/src/tools.ts:325](/home/vansin/agent-orchestra/server/src/tools.ts:325)
- [server/src/auth.ts:136](/home/vansin/agent-orchestra/server/src/auth.ts:136)

Impact:
- `viewer` can still dispatch work.
- any logged-in user can impersonate cross-network activity by supplying another `network_id`.
- this bypasses the REST member-role checks entirely.

### 2. High: several REST read APIs leak cross-network data

After the generic auth gate, multiple read endpoints either ignore network membership entirely or trust a raw `network_id` query parameter without checking that the caller belongs to that network.

References:
- `/api/messages` returns global inbox rows with no network filter: [server/src/index.ts:667](/home/vansin/agent-orchestra/server/src/index.ts:667)
- `/api/completions` returns global completions with no network filter: [server/src/index.ts:781](/home/vansin/agent-orchestra/server/src/index.ts:781)
- `/api/task_events` returns global task events with no membership check: [server/src/index.ts:727](/home/vansin/agent-orchestra/server/src/index.ts:727)
- `/api/nodes` trusts raw `network_id` query param and does not use `restNetId`: [server/src/index.ts:741](/home/vansin/agent-orchestra/server/src/index.ts:741)
- `/api/stats` also trusts raw `network_id` and is not scoped by caller membership: [server/src/index.ts:677](/home/vansin/agent-orchestra/server/src/index.ts:677)
- `restNetId` is computed but not used consistently: [server/src/index.ts:540](/home/vansin/agent-orchestra/server/src/index.ts:540)

Impact:
- authenticated users can enumerate another network's stats and node metadata.
- system-wide activity feeds are visible outside the caller's network.

### 3. High: `/api/task` bypasses network isolation and role enforcement

The REST `POST /api/task` endpoint writes directly to `inbox` and does not:
- stamp `network_id`
- validate that the caller is a member of the target network
- block viewer-role callers

References:
- [server/src/index.ts:559](/home/vansin/agent-orchestra/server/src/index.ts:559)
- [server/src/db.ts:26](/home/vansin/agent-orchestra/server/src/db.ts:26)

Impact:
- any authenticated caller can send work to any alias regardless of role.
- tasks created through this path are not properly isolated by network.

### 4. High: quotas are modeled in schema but not enforced anywhere

`licenses.max_agents`, `max_networks`, and `max_tasks_day` exist in schema and are returned by `/api/license`, but the write paths never enforce them. `send_task` only checks expiry, not daily quota. `createNetwork` ignores `max_networks`. No agent/session creation path checks `max_agents`.

References:
- schema: [server/src/db.ts:216](/home/vansin/agent-orchestra/server/src/db.ts:216)
- license response: [server/src/index.ts:189](/home/vansin/agent-orchestra/server/src/index.ts:189)
- network creation: [server/src/auth.ts:161](/home/vansin/agent-orchestra/server/src/auth.ts:161)
- MCP task dispatch: [server/src/tools.ts:325](/home/vansin/agent-orchestra/server/src/tools.ts:325)

Impact:
- the product advertises limits that are not actually enforced.
- tests for network/task quotas should currently fail.

### 5. High: password hashing is too weak for production

Passwords are hashed with plain SHA-256 plus a fixed static prefix. There is no per-user salt, no memory hardness, and no work factor.

Reference:
- [server/src/db.ts:315](/home/vansin/agent-orchestra/server/src/db.ts:315)

Impact:
- fast offline cracking if the users table is leaked.
- does not meet baseline password storage expectations.

### 6. Medium: role values are not validated consistently

The route layer allows owners/admins to add or update members with arbitrary `role` strings, but authorization checks later assume a closed set of `owner/admin/member/viewer`.

References:
- arbitrary insert path: [server/src/index.ts:402](/home/vansin/agent-orchestra/server/src/index.ts:402), [server/src/auth.ts:252](/home/vansin/agent-orchestra/server/src/auth.ts:252)
- arbitrary update path: [server/src/index.ts:409](/home/vansin/agent-orchestra/server/src/index.ts:409), [server/src/auth.ts:260](/home/vansin/agent-orchestra/server/src/auth.ts:260)
- invite path is stricter and uses an allowlist: [server/src/auth.ts:279](/home/vansin/agent-orchestra/server/src/auth.ts:279)

Impact:
- malformed roles can be persisted.
- later permission checks may fail open or fail unpredictably.

### 7. Medium: `GET /api/auth/me` returns only owned networks, not all memberships

`/api/auth/me` uses `getUserNetworks()`, which only selects `networks.owner_id = userId`, while the rest of the system has already moved to `getUserAllNetworks()` for membership-aware behavior.

References:
- owner-only query: [server/src/auth.ts:155](/home/vansin/agent-orchestra/server/src/auth.ts:155)
- route usage: [server/src/index.ts:259](/home/vansin/agent-orchestra/server/src/index.ts:259)
- membership-aware version exists: [server/src/auth.ts:316](/home/vansin/agent-orchestra/server/src/auth.ts:316)

Impact:
- joined networks disappear from `whoami` / `login --token` style flows.
- behavior is inconsistent across endpoints.

### 8. Medium: legacy global auth token bypasses the user/network model

If `COMMHUB_AUTH_TOKEN` is set, requests authenticated with that token pass `requireAuth()` even though `resolveRequestAuth()` returns `null`. That effectively grants broad access to endpoints that rely only on `requireAuth()` and have no later per-user membership check.

References:
- [server/src/index.ts:46](/home/vansin/agent-orchestra/server/src/index.ts:46)
- [server/src/index.ts:57](/home/vansin/agent-orchestra/server/src/index.ts:57)

Impact:
- one shared secret can bypass the multi-user permission model.
- acceptable for local/dev only, dangerous for shared deployments.

### 9. Medium: network deletion leaves related data behind

`deleteNetwork()` deletes only the `networks` row after checking active sessions. It does not explicitly remove related `network_members`, `network_invites`, `api_tokens`, `tasks`, `nodes`, or `inbox` rows, and there are no foreign keys shown in schema.

References:
- [server/src/auth.ts:195](/home/vansin/agent-orchestra/server/src/auth.ts:195)
- schema tables without FK constraints: [server/src/db.ts:162](/home/vansin/agent-orchestra/server/src/db.ts:162), [server/src/db.ts:178](/home/vansin/agent-orchestra/server/src/db.ts:178), [server/src/db.ts:243](/home/vansin/agent-orchestra/server/src/db.ts:243), [server/src/db.ts:258](/home/vansin/agent-orchestra/server/src/db.ts:258)

Impact:
- orphaned authorization artifacts and historical rows remain addressable.

## Permission Coverage Summary

Implemented correctly:
- member listing/add/remove/invite are guarded to `owner/admin` at the route layer: [server/src/index.ts:397](/home/vansin/agent-orchestra/server/src/index.ts:397), [server/src/index.ts:402](/home/vansin/agent-orchestra/server/src/index.ts:402), [server/src/index.ts:416](/home/vansin/agent-orchestra/server/src/index.ts:416), [server/src/index.ts:424](/home/vansin/agent-orchestra/server/src/index.ts:424)
- member role changes are owner-only: [server/src/index.ts:409](/home/vansin/agent-orchestra/server/src/index.ts:409)
- node token creation blocks viewers: [server/src/auth.ts:123](/home/vansin/agent-orchestra/server/src/auth.ts:123)
- network detail requires membership or global admin: [server/src/index.ts:463](/home/vansin/agent-orchestra/server/src/index.ts:463)

Missing or incomplete:
- no role check on MCP `send_task`
- no role check on REST `POST /api/task`
- no membership validation for several read APIs
- no quota enforcement on network/task/agent creation paths

## Code Quality Notes

- `server/src/index.ts` repeats the same token extraction and `resolveToken()` pattern in many route branches. This is a good candidate for a small authenticated-route helper.
- `isAdmin` is computed and never used: [server/src/index.ts:543](/home/vansin/agent-orchestra/server/src/index.ts:543)
- `createInvite()` defines `expiresAt` only to branch on it; the string itself is otherwise unused except as a boolean flag: [server/src/auth.ts:282](/home/vansin/agent-orchestra/server/src/auth.ts:282)
- migration and logging code swallows errors broadly with `catch {}` throughout `db.ts` and `index.ts`, which makes operational failures hard to see and harder to recover from.
- naming is mostly understandable, but token scopes are under-specified in enforcement. `scope` is stored in `api_tokens` yet `resolveToken()` returns only `user` and `networkId`, so later authorization cannot distinguish `user` vs `full` vs `network` cleanly: [server/src/auth.ts:136](/home/vansin/agent-orchestra/server/src/auth.ts:136)

## Overall Conclusion

The owner/admin member-management routes are present, but the overall permission model is not complete. The largest gap is that network isolation is enforced inconsistently: MCP tools and several REST read/write endpoints still trust caller-supplied `network_id` or skip role checks entirely. On top of that, license quotas are currently cosmetic, and password hashing is not strong enough for production use.

If this code is meant for real multi-user deployment, the immediate fixes should be:

1. make `resolveToken()` return token scope and enforce it centrally
2. reject caller-supplied `network_id` unless membership is verified
3. add role gates for all task-dispatch write paths
4. scope every read endpoint by membership or admin privilege
5. enforce `max_networks`, `max_agents`, and `max_tasks_day`
6. replace SHA-256 password hashing with a slow password hash such as Argon2 or bcrypt
