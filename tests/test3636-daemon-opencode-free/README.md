# Daemon OpenCode free Provider: first-layer evidence

Reproduction and contract: [runbook](../../docs/runbooks/daemon-opencode-free-provider.md).

This suite is deliberately staged:

1. Policy and existing daemon Provider-store atomic tests.
2. Real Hub Provider handlers → actual compiled CLI → daemon-owned store.
3. Stock private `@opencode/cli@2.0.22` → native `/api/model` → Provider cache →
   real session and loopback HTTP model stub reply. No tmux/PTY or inherited user
   PATH. No real key or free-tier request. User HOME config sentinel stays intact.

The image uses a container-only `/etc/anet-daemon/path.conf` pointing at the CLI
built from this checkout. It does not modify the host's trusted launcher file.
Runtime networking is disabled; only loopback is available. Atomic failure stops
the later layers. The native fixture's OpenCode Provider endpoint/cost overrides
are test-only; production discovery must never replace prices to label a model
free. This is not full daemon lifecycle/Hub stop ACK or App native acceptance.
