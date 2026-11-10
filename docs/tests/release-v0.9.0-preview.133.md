# CommHub Server v0.9.0-preview.133

Lifecycle credential selection and rename labels use verified immutable node
identity, including supported legacy unbound credentials. Dispatch-time delete
freezes remain in place; older requests resolve the target identity without a
broad name-based credential change. Rename rejects ambiguous node registries.

Published from exact main `65923509c55f54e14082ac3804ae883d37723f44`
by formal run38338523163 (build, four gates, preview publication and
registry checks all succeeded). Selected production activation was confirmed
2026-10-13 11:04:28+08 with deployment main
`446fa719a0e6542396ca5f66079d03c7028f5ec2`; evidence:
report-test690-hub133-activation.txt. No schema, dependency,
port, provider or credential-source changes are required.

## Install

Published preview package:

```sh
bun add --global @sleep2agi/commhub-server@0.9.0-preview.133
```

## Upgrade

Use deploy/hub/README.md: pin the public package into an inactive sibling
runtime, compare whole public bytes with the exact-main gated artifact, make a
consistent private database backup and run the isolated offline upgrade probe.
Activate only the selected Hub after the deployment profile and lock are in
main. Preserve the existing Bun, PM2 identity, environment/key source, database,
ports and proxy configuration. Retain preview.132 for software rollback;
production data and original keys remain in private backup/credential sources.
