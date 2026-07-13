# test225 — Grok preview candidate package/live gate

This suite builds candidate npm tarballs from one exact Git commit archive, installs
them globally into a second clean Docker stage, and runs the CLI only from
those installed packages. It never publishes a package.

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
a container-local, non-billing model stub. Every fresh, resume, and mutation
client uses the production-shaped `--leader --leader-socket` auto-Leader path.
The reviewed profile is carried both as `--sandbox` and as the controlled
`GROK_SANDBOX` PTY variable because pinned 0.2.93 does not forward the client
argv value to its auto-spawned Leader; ambient `GROK_SANDBOX` is discarded.
The fresh client is stopped only after `updates.jsonl` and `summary.json` reach
the same-session completed-turn/count/sandbox fence. This sub-gate proves only
that every real TUI client carries `ANET_COPRESENCE_PROFILE_V1` and exposes
exactly `[todo_write]`; the authenticated package E2E below remains the sole
full create/task/live-render/stop/resume product proof. Default-tool and
`read_file` profile mutations must turn the gate red. The separate
`session_title` request is classified as auxiliary rather than being mixed
into the model-tool inventory.

The inventory probe keeps at most 64 KiB of stdout/stderr in memory for a
closed error classification and never persists that text. On failure it writes only a
mode-0600, closed-schema diagnostic (`phase`, enumerated `category`, booleans,
and bounded counts) to `/artifacts/test225-tui-inventory-diagnostic.json`
after synthetic, Hub, and real-auth scalar scans. A successful run removes any
stale diagnostic. The schema and atomic writer have a keyless local negative
test:

```bash
node --test tests/test225-grok-preview-package-live/inventory-diagnostic.test.mjs
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
runtime-origin failure enum, result byte count, and coarse elapsed-time
bucket. It never stores the error/model text, a digest of that text, paths,
PIDs, task/session IDs, or model/account fields. An `unknown` code remains a
failed gate and must not be treated as evidence for any inferred root cause.
