---
name: Bug report
about: Something is not working as expected
title: "[bug] "
labels: bug
---

## What happened

<!-- Describe the unexpected behavior. -->

## What you expected

<!-- What should have happened instead? -->

## Reproduction

Minimal steps to reproduce:

1.
2.
3.

## Environment

Run `anet doctor` and paste the output here — it captures everything below in one go:

```
$ anet doctor
<paste output>
```

Or fill in manually:

- `anet --version`:
- `agent-node --version`:
- commhub-server (`curl http://127.0.0.1:9200/health` → `version` field):
- dashboard version (if relevant, `npm view @sleep2agi/agent-network-dashboard version`):
- Node version (`node -v`):
- OS:
- Hub: local 127.0.0.1 / LAN / remote
- Runtime: claude-agent-sdk / codex-sdk / claude-code-cli
- Install method: npm global / npx / Docker / one-shot script

## Logs / output

```
<!-- Paste relevant log lines. Redact tokens (utok_/ntok_/atok_/api keys), private IPs, /home/<user>/ paths. -->
```

## Anything else?

<!-- Screenshots, related issues, theories. -->
