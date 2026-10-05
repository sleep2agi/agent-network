# test-tm-codex-upgrade-rehearsal — not in CI

Verified: 2026-10-06
Revisit-when: the upgrade guide docs/ops/tm-codex-upgrade-0.88-to-0.112.md is retired, or a fleet upgrade guide for a newer pair reuses this rehearsal

One-off operator rehearsal for #593 (board, parent #583). It installs two **published** release pairs
from the npm registry (`@sleep2agi/agent-network@2.3.0-preview.115` → paired agent-node
`2.5.0-preview.88`, then `2.3.0-preview.145` → `2.5.0-preview.112`), so it needs registry access and
takes ~10 minutes; it tests released artefacts, not this checkout's agent-node. The behaviour it
pins (the #461/#465 app-server watchdog) is covered in CI by `tests/test-codex-appserver-watchdog`.

Run:

```bash
docker build -t tm593 -f tests/test-tm-codex-upgrade-rehearsal/Dockerfile .
docker run --rm tm593          # ends with FAILS=0
```
