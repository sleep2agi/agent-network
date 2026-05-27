# Grok Delegation Broaden Patch

Date: 2026-05-27
Owner: 通信SDK牛

## Scope

- Broaden explicit delegation parser for Grok wrapper before entering ACP runtime.
- Keep delegation deterministic and alias-based.
- Do not connect local hub or production hub.
- Do not publish preview tarball.

## Commands

```bash
cd agent-node
bun test src/cli-explicit-delegation.test.ts
bun build src/cli.ts --outdir /tmp/agent-node-grok-delegation-build --entry-naming cli.js --target node --minify --external @anthropic-ai/claude-agent-sdk --external '@anthropic-ai/claude-agent-sdk-*' --external @openai/codex-sdk
```

## Result

- `cli-explicit-delegation.test.ts`: 8 pass / 0 fail
- `bun build src/cli.ts`: PASS

## Notes

- Docker smoke is intentionally left to the assigned 5-case Docker gate.
- Parser tests cover 6 hit cases and 2 miss cases.
