# CommHub 0.9.0-preview.127 — Provider and scoped secrets candidate, NOT PUBLISHED

#1045 permits explicitly configured HTTP Provider endpoints. HTTPS remains
recommended; HTTP traffic is plaintext. Scope, owner confirmation, CAS, vault
encryption and response redaction are unchanged. Unsupported protocols, URL
credentials and secret-write redirects remain refused.

#1053 adds owner/admin-scoped Daemon/node environment-key requests to the
existing management lane. Requests containing values exist only in bounded
memory until delivery/expiry; durable values remain in the selected Daemon's
private files. Readback is names/source/revision only. Requires CLI .169 and
runtime .135, plus a client exposing the real scoped-key forms.

## Install

Only after the full40 main-SHA release gates and registry-byte readback:

```bash
bun add --global @sleep2agi/commhub-server@0.9.0-preview.127
```

## Upgrade

Publish Hub .127, runtime .135, then CLI .169. The client HTTP advisory and
matching daemon are required for end-to-end use; old software can still refuse
HTTP. Publishing does not activate a running Hub or restart nodes.
Keep latest unchanged. Follow deploy/hub/README.md for the private exact-version
profile, original vault key source, consistent SQLite backup and activation
verification. Retain .126 and its profile for rollback.

## Evidence and recovery

Reuse docs/tests/report-test1045-provider-http.txt for the main-merged behavior.
Use docs/tests/report-test1053-scoped-secrets.txt for the actual handler-to-
Daemon-to-runtime-child core. See docs/scoped-secrets.md: pending requests are
not backed up or replayed after Hub restart. Operator must explicitly retry
unconfirmed writes; no automatic re-send or false saved receipt.
There is no new port, proxy, secret source, migration or launcher. Git recreates
software, not provider keys or account data. Restore the encrypted SQLite backup
with its separately protected vault key. Older readers can reject stored HTTP
endpoints: retain the data, do not erase it to roll back.
