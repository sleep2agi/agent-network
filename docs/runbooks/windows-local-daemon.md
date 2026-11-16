# Windows local daemon: App launch contract (RFC-044)

## Delivery status

This first slice fixes path/environment/JS-entry primitives. It is **not** proof
that daemon init/start or a Claude SDK task works on Windows. Runtime filtering,
process-tree cleanup and the full Hub → daemon → SDK reply CI remain follow-up
acceptance gates. Do not publish Windows daemon support based on this slice.

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

This change adds no service, port, proxy, tunnel or secret. Restore software from
the pinned packages; restore local login, node tokens, profiles and history from
the App-private data backup or re-register them. Git does not contain that data.
Rollback replaces the paired packages and restarts only the App-owned processes;
it does not migrate or merge local and cloud config. No production processes or
global packages should be changed to rehearse this path.
