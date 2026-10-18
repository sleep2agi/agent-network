# CommHub 0.9.0-preview.126 — #1027 release candidate, NOT PUBLISHED

`get_create_request` now returns the request's `network_id`, so the paired
Daemon can persist the child's network scope. This additive field preserves
existing token authentication; no token rotation or database migration occurs.
Publish through `release.yml`, using a full40 merged main SHA. PR artifacts
are test-only. Publish Hub126, runtime133, then CLI167; keep `latest` unchanged.

## Install

Only after formal publication and registry-byte verification:

```bash
bun add --global @sleep2agi/commhub-server@0.9.0-preview.126
```

## Upgrade

Use `deploy/hub/README.md` and the versioned profile/launcher in `deploy/hub/`.
Retain the current software, launcher and consistent encrypted SQLite backup;
install the exact new package in a sibling directory. Record the selected
profile in Git before activation and verify actual process version, health,
authenticated creation response and child network scope. Publishing a package
does not upgrade an existing Hub. The existing125 profile is not silently changed.

## Recovery and rollback

Existing ports, proxy/tunnel configuration and startup scripts are unchanged.
Obtain the original vault key from the deployment's protected secret source,
not Git; restore it together with the encrypted database backup. Git recreates
software and schema, not accounts, nodes, tasks or credential data. Roll back
the selected launcher to the retained software/profile without deleting data.
No empty-machine data recovery or production activation is claimed here.
