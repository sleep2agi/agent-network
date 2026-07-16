# test384-opencode-local-package-e2e

Release gate for the locally built `agent-network` and `agent-node` tarballs.
It uses an isolated loopback CommHub and `/tmp` SQLite DB only.

Layers stop on first failure:

1. exact candidate versions / `publishConfig.tag=preview`, local
   build/pack/install, SHA-256 capture, exact `opencode-ai@1.18.1`, and bundle
   markers;
2. isolated CommHub registration and real `anet login`;
3. a pre-seeded `.anet/nodes/<alias>` symlink is rejected before profile token
   or dotenv state can escape the project;
4. real `pexpect` interaction with both `anet node create` entry points,
   asserting the complete ordered six-choice canonical-main picker before
   selecting `opencode-cli`;
5. Anthropic/OpenAI preset files, mode `0600`, and both static and upstream
   effective-config proof that `bash/read/glob/grep/edit/write/list/task/skill`
   and the unattended `question` tool are disabled by default;
6. hostile inherited `XDG_*` / `OPENCODE_CONFIG*` values plus a deterministic
   ACP child that records only environment key names and selected non-secret
   path/policy values; this proves an external random `0700` launch root under
   the explicitly prepared trusted base, with `workspace` and fresh
   HOME/XDG/data/cache/state/runtime/tmp in that same root and removed on exit,
   authoritative `plugin: []`, exact project/external-skill/Claude/LSP discovery
   disable flags, and removal of CommHub/GitHub/npm/Slack credentials and
   `NODE_OPTIONS`;
   a profile-level stale `PATH`/forged binary identity and a same-version
   project-local `opencode-ai` package impersonator are never executed;
7. explicit ACP handshake rejection cleanup and `SIGTERM` while `initialize`
   is still unresolved, each followed by a PID-level orphan check;
8. exact 1.18.1 malicious-ancestor negative gates: every external-workspace
   ancestor rejects `opencode.jsonc`, `opencode.json`, `.opencode`, `AGENTS.md`,
   `CLAUDE.md`, `CONTEXT.md`, `.claude`, `.agents`, and `.git`, and the same
   inode/candidate scan runs after the version probe immediately before ACP
   spawn. A project-root `opencode.json` points at a file plugin whose top level
   reads a synthetic `ANTHROPIC_API_KEY` canary and writes a marker; a real Hub
   task must still reply through the node's free model while that marker remains
   absent. The same real plugin tripwire is active before auth-login, and is
   checked at prompt render, interrupted exit, and successful import.
   `OPENCODE_PURE` / `OPENCODE_DISABLE_PROJECT_CONFIG` are checked only
   as defense in depth, not accepted as the isolation boundary;
9. graceful shutdown and global orphan-process audit.

Run from the repository root:

The container is Linux and pre-creates an owner-only trusted directory, then
passes its absolute path through `ANET_OPENCODE_SAFE_BASE`. Production defaults
to `/run/user/$uid`; a non-systemd host must likewise pre-create the configured
base. The base and every ancestor must have no group/other write bit, otherwise
safe launch must hard-fail instead of falling back to project cwd or `/tmp`.

```sh
sg docker -c 'docker build --build-arg OPENCODE_VERSION=1.18.1 -t anet-test384 -f tests/test384-opencode-local-package-e2e/Dockerfile .'
sg docker -c 'docker run --rm -v "$PWD/docs/tests:/report" anet-test384'
```

Publish the exact `/artifacts/*.tgz` files extracted from this passing image;
do not publish either package directory, which would rebuild different bytes.

The report is written to `docs/tests/report-test384.txt`. Synthetic dummy keys
are used only for local preset/boundary checks and are never printed. The real
free-model call carries an unused synthetic Anthropic canary solely so an
ancestor plugin would have something to observe if it were incorrectly loaded.
The fake-child dump never stores arbitrary environment values; credential
absence is checked from its key inventory.
