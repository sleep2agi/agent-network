# Portable V2 real-client regression (#883 / #829 / #539)

Test-only, not a public artifact or production deployment. This replaces the
local-image-only exploratory probe recorded in
`docs/tests/report-test829-real-model-lifecycle.txt`.

Run from a committed checkout on an x86_64 Linux Docker host:

```sh
sg docker -c 'bash tests/test883-v2-portable-client/ci.sh'
```

The script builds **git archive HEAD**, records the complete product/test SHA
and image ID, then runs a fresh non-root `--init --network none` container for
each case. Positive must pass before the wrong-model negative starts. The
negative must exit 1 at the provider-model assertion, clean up its owned
processes, and never enter the later stop/start layer. A timeout or unrelated
exception is not a passing negative control.

## Rebuild inputs and recovery boundaries

- Source/startup: this suite's Dockerfile, ci.sh, run.sh and drivers are the
  authoritative launchers. Hub, CLI and agent-node come from the recorded Git
  SHA. The actual client Web export and its HTTP plumbing come from App commit
  `4500c233e38fbdc2db5932f5edbe92f4fdd1ab9c`; Docker verifies checkout identity.
  No pre-existing ANet images or machine-local exports are required.
- Dependencies: Node and Bun base images are digest-pinned; product/App npm
  dependencies use their committed locks. OpenCode 2.0.22 and Playwright 1.58.2
  use `tools/package-lock.json`, including registry integrity hashes. Debian
  apt packages (Chromium/fonts/tmux etc.) come from public Bookworm repositories:
  **not bit-for-bit pinned**; package availability and network are rebuild
  prerequisites. This is source-rebuildability, not byte-identical image proof.
- Ports/routing: owned container loopback only: Hub 9287, fixture provider
  18827, temporary Web server ephemeral port. No published ports, reverse proxy,
  tunnel, host network, production endpoint or Docker socket in the container.
- Secrets: no real keys. The harness creates a throwaway Hub/database/user;
  generated credentials go to child drivers on stdin and logs redact tokens.
  V2 unsafe-tool opt-in applies only to the disposable test node.
- Version/verification/rollback: checkout a recorded full Git SHA and rerun;
  adjust client pin deliberately with evidence if testing another client.
  Reverting the test commit restores the earlier suite, not production state.
  A different SHA must rebuild its own image. CI artifacts are test-only.
- Data: all Hub/node/provider state is synthetic and container-local. No
  production database backup is consumed or recreated; recovering production
  data requires the separately documented encrypted backup/key procedures.

## Scope

Layers: environment → auth/daemon registration → unsafe-opt-in rejection →
real rendered create wizard → launch verdict/token proof → exact task reply in
TUI → rendered model change/revision/provider-request proof → rendered stop/start,
old process identities reaped, preserved config and a new exact task reply.

The browser uses the actual exported App and real authenticated Hub HTTP;
**OS/Tauri IPC is adapted in-page**. This is not a native Tauri/signed installer,
mobile-device, live vendor API, multi-user or production smoke test. No result
here alone closes #539 or authorizes a release. The `test829` fixture names are
preserved to keep previously proven protocol/task expectations unchanged.
