# Windows local daemon: App launch contract (RFC-044)

## Delivery status

This first slice fixes path/environment/JS-entry primitives. It is **not** proof
that daemon init/start or a Claude SDK task works on Windows. Runtime filtering,
process-tree cleanup and the full Hub → daemon → SDK reply CI remain follow-up
acceptance gates. Do not publish Windows daemon support based on this slice.

The follow-up candidate adds an SDK-only Windows runtime policy (currently only
`claude-agent-sdk`), refusal before terminal orchestration, shell-free sibling
agent-node launch and Windows process-tree cleanup. Its real-Hub SDK smoke must
pass on Windows before treating that candidate as supported. `codex-sdk` and
OpenCode are not advertised as native Windows options yet.

## App-owned installation and launch

The App owns an isolated prefix containing Node and the paired anet/agent-node
packages. Do not install global packages or require the system Node, Bash, WSL,
or a terminal multiplexer. Invoke the private Node directly, with an argument
array, never an `anet.cmd` wrapper or a shell command string:

```text
<private-node>/node.exe
  <private-prefix>/node_modules/@sleep2agi/agent-network/dist/bin/anet.cjs
  daemon init <daemon-name>
```

Start with the same executable, prefix and cwd, replacing `init` with `start`.
`start` is a foreground, long-lived supervised process; the App owns its handle
and stdout/stderr log files. Installation/download timing and first-run Key UI
belong to the App and are not measured by the primitive tests.

- cwd: fixed App-private `local-daemon` work directory. Node profiles and
  child ownership records live below that cwd's `.anet`.
- HOME and USERPROFILE: both the same App-private absolute home. For drive-letter
  paths, HOMEDRIVE/HOMEPATH must match. The App's login belongs only in
  `<private-home>/.anet/config.json`, never the real user's CLI login file.
- Child HOME explicitly supplied by the App wins over an inherited OS
  USERPROFILE. All child home variables derive from that home, including UNC.
- Private Node and paired agent-node must be installed alongside anet. The
  existing sibling-package resolver avoids depending on system-global shims.
- Windows children execute a verified anet JS pin via the daemon's own
  `process.execPath`, preserving the argument array and avoiding shell parsing.
- Windows child PATH begins with the trusted runtime directory and uses `;`
  for explicit extra directories. It does not copy the user's arbitrary PATH or
  append POSIX `/usr/bin` paths. Additional Windows OS environment needs remain
  subject to the full SDK smoke, not presumed working here.

The SDK candidate additionally includes fixed SystemRoot-derived System32 and
WindowsPowerShell directories, needed by existing process identity probes.
SystemRoot and TEMP/TMP come only from the daemon's environment, never a Hub env
patch. SDK child launches require the paired sibling package and do not fall
back to global shims or `npx`. Windows daemon stop delegates to the pinned
CLI using private Node and an argv array. The CLI requires its persisted lifecycle
receipt, then reuses the native identity/captured-descendant/taskkill `/T /F`
orchestrator. It never enters the POSIX residual sweep or alias-only discovery.
Unknown identity, PID reuse or incomplete descendant evidence keeps the receipt
and fails stop; dead-wrapper/crash recovery is fail-closed where the surviving
tree cannot be proven. Boot uses persisted receipts, not `pgrep`, for this path.

SDK stop uses one private, resident PowerShell helper for the whole stop flow.
It compiles Toolhelp once in memory, then reuses it for capture, immediate
pre-kill birth checks and final verification, without a disk DLL cache. Helper
startup/compilation has a separate 20-second bound; each query has a 5-second
bound after readiness. Logs distinguish `startup_compile_ms` from `query_ms`.
Capture and final verification use a local Toolhelp process table (kernel32) and .NET birth ticks;
they do not initialize CIM/WMI for each descendant. Capture brackets parent
edges with birth reads and rechecks each root, and each root is still revalidated
immediately before taskkill. Missing/partial evidence remains an error, not an
empty tree. The Hub ACK uses `exit_signal: "taskkill"` (within its 16-character
contract); detailed stages stay in logs. The native smoke requires stop plus
accepted Hub acknowledgment within 15 seconds. That performance target remains
unproven until the native Windows run passes. This end-to-end target still
includes helper startup/compilation; separating timeout budgets does not hide
cold-start latency from acceptance. The helper is disposed on completion/error.

`init` can capture stdout/stderr without a shell: call private Node with the
argument array and wait for its output. Do not use `cmd /c` just to read output.
HOME and USERPROFILE are full paths; e.g. for `D:\App Private\home`, HOMEDRIVE
is `D:` and HOMEPATH is `\App Private\home`, not another full path.

The existing `%ProgramData%/anet-daemon/path.conf` trust root remains supported;
normal `anet daemon` commands also retain their existing self-resolved package
pin path. No new pin authority or trust bypass is added. Windows stat mode bits
cannot validate ACLs: both CLI and runtime explicitly skip synthetic POSIX mode
checks while retaining package identity and existing pin verification.

## Evidence and recovery

```sh
sg docker -c 'docker build -f tests/test-rfc044-windows-daemon/Dockerfile -t anet-rfc044-paths . && docker run --rm --network none anet-rfc044-paths'
```

The workflow `.github/workflows/windows-daemon.yml` runs primitive tests on
`windows-latest`, including a real shell-free JS child using a private config
with a conflicting cloud-home sentinel. This is not the full daemon isolation
test or the required first-reply smoke yet.

The follow-up `smoke.ts` builds paired package artifacts, copies a private Node,
starts a temp-DB Hub, invokes actual daemon init/start, requests a Claude SDK
node via Hub MCP, supplies only local per-node secrets, sends a task and verifies
the captured SDK reply and daemon stop acknowledgment. Only model HTTP is
stubbed. Its init-to-reply timer excludes dependency installation/download and
does not prove the complete downloaded-App three-minute goal. It also checks
that cloud config sentinel bytes remain unchanged; the earlier native primitive
test exercises conflicting HOME/USERPROFILE resolution separately.

The Windows smoke rejects any discoverable `git.exe` on the SDK launch PATH.
Git is not an out-of-box prerequisite; this slice adds no Git discovery or
MinGit installation. A Windows-only probe checks that product `minimalEnv`
discards a malicious inherited PATH, resolves cmd/where/taskkill/PowerShell from
the fixed OS directories and can execute PowerShell. Native SDK first reply is
still required after that probe; neither check substitutes for the other.

This change adds no service, port, proxy, tunnel or secret. Restore software from
the pinned packages; restore local login, node tokens, profiles and history from
the App-private data backup or re-register them. Git does not contain that data.
Rollback replaces the paired packages and restarts only the App-owned processes;
it does not migrate or merge local and cloud config. No production processes or
global packages should be changed to rehearse this path.
