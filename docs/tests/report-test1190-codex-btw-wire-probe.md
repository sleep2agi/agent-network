# test1190 — Codex `/btw` app-server wire probe

Date: 2026-08-26  
Source: PR0 branch based on `origin/main` `aca3a926`  
Vendor artifact: `@openai/codex@0.148.0` (`codex-cli 0.148.0`)  
Environment: Docker `node:22-bookworm-slim`; isolated copied `CODEX_HOME`

## Commands

Schema/golden gate (credential-free):

```sh
sg docker -c 'docker build -f tests/test1190-codex-btw-wire-probe/Dockerfile -t anet-test1190 .'
sg docker -c 'docker run --rm anet-test1190'
```

Live gate uses an authenticated, disposable `CODEX_HOME` mount. Credentials
were not printed or committed:

```sh
sg docker -c 'docker run --rm -e BTW_LIVE_PROBE=1 \
  -e CODEX_HOME=/codex-home -v <disposable-home>:/codex-home anet-test1190'
```

## Result

Both gates passed. The normalized live golden records no thread IDs, turn IDs,
prompt output, credentials or filesystem paths.

```json
{
  "exactCompletedBoundary": true,
  "exactBeforeActiveBoundary": true,
  "activeLastTurnFailsClosed": true,
  "cancelledOnlyDerived": true,
  "siblingCompleted": true,
  "sourceCompleted": true,
  "archiveIsNotDelete": true,
  "deletedCannotRead": true
}
```

Raw semantic observations are frozen in
`tests/test1190-codex-btw-wire-probe/golden/live-result.json`. Exact fork
boundary requires `initialize.capabilities.experimentalApi=true`; omission was
observed to fail with `-32600` and is a mandatory fail-closed gate.

## Limits

- Authentication is required for real model turns, so default CI runs the
  schema golden only. A protected credentialed job must run the live gate on
  version/golden changes.
- This proves the owned stdio app-server topology only. Shared WebSocket/TUI
  topology remains unsupported for `/btw` until separately probed.
- It proves protocol 0.148.0 only, not a semver range.
- It does not implement SideChat storage, API, App UI, fallback snapshot,
  write-back, archive policy or purge.
