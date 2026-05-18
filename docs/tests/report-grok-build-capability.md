# Grok Build Capability Probe

Date: 2026-05-18T10:45:34Z
Suite: tests/test-grok-build-capability
Runtime target: grok-build-acp / grok-build-cli
Verdict: **Wait**

## Summary

- PASS: 2
- FAIL: 0
- SKIP: 7
- WARN: 0
- grok version: `grok 0.1.211 (2f2cd6d5c)`
- Credential: `GROK_CODE_XAI_API_KEY` missing

## Results

| Probe | Status | Detail |
|---|---|---|

| grok --version | PASS | grok 0.1.211 (2f2cd6d5c) |
| permission default | PASS | --always-approve is explicit; probe did not enable it |
| API-key-only headless | SKIP | GROK_CODE_XAI_API_KEY not provided |
| grok -p final answer | SKIP | requires GROK_CODE_XAI_API_KEY |
| streaming-json schema | SKIP | requires GROK_CODE_XAI_API_KEY |
| session resume | SKIP | requires GROK_CODE_XAI_API_KEY |
| temp repo file edit | SKIP | requires GROK_CODE_XAI_API_KEY |
| ACP stdio | SKIP | requires GROK_CODE_XAI_API_KEY |
| MCP no-op tool | SKIP | requires GROK_CODE_XAI_API_KEY |

## Fixtures

- streaming JSON: `docs/tests/fixtures/grok-build/streaming-json.jsonl`
- JSON final: `docs/tests/fixtures/grok-build/final.json`
- ACP stdio: `docs/tests/fixtures/grok-build/acp-stdio.jsonl`
- MCP no-op: `docs/tests/fixtures/grok-build/mcp-noop.jsonl`

## Notes

- This suite installs Grok Build inside Docker using the official installer URL: `https://x.ai/cli/install.sh`.
- If `GROK_CODE_XAI_API_KEY` is absent, authenticated probes are skipped and the verdict remains Wait.
- The probe does not enable `--always-approve` by default. Permission behavior is inspected separately.
