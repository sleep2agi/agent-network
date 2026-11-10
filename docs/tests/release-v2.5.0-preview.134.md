# Runtime 2.5.0-preview.134 — OpenCode selected-model candidate, NOT PUBLISHED

The explicit node model is applied after ACP session/new or session/load and
before publication/task dispatch. Unsupported or rejected selection fails
explicitly rather than using a prior/default model. Existing V2 Provider/config
alignment and bounded live launch guards are retained.

## Install

After formal main-SHA publication and registry-byte verification, install privately:

```bash
npm install --prefix ./anet-daemon-pair @sleep2agi/agent-node@2.5.0-preview.134 @sleep2agi/agent-network@2.3.0-preview.168
```

## Upgrade

Publish runtime .134 first, then paired CLI .168 from the same main SHA.
Follow docs-site/docs/deploy/daemon.md for a selected idle Daemon. Activation
needs a separate receipt with actual versions, original identity and SSE.
No automatic business-node restart or shared-login copy. Existing Hub .126
and client .247 do not establish installation of this candidate.

## Evidence, limits and recovery

Main-merged PR2559 Docker gates cover V2 creation, live identity, safe V1 ACP
session and selected-model transport through disposable TLS fixtures. Not
live OAuth/entitlement or App PR795 native V1 registration acceptance.
See report-test894-main-restack.txt; formal package/install evidence is separate.
The release workflow and Daemon guide remain startup/upgrade authority.
No port/tunnel, secret source, database or backup change; retain old private pair
and configuration for rollback. Git contains software, not production login/data.
