# Standalone anet executable (runbook)

For maintainers. The user-facing page is on the docs site: [Standalone executable](../docs-site/docs/en/guide/standalone-binary.md) (Chinese: [zh](../docs-site/docs/guide/standalone-binary.md)).

This is an install path beside npm. Do not change `release.yml`, and do not `npm publish` from this workflow. Phase 1 is the build and the smoke only. Do not edit the version constants owned by #906.

## Artifact

`scripts/build-anet-bin.mjs` runs Bun `1.3.14` `bun build --compile --minify` on `agent-network/bin/anet-bin.ts` (un-obfuscated source). For the duration of the compile it rewrites `agent-network/src/standalone-build-stamp.ts`, then restores the committed file (`standalone: false`). Do not commit a stamp whose `standalone` is true.

| argv | Process |
|---|---|
| (default) | CLI |
| `__hub` | Embedded commhub-server |
| `__node` | Embedded agent-node |
| `__print-config-token` | Read `token` from the config.json at `$ANET_EXTAPP_CONFIG` and write it to stdout. Used by the Codex external-appserver pane, which used to run `node -e`. A compiled `anet` is not Node. |

`--external` always leaves out `@anthropic-ai/claude-agent-sdk`, `@openai/codex`, `@openai/codex-sdk`, and `node-pty`.

The first line of `anet --version` is the agent-network package.json version. The next line is `standalone bundle v<bundle>`. The bundle version is the workflow `version` input (locally, `--bundle-version`; omitted, it equals the agent-network version). The agent-node and commhub-server versions come from their own package.json files and are written into the same stamp.

## Dispatch

Workflow: `.github/workflows/cli-binary.yml`. `workflow_dispatch` inputs:

| Input | Meaning |
|---|---|
| `commit` | 40-character SHA. When `publish=true` it must be an ancestor of `origin/main` (`.github/scripts/verify-release-main.sh`, the same script as release.yml) |
| `version` | Bundle version, and the release tag `cli-bin-v<version>` |
| `publish` | Default `false`. A GitHub release is created only when this is `true` and every matrix leg is green |

```bash
gh workflow run cli-binary.yml --ref main \
  -f commit="$SHA" \
  -f version="$VERSION" \
  -f publish=false

gh api --method POST \
  repos/sleep2agi/agent-network/actions/workflows/cli-binary.yml/dispatches \
  -f ref=main \
  -f inputs[commit]="$SHA" \
  -f inputs[version]="$VERSION" \
  -f inputs[publish]=false
```

Do not flip publish to exercise this runbook. The `pull_request` path uses `publish=false` and bundle version `0.0.0-pr`. It compiles the PR and smokes it.

Matrix (`fail-fast: false`): `ubuntu-24.04` + `bun-linux-x64`, `macos-14` + `bun-darwin-arm64`. Bun is pinned the same way as release.yml: `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`, version `1.3.14`.

Each leg checks `anet --version` against the stamp, `--help`, `__node --help`, `__hub` `/health` 200 with `version` equal to the commhub-server package version, size ≤ 110MB, a SHA256 file, and `actions/attest-build-provenance@v2`.

The publish job runs only for `workflow_dispatch` with `publish=true` after both legs succeed. It checks that every leg reports the same three package versions and bundle version, writes `SHA256SUMS` and `anet-bin-manifest.json`, then `gh release create cli-bin-v<version>`. An existing tag fails the job.

## Limits

- The claude-agent-sdk platform binary, node-pty, and the Codex SDK stay external and on demand.
- tmux, claude, codex, opencode, and grok stay user-installed.
- The body of `.anet/node-server.js` comes from text embedded in the binary. Codex and similar runtimes still start it with `bun` on `PATH`. `claude-agent-sdk` and `grok-build-acp` do not use that file.
- The binary ignores `ANET_AGENT_NODE_BIN`.
- Not built: `linux-arm64`, `darwin-x64`, `windows-x64`.

## Signing (skipped in this phase)

The workflow marks those steps as comments. They do not run.

macOS later needs a Developer ID Application certificate and notarization. Secret names: `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY` (or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD`). An unsigned darwin file is smoked on the CI runner only. Gatekeeper blocks it after download. Do not write `xattr -d com.apple.quarantine` as the install instructions.

Windows has no Authenticode certificate, so `windows-x64` is not in the matrix.

## Rollout

1. Sign and notarize macOS. Add Windows after a certificate exists.
2. Add `linux-arm64` and `darwin-x64`.
3. Mirror signed files on ModelScope at `cli/<version>/`.
4. Desktop daemon fallback table: a fixed URL plus the sha256 from the manifest.
5. Optionally a Tauri `externalBin`. The desktop install path stays as it is until then.
