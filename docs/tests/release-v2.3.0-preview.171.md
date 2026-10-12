# CLI 2.3.0-preview.171 — runtime137 private-node-key pairing, candidate

Pairs exactly with runtime2.5.0-preview.137 and Hub0.9.0-preview.128. Uses the
shared node-private environment reader during launch, including the existing
same-name envRef path, independently of a Daemon source marker. Old published
CLI170/runtime136 remains immutable, not silently repackaged.

## Install

Only after exact-main gates and anonymous byte verification:

```sh
npm install -g @sleep2agi/agent-network@2.3.0-preview.171 @sleep2agi/agent-node@2.5.0-preview.137
```

## Upgrade

Publish Hub128 then runtime137 before this paired CLI. Preserve previous private
install/config for rollback. Software updates do not rotate identities, move
sessions or restart business nodes. Selected activation follows checked-in
deploy/daemon procedures and verifies real version/identity/management receipt.

Source/core: PR2647, docs/tests/report-test1075.txt and docs/scoped-secrets.md.
Existing launcher, proxy/tunnel and ports are unchanged. Git is not a backup of
private node keys, OAuth sessions or production SQLite contents. Keep latest
unchanged. Candidate versions are not advertised as downloadable before actual
formal publication and byte readback.
