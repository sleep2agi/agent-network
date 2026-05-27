# Grok runtime regression matrix

- Date: 2026-05-27T12:57:56+08:00
- Verdict: BLOCKED for full matrix; PASS for executed Docker/runtime smoke and reducer regression
- Scope: agent-network@2.2.8, agent-node@2.4.5, runtime grok-build-acp
- Production touched: no
- Test mode: Docker local CommHub dev-open + local source/unit checks

## Environment

- Workdir: `/home/vansin/agent-orchestra`
- Docker command style: `sg docker -c '...'`
- Container Grok CLI installed by harness: `grok 0.2.3 (14d81fd87)`
- Host Grok cache used read-only: `$HOME/.grok:/host-grok:ro`
- Local package versions:
  - `agent-network 2.2.8`
  - `agent-node 2.4.5`

## Commands

```bash
node -e "const p=require('./agent-network/package.json'); const n=require('./agent-node/package.json'); console.log('agent-network',p.version); console.log('agent-node',n.version);"

sg docker -c 'docker build -t anet-grok-build-acp-runtime-matrix -f tests/test-grok-build-acp-runtime/Dockerfile .'

mkdir -p docs/tests/p-grok-runtime-matrix-20260527
sg docker -c 'docker run --rm -v "$PWD/docs/tests/p-grok-runtime-matrix-20260527:/artifacts" -v "$HOME/.grok:/host-grok:ro" anet-grok-build-acp-runtime-matrix'

cd agent-node && bun test src/runtime/grok-build-acp/events.test.ts

grep -RIn -- 'GROK_RUNTIME_OK\|CommHub MCP\|commhub_send_task\|ACP error -32603\|Internal error\|terminal: false\|grokSession' \
  docs/tests/p-grok-runtime-matrix-20260527 agent-node/src/cli.ts agent-node/src/runtime/grok-build-acp/runtime.ts
```

## Key output

```text
agent-network 2.2.8
agent-node 2.4.5

# Grok Build ACP runtime E2E
auth: host-mount mode
grok 0.2.3 (14d81fd87)
start: commhub dev-open
auth: network_id=net_79e7a6bf0a89
start: agent-node grok-build-acp
PASS: agent registered
task: 5575736f-4348-46b7-b018-14ee4be4d52d
PASS: task replied
PASS: grokSession persisted

src/runtime/grok-build-acp/events.test.ts:
(pass) T6 prompt fixture accumulates final reply chunks
(pass) T8 session/load skips replay chunks from the previous turn
(pass) T9 abort + resume accumulates only the resumed turn reply
3 pass
0 fail
```

Task row evidence:

```json
{
  "task_id": "5575736f-4348-46b7-b018-14ee4be4d52d",
  "status": "replied",
  "content": "Reply with exactly GROK_RUNTIME_OK.",
  "result": "[grok-runtime-probe] GROK_RUNTIME_OK",
  "completed_at": "2026-05-27 04:57:22"
}
```

## Matrix results

| Case | Result | Evidence |
| --- | --- | --- |
| create/start | PASS | Docker harness started local CommHub, registered `grok-runtime-probe`, and agent reached `/api/status`. |
| plain reply | PASS | Task `5575736f-4348-46b7-b018-14ee4be4d52d` replied `[grok-runtime-probe] GROK_RUNTIME_OK`. |
| session resume | PASS for reducer/session persistence; partial for live resume | Live run persisted `grokSession: 019e67cb...`; reducer tests verified replay chunks are skipped and resumed reply excludes prior turn text. A second live task using the persisted session was not run in this pass. |
| source-citation does not leak CommHub/MCP | BLOCKED for live prompt; static guard present | `agent-node/src/cli.ts` has `sanitizeGrokCommhubLeak()` and `processWithGrok()` applies it before reply. No dedicated live source-citation prompt was executed. |
| explicit `send_task` delegation | BLOCKED for live flow; static wrapper present | `processTask()` calls `tryHandleExplicitDelegation()` before `think()`, so explicit delegation should be handled by CommHub wrapper before Grok. No two-agent live delegation fixture was executed. |
| `-32603` retry | BLOCKED for live fault injection; static guard present | `agent-node/src/runtime/grok-build-acp/runtime.ts` advertises `terminal: false`; `agent-node/src/cli.ts` retries once with fresh session on `ACP error -32603` or `Internal error`. No forced `-32603` live fixture was executed. |

## Artifacts

- Docker runtime artifact dir: `docs/tests/p-grok-runtime-matrix-20260527/`
- Docker report: `docs/tests/p-grok-runtime-matrix-20260527/report-grok-build-acp-runtime.txt`
- Agent log: `docs/tests/p-grok-runtime-matrix-20260527/agent.log`
- Server log: `docs/tests/p-grok-runtime-matrix-20260527/server.log`
- Task row: `docs/tests/p-grok-runtime-matrix-20260527/task-row.json`
- This report: `docs/tests/report-grok-runtime-matrix-2026-05-27.md`

## Gaps / blockers

- Full matrix is not complete because there is no independent Docker harness yet for:
  - live source-citation prompt with leak assertion,
  - two-agent explicit `send_task` delegation,
  - live persisted-session second-turn resume,
  - deterministic `-32603` ACP fault injection.
- Failure classification for gaps: test fixture gap, not observed product failure.
- Production hub and production network were not touched.
