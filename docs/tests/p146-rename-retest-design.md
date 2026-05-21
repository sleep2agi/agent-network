# #146 rename re-test — enhanced gate design (N1/N2/N3 for c816dfa 2 blockers)

通信牛 code review found 2 blockers in c816dfa; Vincent ordered supplementary
test cases. This is the design for the new cases. The original 7-case matrix
(`docs/tests/p146-rename-c816dfa-gate/`) is fully retained — the enhanced gate
= original 7 + N1 + N2 (+ N3 optional).

All in Docker (`node:24-slim`, `USER node`), no host hub, no prod.

---

## Blocker → case mapping

| Blocker (通信牛 review) | Original 7-case gap | New case |
|--------------------------|---------------------|----------|
| **R1** — old process not confirmed fully dead after SIGTERM; a survivor keeps heartbeating → Finding-B self-revert | original R1 only tests the *graceful-exit* path (process exits cleanly within the grace window) | **N1** — adversarial: a process that **ignores SIGTERM** |
| **R2** — C4 re-register verify is a false-positive; CLI prints `✅ restarted + re-registered` even when the new process never started | original 7-case has **zero negative-path** coverage — every case expects the restart to succeed | **N2** — sabotage the new-process start, assert C4 reports **failure** |
| (Vincent optional) | legacy config without `node_id` never exercised | **N3** — rename a legacy (no-`node_id`) config |

---

## N1 — adversarial: rename a node whose process ignores SIGTERM

**Goal**: verify the fix's *confirm-dead + SIGKILL fallback* — that C2 does not
proceed to C3/C4 until the old process is provably gone, and a SIGTERM-deaf
process is escalated to SIGKILL so it cannot keep heartbeating and revert the
rename (Finding-B).

**Mechanism** — a mock "stale agent" (`mock-stale-agent.mjs`) that behaves like
a real agent-node's commhub session but refuses to die on SIGTERM:
- registers + heartbeats via the same MCP call the real agent-node uses —
  `POST ${HUB}/mcp` → `tools/call` `report_status` with
  `{resume_id:"sdk-<node_id>", alias, status:"idle", node_id, network_id, …}`
  (mirrors `agent-node/src/cli.ts:443`), `Authorization: Bearer <ntok>`
- writes its own PID to the node dir's `.pid` so the fix's `stopNode` targets it
- `process.on('SIGTERM', () => {})` — swallows SIGTERM, keeps heartbeating
- only SIGKILL (uncatchable) can stop it

**Steps**:
1. `anet node create n1node` (claude-agent-sdk; runtime irrelevant — the mock
   replaces the process).
2. Start the **mock** as n1node's process; it registers → n1node shows in
   `/api/status`; mock heartbeats every 15s; PID written to `.pid`.
3. `anet node rename n1node n1after --force`.
4. **Verdict** (all required):
   - the mock PID is **no longer alive** after the rename → `kill -0 <pid>`
     fails → SIGKILL fallback worked;
   - `n1before` is **absent** from `/api/status` after a 60s watch → the
     SIGTERM-deaf survivor did not revert the rename (Finding-B not reproduced);
   - rename exit code 0 and `n1after` present.

**Contrast with original R1**: original R1 = clean-exit path, 200s no-revert.
N1 = the survivor path the blocker is about.

---

## N2 — negative path: rename commit succeeds but the new process cannot start

**Goal**: verify C4's re-register check is **not** a false-positive — when the
restarted process never comes up, the CLI must report failure, never
`✅ restarted + re-registered`.

**False-positive mechanism the fix must defeat**: C3's 2PC routing switch
*relabels* the existing commhub session row old-alias → new-alias. Immediately
after commit, `/api/status` therefore shows `<new>` carrying the **old
process's last heartbeat** (recent `last_seen`, status `idle`). A naive
`waitForNodeOnline` that only checks `status !== offline` sees that ghost row
and declares success. The fix must require a heartbeat that **postdates the
restart** (fresh-heartbeat verification).

**Sabotage** — deterministic, does not depend on tmux-server env timing:
after `anet node create n2node`, edit `n2node/config.json` so the
`env.ANTHROPIC_AUTH_TOKEN._envRef` points to a **bogus var name**
(`BOGUS_ENVREF_NEVER_SET`). The already-running old process is unaffected (it
loaded its env at start); but the rename's PHASE-1 `cpSync` copies the bogus
config to `newDir`, so C4's `anet node start n2after` FATALs resolving the
missing env var → the new process never registers.

**Steps**:
1. `anet node create n2node` (claude-agent-sdk + intern), envRef exported.
2. `anet node start n2node` (real agent-node) → verify `online`.
3. Edit `n2node/config.json`: `_envRef` → `BOGUS_ENVREF_NEVER_SET`.
4. `anet node rename n2node n2after --force`, capture full stdout.
5. **Verdict** (core):
   - CLI stdout **must NOT** contain a success line for n2after
     (`✅ … restarted + re-registered`);
   - it **must** contain the failure/warning line
     (`⚠ … did not re-register within 30s` or equivalent);
   - rename exit reflects the partial failure (commit done, restart failed) —
     not a clean `✅`.
   - cross-check `/api/status`: n2after has **no fresh heartbeat** (the only
     row, if any, is the relabeled ghost with a pre-restart `last_seen`).
6. **Verdict** (recoverability — 通信龙 review add-on): a detected failure must
   also be a *recoverable* failure —
   - CLI stdout includes actionable recovery guidance (a `anet node start
     <newName>` hint, or `anet logs <newName>` / `anet status` — match any
     actionable hint, the exact wording depends on the blocker-fix's C4
     branch);
   - `newDir` (`.anet/nodes/n2after/`) is intact on disk with a readable
     `config.json` → the user can fix the env and `anet node start n2after`
     manually. (The rename *commit* succeeded; only the auto-restart failed.)

---

## N3 (optional) — rename a legacy config missing `node_id`

**Goal**: `resume_id` fallback path. `agent-node/src/cli.ts:435` —
`RESUME_ID = NODE_ID ? "sdk-<NODE_ID>" : "sdk-<ALIAS>-<ts>"`. A legacy config
without `node_id` exercises the alias-based fallback.

**Steps**:
1. `anet node create n3node`, then edit `config.json` to delete the `node_id`
   key (simulate a pre-`node_id` legacy node).
2. Start it, verify `online`.
3. `anet node rename n3node n3after --force`.
4. **Verdict**: rename completes without crash; `n3after` registers; no orphan
   `inbox` rows for either alias; no stale `sessions` rows.

---

## Enhanced gate = original 7 + N1 + N2 (+ N3)

Run after 工程马's blocker-fix commit lands (rebuild the agent-network tarball
from that commit). Verdict → 通信龙 + 通信工程马.

Docker base reuses the #146 7-case image (`USER node` + Phase-0 envRef export +
the 3 playbook anti-patterns #13/#14/#15).
