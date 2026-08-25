# test1190 — Codex `/btw` app-server wire probe

Date: 2026-08-26  
Source: PR0 branch based on `origin/main` `aca3a926`  
Vendor artifact: `@openai/codex@0.148.0` (`codex-cli 0.148.0`)  
Environment: Docker `node:22-bookworm-slim`; sentinel-marked disposable `CODEX_HOME`

## Commands

Schema/golden gate (credential-free):

```sh
sg docker -c 'docker build -f tests/test1190-codex-btw-wire-probe/Dockerfile -t anet-test1190 .'
sg docker -c 'docker run --rm anet-test1190'
```

Live gate uses an authenticated, disposable `CODEX_HOME` mount containing the
checked-in sentinel value `test1190-disposable-v2`. The guarded cleanup also
removes root-owned files written by the container. Credentials were not
printed or committed:

```sh
sg docker -c 'docker run --rm -e BTW_LIVE_PROBE=1 \
  -e CODEX_HOME=/codex-home -e REPORT_DIR=/out \
  -v <disposable-home>:/codex-home -v <report-dir>:/out anet-test1190'
```

## Result

Both gates passed. The normal and experimental protocol schemas are generated
separately. The live gate records an inspectable sanitized wire trace with
monotonic sequence numbers and logical aliases only: no UUIDs, prompt bodies,
credentials, or filesystem paths.

```json
{
  "evidenceRevision": "test1190-wire-v2",
  "topology": "owned-stdio",
  "sourceWasActiveAtFork": true,
  "authoritativeForkTurnSets": true,
  "threeWayActiveBeforeCancel": true,
  "cancelPrecedesSourceAndSiblingTerminal": true,
  "successfulForksCompleteOutOfCreationOrder": true,
  "unarchiveReadable": true,
  "deleteLeavesSourceAndSiblingReadable": true
}
```

Semantic observations are frozen in `golden/live-result.json`; request,
response, Thread, Turn, and notification shapes are frozen in
`golden/schema-result.json`. `lastTurnId` is normal API; `beforeTurnId` alone
requires experimental negotiation. The suite also reruns a witnessed-red
variant that deliberately lets the source finish before forking and requires
the probe to fail with `WITNESS_RED: source was not active at fork boundary`.

## Limits

- Authentication is required for real model turns, so default CI runs the
  schema golden only. A protected credentialed job must run the live gate on
  version/golden changes.
- This proves the owned stdio app-server topology only. Shared WebSocket/TUI
  topology remains unsupported for `/btw` until separately probed.
- It proves the exact 0.148.0 Linux npm artifact only, not a semver range. This
  is a probe allowlist, not a repository-wide upgrade from the agent-node
  Codex SDK lock at 0.133.0.
- It does not implement SideChat storage, API, App UI, fallback snapshot,
  write-back, archive policy or purge.
