# CLI 2.3.0-preview.169 — Provider and scoped secrets candidate, NOT PUBLISHED

Pairs exactly with runtime 2.5.0-preview.135. Explicit HTTP Provider endpoints
are accepted by the private store and confirmed apply path. HTTPS is recommended;
HTTP is not encrypted. Source identity, CAS, redaction, confirmation and
no-redirect secret handling remain unchanged.

Daemon/node environment keys now use the private scoped store (#1053).
Daemon defaults are inherited; node entries override the same key. The
existing management request lane calls `anet daemon secret <daemon>` with
private JSON stdin; values are never CLI arguments or readback fields.
Saved values are loaded on the next complete node start, not hot-injected.

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
chain and docs/tests/report-test1053-scoped-secrets.txt. Formal package
installation gates are independent. No new launcher,
port, proxy, tunnel, key source or schema is introduced. Restore private
Provider/account data from protected identity-matched backups, not Git.
Rollback selects the retained software/configuration; older readers may refuse
HTTP endpoints but must not delete them as a recovery shortcut.
Private scoped-secrets.json and per-node secrets-source.json must be included
in the operator's protected identity-matched backups; Git contains no keys.
See docs/scoped-secrets.md for precedence, activation and recovery.
