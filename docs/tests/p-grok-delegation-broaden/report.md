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
npm run build
bun test src/cli-explicit-delegation.test.ts
bun build src/cli.ts --outdir /tmp/agent-node-grok-delegation-build --entry-naming cli.js --target node --minify --external @anthropic-ai/claude-agent-sdk --external '@anthropic-ai/claude-agent-sdk-*' --external @openai/codex-sdk
```

## Result

- `npm run build`: PASS
- `cli-explicit-delegation.test.ts`: 11 pass / 0 fail
- `bun build src/cli.ts`: PASS
- package version: `@sleep2agi/agent-node@2.4.6-preview.1`

## Notes

- Docker smoke is intentionally left to the assigned 5-case Docker gate.
- Parser tests cover 9 hit cases and 2 miss cases.
- Vincent UAT catch covered: `你和 A站助手 沟通一下` now parses as alias `A站助手` with child task equal to the original text.
