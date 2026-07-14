# test225 — Grok preview candidate package/live gate

This suite builds candidate npm tarballs from one exact Git commit archive, installs
them globally into a second clean Docker stage, and runs the CLI only from
those installed packages. It never publishes a package.

Before the build stage discards source, it proves that the runtime, CLI
persistence boundary, and value-free diagnostic use the same exact failure
code and JSONL subcode literals and that they equal a separately reviewed
preview contract. It also checks that the packed CLI contains both exact sets,
the closed relationship checks, and the value-free marker. It then emits a
read-only, value-free contract bound to the source commit and agent-node
tarball SHA-256. L0 validates that contract again in the source-free image;
unknown, coordinated-extra, duplicate, reordered, or extra values and changed
bindings are negative controls. Product behavior remains covered by the
tarball E2E below rather than being inferred from this contract alone.

The deterministic layer always runs. It uses a Grok 0.2.93-shaped PTY test
double but real candidate `anet`, `agent-node`, `commhub-server`, Hub/SSE,
Unix attach relay, and tmux TTY. It covers:

- the installed runtime and authenticated Grok process run as the image's
  unprivileged `node` user rather than relying on root-only TUI behavior;
- `anet node create --runtime grok-build-cli` and the preview warning;
- first `anet node start` resolving the unpublished candidate through a local
  npm registry and the documented `@preview` fallback, then launching its
  entrypoint directly (no `ANET_AGENT_NODE_BIN` or repository import);
- a global test double that advertises only the older V1 capability being
  probed but never launched, followed by fallback to the exact candidate;
- an offline second start selecting a global install of that exact tarball,
  with no surviving npm wrapper;
- registration, Hub task delivery, true tmux `anet grok attach` rendering,
  reply, stop, and same-session resume;
- exact resolver/agent-node/Grok/PTY/helper environment checks and synthetic
  credential scans over logs, Grok state, goal state, pending replies,
  candidate tarballs, captures, and the report.

Both the deterministic fake and the authenticated run require a mode-0600
`trusted_folders.toml` containing exactly the canonical test working
directory. The harness contains no tmux send-key, paste, or buffer command, so
a folder confirmation or network turn cannot pass through simulated input.

The runtime stage needs outbound npm access during the first fallback because
the disposable local registry serves the unpublished `agent-node` tarball and
proxies its public dependencies. The Hub, task traffic, TUI, stop, and resume
remain container-local. After the exact tarball is installed into an
owner-only user-global prefix, the local registry is stopped and the resume
gate runs with npm offline. Do not
run the deterministic command with `--network none`; test224 is the separate
network-disabled package/security gate.

Run the deterministic layer from the repository root. The archive step is a
hard provenance gate: uncommitted files are excluded, and an export-substituted
commit marker inside the image must equal `SOURCE_COMMIT`.

```bash
SOURCE_COMMIT=$(git rev-parse HEAD)
CONTEXT=$(mktemp -d)
git archive "$SOURCE_COMMIT" | tar -x -C "$CONTEXT"
sg docker -c "docker build --build-arg SOURCE_COMMIT=$SOURCE_COMMIT -f '$CONTEXT/tests/test225-grok-preview-package-live/Dockerfile' -t test225-grok-preview '$CONTEXT'"
rm -rf "$CONTEXT"
sg docker -c 'docker run --rm -v "$PWD/docs/tests:/artifacts" test225-grok-preview'
```

The authenticated live layer is opt-in because it consumes a real cached Grok
login. Mount the binary and auth read-only; raw auth and tmux captures remain
under `/tmp` and are destroyed rather than copied into artifacts. The second
turn must recall a fresh benign nonce from the first turn after stop/start, so
the gate proves actual session continuity rather than two independent calls:

Before the cached login is copied, this layer also points the pinned binary at
a container-local, non-billing model stub. Fresh/resume share one isolated
HOME, cwd, and session; each mutation has a separate HOME, cwd, model endpoint,
and Leader generation. Every client uses the production-shaped
`--leader --leader-socket` auto-Leader path. A generation is accepted only when
the pinned executable, exact HOME/GROK_HOME, owner-bound socket beneath the
mode-0700 probe root, per-run marker, listener FD, PID, and process start time
agree, and the next phase cannot start until the prior client, Leader, listener,
and socket are gone.
The reviewed profile is carried both as `--sandbox` and as the controlled
`GROK_SANDBOX` PTY variable because pinned 0.2.93 does not forward the client
argv value to its auto-spawned Leader; ambient `GROK_SANDBOX` is discarded.
The fresh and resume clients stop after chat, events, and updates reach the
same-session ordered completed-turn fence. After shutdown and before the next
phase, summary/count/sandbox metadata must also remain consistent for three
consecutive samples while the prior Leader stays absent.
Each mutation closes after the loopback endpoint receives the complete
marker+nonce request, observes the forbidden inventory, and finishes its SSE
response; it does not claim a persisted mutation turn. This sub-gate proves
only that positive TUI clients carry `ANET_COPRESENCE_PROFILE_V1` and expose
exactly `[todo_write]`, while default-tool and `read_file` mutations cross the
inventory boundary and turn the fixed gate red. A client that stays alive but
emits no matching main request fails as `request_timeout` and is not reclassified
as a persistence failure. The authenticated package E2E below remains the sole
full create/task/live-render/stop/resume product proof. The separate
`session_title` request is auxiliary and never satisfies main-request readiness.

After those four phases, an independent keyless session exercises the one
allowed tool. Its local model stub emits exactly one `todo_write` call and then
a text response. The gate requires two exact `[todo_write]` main requests, a
persisted tool call/result, a completed final assistant turn, and the exact
observed 0.2.93 lifecycle:
`turn_started → permission_requested → permission_resolved → turn_ended`.
The request must contain exactly `{type:string, tool_name:string, ts:string}`;
the resolution exactly
`{type:string, tool_name:string, decision:string, ts:string, wait_ms:number}`;
their reviewed literals are `todo_write` and `decision=allow`. Request IDs
must be absent; `wait_ms` must be a safe nonnegative integer. Extra fields,
rejection/cancellation, another turn, a different inventory, or an incomplete
turn all fail closed. The runtime accepts at most one such lifecycle per
network turn. Raw model requests, event values, and
session files remain inside the disposable probe root and are not copied to
the diagnostic artifact. Before spawning Grok, the pure structural classifier
self-checks one accepted fixture plus request-ID, extra-key, wrong-tool,
wrong-decision, missing-wait, reordered, and duplicate-event mutations; every
mutation must remain rejected.

The inventory probe keeps at most 64 KiB of stdout/stderr in memory for a
closed error classification and never persists that text. Its loopback stub
accepts at most 16 simultaneous request bodies and 2 MiB of aggregate buffered
body data; each body is capped at 1 MiB, each inventory at 128 tool names, and
each name at 256 bytes. Retained inventory evidence is independently capped at
256 rows and 1 MiB, with overflow represented by one fixed invalid sentinel.
On failure it writes only a mode-0600, closed-schema diagnostic (`phase`,
enumerated `category`, booleans, and bounded counts) to
`/artifacts/test225-tui-inventory-diagnostic.json`
after synthetic, Hub, and real-auth scalar scans. A successful run removes any
stale diagnostic. The schema and atomic writer have a keyless local negative
test:

```bash
node --test \
  tests/test225-grok-preview-package-live/inventory-gate.test.mjs \
  tests/test225-grok-preview-package-live/inventory-diagnostic.test.mjs
```

```bash
sg docker -c 'docker run --rm \
  --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  -e RUN_REAL_GROK=1 \
  -e TEST225_REAL_GROK_BIN=/host-grok/bin/grok-0.2.93 \
  -e TEST225_REAL_GROK_AUTH=/host-grok/auth.json \
  -v /path/to/grok-0.2.93:/host-grok/bin/grok-0.2.93:ro \
  -v /path/to/auth.json:/host-grok/auth.json:ro \
  -v "$PWD/docs/tests:/artifacts" \
  test225-grok-preview'
```

The three Docker security options are required only by the authenticated
layer because Grok 0.2.93 launches its configured workspace sandbox through
Bubblewrap. Keep the host mounts read-only and limited to the pinned binary,
`auth.json`, and optional `agent_id`; the test otherwise uses an isolated
HOME, Hub, working directory, and session. A default Docker profile blocks
Bubblewrap before the Leader socket is created and is therefore not a valid
runtime result.

The suite is a preview gate only. It does not claim the formal native Leader
protocol freeze or approval-owner completion required for `latest`.

If a real first/resume task reaches a terminal failure, the harness destroys
the raw Hub/TUI material and retains only
`test225-real-turn-diagnostic.json`: a mode-0600 closed schema containing a
runtime-origin failure enum, a reviewed value-free failure subcode, and coarse
result-size/elapsed-time buckets. Version 2 contains exactly `v`, `phase`,
`status`, `failureCode`, `failureSubcode`, `resultSizeBucket`, and
`elapsedBucket`; it never stores the exact byte count, error/model text, a
digest of that text, paths, PIDs, task/session IDs, or model/account fields.
Only `jsonl_tail` may carry one of the exact reviewed JSONL boundary subcodes;
other reviewed failures carry `none`, while an unknown top-level failure is
the pair `unknown`/`unknown`. A forged, duplicated, unknown, or mismatched
marker pair collapses to `unknown`/`unknown`. That pair remains a failed gate
and must not be treated as evidence for any inferred root cause.
