# CLI 2.3.0-preview.169 — HTTP Provider candidate, NOT PUBLISHED

Pairs exactly with runtime 2.5.0-preview.135. Explicit HTTP Provider endpoints
are accepted by the private store and confirmed apply path. HTTPS is recommended;
HTTP is not encrypted. Source identity, CAS, redaction, confirmation and
no-redirect secret handling remain unchanged.

## Install

Only after formal full40 main-SHA publication and anonymous package readback:

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.169 @sleep2agi/agent-node@2.5.0-preview.135
```

## Upgrade

Publish Hub .127, runtime .135, then CLI .169. Keep latest unchanged.
Follow docs-site/docs/deploy/daemon.md for a selected private installation;
retain the old .168/.134 pair and identity-matched configuration. Publishing
does not restart a Daemon, switch providers or upgrade business nodes.
Client .248 and Hub .126 predate this change and must not be advertised as
the complete HTTP support release.

## Evidence and recovery

Reuse docs/tests/report-test1045-provider-http.txt for the main-merged core
chain. Formal package installation gates are independent. No new launcher,
port, proxy, tunnel, key source or schema is introduced. Restore private
Provider/account data from protected identity-matched backups, not Git.
Rollback selects the retained software/configuration; older readers may refuse
HTTP endpoints but must not delete them as a recovery shortcut.
