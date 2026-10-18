# Standalone executable

This is an install path that does not go through npm: one file is `anet`, and running it does not require Node, npm, or Bun to be installed first. It does not replace the npm packages. `release.yml` still publishes `@sleep2agi/agent-network`, `@sleep2agi/agent-node`, and `@sleep2agi/commhub-server`.

This phase has **no public download**. The workflow's `publish` input defaults to off. The macOS artifact is unsigned and notarized by nobody, so it is not an installable release.

## What is inside

The build compiles un-obfuscated TypeScript. It does not compile the obfuscated `dist/bin/anet.cjs` shipped in the npm package.

| You run | What starts |
|---|---|
| `anet …` | CLI (`agent-network/bin/cli.ts`) |
| `anet __hub …` | Embedded Hub (`server/bin/commhub.ts`) |
| `anet __node …` | Embedded agent-node (`agent-node/src/cli.ts`) |

`anet hub start` in the binary starts the embedded Hub (`__hub`). It does not run `bunx @sleep2agi/commhub-server@…`. `anet node start` starts the embedded agent-node (`__node`). An npm install still uses `bunx` and the on-disk `agent-node`.

`anet --version` prints the three package versions and a separate bundle version for that build:

```text
anet v<agent-network package.json>
standalone bundle v<version passed to the workflow>

✓ agent-node v<agent-node package.json>
✓ commhub-server v<commhub-server package.json>
```

The three package versions come from the commit that was compiled. The bundle version is the workflow `version` input and may differ. `anet hub start --version` with any version other than the embedded commhub-server version is refused.

## How to build

On main, dispatch [cli-binary.yml](https://github.com/sleep2agi/agent-network/blob/main/.github/workflows/cli-binary.yml) for the full 40-character SHA of that commit. When `publish=true`, the SHA must be an ancestor of `main` at that moment.

```bash
SHA=   # git rev-parse origin/main, 40 hex characters
VERSION=   # bundle version for the GitHub release cli-bin-v<version>; this is not an npm publish

gh workflow run cli-binary.yml --ref main \
  -f commit="$SHA" \
  -f version="$VERSION" \
  -f publish=false
```

The same call as an API request:

```bash
gh api --method POST \
  repos/sleep2agi/agent-network/actions/workflows/cli-binary.yml/dispatches \
  -f ref=main \
  -f inputs[commit]="$SHA" \
  -f inputs[version]="$VERSION" \
  -f inputs[publish]=false
```

The matrix has two legs and `fail-fast` is off:

- `linux-x64` on `ubuntu-24.04`, target `bun-linux-x64`
- `darwin-arm64` on `macos-14`, target `bun-darwin-arm64`

Each leg runs `anet --version`, `--help`, `anet __node --help`, and `anet __hub` until `/health` answers, rejects a file over 110MB, and writes a SHA256. The build gets a GitHub provenance attestation.

When `publish=true` and both legs are green, the workflow writes `SHA256SUMS` and `anet-bin-manifest.json` (version, per-target file / sha256 / size, source commit, and the three package versions) and uploads them to the GitHub release `cli-bin-v<version>`. An existing tag fails the job. It does not replace the release.

## Limits

- The **claude-agent-sdk** platform binary (about 235MB) is not in this file. The first use of that runtime still downloads it the way it does today.
- **node-pty** is not in this file (there is no Linux prebuild to embed). Runtimes that need it still fetch it on demand.
- **@openai/codex** and **@openai/codex-sdk** are not in this file.
- **tmux, claude, codex, opencode, and grok** stay user-installed. The binary replaces the anet, Hub, and agent-node processes only.
- Codex and similar runtimes start the CommHub MCP server as `bun .anet/node-server.js`. The script body is embedded and written to the project's `.anet/node-server.js`. **Starting that MCP server still needs `bun` on `PATH`.** `claude-agent-sdk` and `grok-build-acp` inject CommHub in-process and do not use that file.
- The binary ignores `ANET_AGENT_NODE_BIN`. The embedded agent-node is the one from this commit. It cannot be pointed at a different `.js` entry.
- `linux-arm64`, `darwin-x64`, and `windows-x64` are not built. There is no Windows Authenticode certificate, so this phase does not compile Windows.

## Signing

The darwin artifact has no Developer ID signature and no notarization. Gatekeeper blocks it after a browser or GitHub release download. CI smokes the file on the runner, before quarantine. **Do not document clearing the quarantine attribute as the install path.** A macOS build for users waits until notarization exists.

The secrets for that are not configured: `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, and the App Store Connect API values `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY` (or `APPLE_ID` plus `APPLE_APP_SPECIFIC_PASSWORD`). A Windows Authenticode certificate does not exist yet either.

## Next

1. Sign and notarize macOS. Add Windows to the matrix after a certificate exists.
2. Add `linux-arm64` and `darwin-x64`.
3. Mirror the signed files on ModelScope under `cli/<version>/`.
4. Point the desktop daemon fallback table at a fixed URL plus sha256, the same digests as `anet-bin-manifest.json`.
5. Optionally ship the file as a Tauri `externalBin`. Until then the desktop app keeps its current install path.
