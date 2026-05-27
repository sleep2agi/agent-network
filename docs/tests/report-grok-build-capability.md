# Grok Build ACP Capability Probe

Date: 2026-05-26T02:38:33Z
Suite: tests/test-grok-build-capability
Runtime target: grok-build-acp
Verdict: **ACP Go**

## Summary

- PASS: 8
- FAIL: 0
- SKIP: 0
- WARN: 0
- grok version: `grok 0.1.219 (c9b7cdec2)`
- auth mode: `host-cache`

## Results

| Probe | Status | Detail |
|---|---|---|

| grok --version | PASS | grok 0.1.219 (c9b7cdec2) |
| auth source | PASS | using read-only mounted ~/.grok cache |
| permission default | PASS | --always-approve exists but probe does not enable it |
| headless auth smoke | PASS | grok -p json succeeded |
| ACP stdio | PASS | initialize/authenticate/session/new/session/prompt/session/update succeeded |
| ACP resume basis | PASS | sessionId captured for future runtime resume |
| permission behavior | PASS | edit requested explicit permission; probe allowed once |
| temp repo file edit | PASS | README.md changed through ACP session |

## Fixtures

- ACP stdio: `docs/tests/fixtures/grok-build/acp-stdio.jsonl`
- ACP summary: `docs/tests/fixtures/grok-build/acp-summary.json`
- headless JSON smoke: `docs/tests/fixtures/grok-build/final.json`
- file edit diff: `docs/tests/fixtures/grok-build/file-edit.diff`

## Notes

- This suite installs Grok Build inside Docker using `https://x.ai/cli/install.sh`.
- Auth precedence: `GROK_CODE_XAI_API_KEY` env, then read-only host cache mount at `/host-grok`, then clean SKIP.
- Host cache files are never copied into the repo or report. Output fixtures are redacted.
- ACP is the primary runtime gate. Headless `grok -p` is only used for install/auth smoke.
- The probe does not enable `--always-approve` by default.
