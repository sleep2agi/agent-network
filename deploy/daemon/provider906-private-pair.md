# #906: own-daemon exact package upgrade during npm visibility delay

This is an operator-only installation of the formal **main** build, not an
alternative public desktop channel and not a branch release. It does not change
global npm packages, npm dist-tags, Hub endpoints, or other nodes' credentials.

## Immutable inputs

- Repository: `sleep2agi/agent-network`.
- Source: `b4413131b73c52c286beec46509773716698d89f`, verify it is still a main ancestor.
- Formal release run: `38106199041`, artifact `11689412711` (`gated-tarball`).
  Build, install-path, pins, notes, docs and aggregate verdict succeeded.
  Publication was accepted; its subsequent public visibility check failed.
- CLI file: `sleep2agi-agent-network-2.3.0-preview.163.tgz`.
  SHA256: `15f498ac22663bb948743fefbc93906751e4aaf493990a484e799a38a5837c58`.
- Paired runtime: `@sleep2agi/agent-node@2.5.0-preview.129`.
  SRI: `sha512-+BkOSio00dXw3GtBVTpxpG+QGQE/RBUdO0j376Xr69OA+v54J1TP8BjPbg4jKXsQVmQrXgpnuG0kzRQ+imt0SQ==`.

## Install and recover

As of 2026-10-11 12:46 UTC+08 an independent public copy of the same package is
available at https://github.com/sleep2agi/agent-network/releases/download/cli-v2.3.0-preview.163/sleep2agi-agent-network-2.3.0-preview.163.tgz .
Tag `cli-v2.3.0-preview.163` resolves to the exact source main SHA above. Upload
readback and anonymous full download matched the pinned SHA256. This copied the
formal main artifact without rebuilding; it did not move npm dist-tags or make
the desktop release complete. This durable URL is the preferred recovery source
while npm visibility remains delayed, and avoids relying on CI artifact retention.

Download the named artifact using authenticated `gh run download 38106199041
--repo sleep2agi/agent-network --name gated-tarball --dir <empty-staging>`.
Check the inner tarball SHA256 above (not the artifact archive digest). If the
artifact expires, use the public GitHub copy above or the matching public npm
tarball only after checking that same hash.
Do not silently rebuild a different package and claim an identical release.

Keep it in a durable private prefix such as `$HOME/.anet-bin/provider906-cli163`.
Its private package.json has exact dependencies:

```json
{
  "private": true,
  "dependencies": {
    "@sleep2agi/agent-network": "file:./sleep2agi-agent-network-2.3.0-preview.163.tgz",
    "@sleep2agi/agent-node": "2.5.0-preview.129"
  }
}
```

Run `npm install --ignore-scripts --no-audit --no-fund` in that prefix, retain
package-lock.json and verify both package identities and runtime SRI. Use
Node 22.22.2 to run the CLI. Remove group/other write permissions from the new
CLI's `node_modules/@sleep2agi/agent-network/dist/bin/anet.cjs` using `chmod go-w`.
The CLI's existing sibling runtime resolver picks the paired agent-node; its
existing daemon start command pins the executable, without an invented launcher.

Before activation, build `tests/test906-daemon-provider-management/Dockerfile.private-pair`
with that directory as its context, then Docker-run the image with only this
prefix mounted read-only at `/pair`, a `/tmp` tmpfs, no network or host secrets.
This checks package entrypoints and trust pin, not live provider operations.

## Targeted activation and rollback

Only the `daemon-dev` profile in the user's home working directory is in scope.
Preserve its private config and the original pair before stopping it. Start the
new pair's exact CLI with `daemon restart daemon-dev` in a detached tmux session
from the **same working directory**. Put Node 22.22.2 and the new pair's `.bin`
directory before the existing PATH. Do not use a floating `npx` package.
Use a distinct session name for the restart wrapper so stop cannot kill itself.

Verify `.pid`, `/proc/<pid>/exe`, the package path in `/proc/<pid>/cmdline`, workdir,
the Hub's node identity/online heartbeat, and provider capability. A process
being alive alone does not prove account switching or inference.

Rollback: stop only `daemon-dev` using the new CLI, then start the original
`$HOME/.anet-bin/anet-154/bin/anet daemon start daemon-dev` from the same workdir
with the original Node 22 PATH. This directory's actual packages are CLI
`.153` and agent-node `.121`; do not infer versions from its directory name.
No config migration or credential replacement is part of this operation.

## State and secrets

Profile config, tokens, child registry, provider auth and account homes are
private state, not in Git. Recover them from the host's encrypted state backup or
re-register/re-authenticate explicitly; cloning cannot restore accounts. This
operation changes no reverse proxy, port, Hub URL or vault key. It does not prove
the host has a complete encrypted backup policy. Do not copy another node's auth.

## Observed cutover (2026-10-11, UTC+08)

At 12:41 own `daemon-dev` was restarted using the exact new pair. The old runtime
process exited; new runtime PID 2555920 used Node 22.22.2, the new pair's entry,
and the original home workdir. Hub returned the same daemon identity, online,
agent-node `.129`, idle/queue 0. CLI pin verification and SSE connection succeeded.
The profile bytes were unchanged; backup resides in the private directory
`$HOME/.anet/daemon-dev-provider906-rollback.GsxCYT`. Old pair remains available.
The tmux socket label is `provider906-upgrade`, session `provider906-supervisor`.

Provider CLI returned an empty managed store (revision 0). Read-only Codex scan
of the own node returned `unavailable`: it is not in this daemon's local child
registry and lives in another workdir. Its legacy config also lacks network_id;
the general nodes directory is group-writable. Do not fabricate a binding or
weaken path checks to report success. Account/model switching and remote client
readback remain unverified; a proper scope/adoption plan is still required.
