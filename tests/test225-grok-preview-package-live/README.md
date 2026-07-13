# test225 — Grok preview candidate package/live gate

This suite builds candidate npm tarballs from the current checkout, installs
them globally into a second clean Docker stage, and runs the CLI only from
those installed packages. It never publishes a package.

The deterministic layer always runs. It uses a Grok 0.2.93-shaped PTY test
double but real candidate `anet`, `agent-node`, `commhub-server`, Hub/SSE,
Unix attach relay, and tmux TTY. It covers:

- `anet node create --runtime grok-build-cli` and the preview warning;
- first `anet node start` resolving the unpublished candidate through a local
  npm registry and the documented `@preview` fallback, then launching its
  entrypoint directly (no `ANET_AGENT_NODE_BIN` or repository import);
- an offline second start selecting a global install of that exact tarball,
  with no surviving npm wrapper;
- registration, Hub task delivery, true tmux `anet grok attach` rendering,
  reply, stop, and same-session resume;
- exact resolver/agent-node/Grok/PTY/helper environment checks and synthetic
  credential scans over logs, Grok state, goal state, pending replies,
  candidate tarballs, captures, and the report.

The runtime stage needs outbound npm access during the first fallback because
the disposable local registry serves the unpublished `agent-node` tarball and
proxies its public dependencies. The Hub, task traffic, TUI, stop, and resume
remain container-local. After the exact tarball is installed globally, the
local registry is stopped and the resume gate runs with npm offline. Do not
run the deterministic command with `--network none`; test224 is the separate
network-disabled package/security gate.

Run the deterministic layer from the repository root:

```bash
sg docker -c 'docker build -f tests/test225-grok-preview-package-live/Dockerfile -t test225-grok-preview .'
sg docker -c 'docker run --rm -v "$PWD/docs/tests:/artifacts" test225-grok-preview'
```

The authenticated live layer is opt-in because it consumes a real cached Grok
login. Mount the binary and auth read-only; raw auth and tmux captures remain
under `/tmp` and are destroyed rather than copied into artifacts:

```bash
sg docker -c 'docker run --rm \
  -e RUN_REAL_GROK=1 \
  -e TEST225_REAL_GROK_BIN=/host-grok/bin/grok-0.2.93 \
  -e TEST225_REAL_GROK_AUTH=/host-grok/auth.json \
  -v /path/to/grok-0.2.93:/host-grok/bin/grok-0.2.93:ro \
  -v /path/to/auth.json:/host-grok/auth.json:ro \
  -v "$PWD/docs/tests:/artifacts" \
  test225-grok-preview'
```

The suite is a preview gate only. It does not claim the formal native Leader
protocol freeze or approval-owner completion required for `latest`.
