# Test 386 — opencode-cli agent-node launch gate

Docker-only release regression for the stale-global failure mode. It plants a
fake global `agent-node v2.4.13` whose help does not advertise `opencode-cli`,
then places the canonical exact paired global package later on `PATH` and
proves `anet node start` skips the stale entry and launches that exact install.
It separately plants `agent-node@2.5.0-preview.21`, whose help already
advertises `opencode-cli` but whose runtime predates the hardened project,
plugin, and ambient-key boundary, and proves version/package identity—not help
text—rejects it. An explicit `ANET_AGENT_NODE_BIN` cannot bypass the same exact
pair check. The normal fallback scenario also injects a stale OpenCode binary
through profile `PATH` plus forged `ANET_OPENCODE_BIN/VERSION` values and proves
the network launcher overwrites those fields with the pre-profile canonical
1.18.1 identity. The same fixture injects `NODE_OPTIONS`, `BUN_OPTIONS`,
`NODE_V8_COVERAGE`, and `LD_PRELOAD` canaries and proves no profile loader or
pre-entrypoint write hook reaches the exact agent-node process. A final
scenario removes the exact global entry and proves startup hard-fails with an
exact two-package install command without executing `npx`; no stale or
project-local payload is launched in any scenario.
