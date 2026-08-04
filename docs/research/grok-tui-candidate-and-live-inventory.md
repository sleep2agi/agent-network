# Grok TUI candidate and live inventory

Snapshot: 2026-08-04 15:05 CST. This document records both Git candidates and
the processes already running from unmerged artifacts. It is an audit record,
not a release approval.

## Git state

| Ref | SHA | Relevant contents | Release status |
| --- | --- | --- | --- |
| `origin/main` | `571781958b1ae3d080991b35fa06072d6c17b0e6` | No `agent-node/src/runtime/grok-copresence` | Mainline, no Grok TUI runtime |
| `origin/preview/grok-build-cli` | `4854928b35c14abaaae788aba7ec043cea10643b` | Grok co-presence runtime and tests 219/224/225; network-only automatic resolution | Unmerged candidate |
| `origin/fix/grok-tui-main-sync-3h` | `4b258b18c2e8ad3742705cd88370e3eb3afed140` | Later candidate line; accepts human-owner automatic resolution | Unmerged candidate |
| `origin/test/grok-copresence-allowlist-near-miss` | `db5a9ed6328a7c290781db28efcac98cb9a4a978` | Malformed-live fail-closed plus 29 exact allowlist tests; still accepts human-owner automatic resolution | Unmerged test candidate |
| `origin/test/537-grok-tui-requalification` | `bee92124cbb38c24c58e0164e5124c5520da1142` | Provenance/requalification evidence, no runtime implementation | Test-only |

The installed candidate used below comes from source commit
`026937d0e2e124292e10b96c6806abb35c8a3eaf` (`Allow repeated fixed Grok TUI
tools`). Its installed package artifacts are:

- `@sleep2agi/agent-network` preview.34:
  `4d7caba296cec3477c2ef9f7a973ad67b81f6b3710f8c9152d66b7d9e92d658a`
- `@sleep2agi/agent-node` preview.26:
  `491d45eac33bcbdb97c0134fec15086da5c6ceb0b7932941796991790b37dd29`

## Live processes from unmerged candidate `026937d0`

| Alias | Node ID | Started | Workspace | TUI / bridge tmux | Runtime source | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `指挥狗` | `n_714cffe2` | 2026-08-01 19:45 CST | `/home/vansin/grok-commanddog-workspace` | `指挥狗` / `指挥狗-node` | `/home/vansin/commniu-grok-candidate-026937d0/runtime` | Online preview; not release-approved |
| `A站GrokTUI` | `n_d3afa188` | 2026-08-04 14:34 CST | `/home/vansin/ai-insight-grok-tui` | `A站GrokTUI` / `A站GrokTUI-node` | `/home/vansin/commniu-grok-candidate-026937d0/runtime` | Online preview; real task `5c153b50-b0ec-4352-a625-0f627d780c0f` replied |

`A站Grok` is also online as a headless `grok-build-cli` Docker node, but its
container image provenance is not `026937d0` and its config does not enable
`grokCopresence`; it is therefore recorded separately rather than counted as a
Grok TUI candidate deployment. The image has no source-commit label, so its
exact source SHA is currently unproven.

## Live safety gaps

The rows above are experience nodes. They must not be described as production
or release-qualified while these gates remain open:

1. **Human-owner automatic resolution is too broad.** In `026937d0`,
   `isGrokPreviewAutomaticResolution()` accepts
   `turnOwner === "network" || turnOwner === "human"`. Human-entered TUI turns
   therefore share the automatic approval path. The `4854928b` line already
   demonstrates the required network-only predicate; the integration
   candidate must retain that boundary and add a negative human-turn test.
2. **Malformed live lifecycle JSONL is fail-open.** In `026937d0`, the live
   parser catches `JSON.parse()` failure and `continue`s. Commit `1dc6a963`
   contains the fail-closed correction and tests, but is not in the installed
   artifact.
3. **Two consumers inject the same task.** The outer `agent-node` bridge and
   the staged generic `node-server.js` both subscribe to SSE, read/ack the same
   inbox and inject the same task. For task `5c153b50...`, both logs record an
   injection at 14:34:59. The staged MCP must become outbound-tools-only;
   `agent-node` must be the sole inbound/lifecycle/presence owner.
4. **The staged MCP overwrites presence identity.** Its heartbeat hardcodes
   `agent: "claude-code"`, guesses tmux via ambient tmux state, and omits
   node/model/session/config identity. This currently makes `A站GrokTUI` appear
   as `TMCode副责人 / claude-code` in status. Removing the second presence
   producer resolves the ownership problem instead of merely making both
   producers write matching fields.

## Reproducible socket-path defect

### Candidate default

`agent-network/src/grok-copresence-profile.ts` in `026937d0` treats an
owner-only `XDG_RUNTIME_DIR` as the first socket root. On this host,
`XDG_RUNTIME_DIR=/run/user/1000`, so `anet node create` persists paths shaped
as:

```text
/run/user/1000/g/<16-hex-key>/l.sock
/run/user/1000/g/<16-hex-key>/a.sock
```

### Why it fails

The Grok workspace sandbox does not admit `/run/user/1000` as a writable path.
Grok therefore cannot create its leader lock/socket and emits `Lock error:
Permission denied`; the bridge later reports that no leader socket exists.
Filesystem ownership of `XDG_RUNTIME_DIR` is not sufficient evidence that the
model process sandbox can write there.

### Working value

The runtime already owns a private, sandbox-admitted per-node state home. The
verified values are:

```text
~/.anet-grok/node-<sha256(node_id)[0:24]>/run/leader.sock
~/.anet-grok/node-<sha256(node_id)[0:24]>/run/attach.sock
```

For `A站GrokTUI` this is:

```text
/home/vansin/.anet-grok/node-c507fc6c0474a6057614c24f/run/leader.sock
/home/vansin/.anet-grok/node-c507fc6c0474a6057614c24f/run/attach.sock
```

The release fix must make creation-time allocation agree with the runtime's
owner-bound state directory and add a real sandbox fresh-session red/green
test with `XDG_RUNTIME_DIR=/run/user/<uid>`. A local config override alone is
not a release fix.

## Required integration gates

- network-owned automatic resolution only; human-owner mutation must turn red;
- malformed/oversized live lifecycle records fail closed;
- preserve the exact-value allowlist and its near-miss mutations;
- staged CommHub MCP is outbound-only, with zero SSE/get-inbox/ack/presence
  traffic;
- exactly one claim, injection, terminal result and ack per task under repeated
  concurrent delivery;
- owner-bound socket allocation survives a true sandbox fresh session;
- three-minute heartbeat does not change alias, tmux, agent, node ID, model or
  session metadata;
- Docker-layered tests plus a real Grok 0.2.93 TUI send/receive run before any
  release or deployment claim.

