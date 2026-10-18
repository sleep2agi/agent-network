# Daemon-managed Provider at Codex node creation (#906)

This slice initializes a **fresh Codex co-presence child with an API-key profile**
already stored in its owning Daemon. It does not clone a ChatGPT login, perform
OAuth, discover model entitlements, or claim a running/native node from a
configuration receipt. Existing creation without this opt-in is unchanged.

The creation request contains only identifiers:

```json
{
  "runtime": "codex-app-server",
  "model": "configured-model",
  "flags": {
    "copresence": true,
    "daemonProvider": {
      "revision": 1,
      "provider_id": "custom",
      "auth_id": "work",
      "model": "configured-model"
    }
  }
}
```

The Hub and Daemon reject unknown/malformed flags and mismatched models. An older
component rejects this new flag rather than silently launching with a default.
The Daemon writes its normal fresh child configuration, records the child in its
local workdir registry, then invokes the **pinned local CLI**:
`anet daemon provider initialize <daemon>` with scoped identifiers on stdin.
The CLI resolves paths locally, checks the stored Provider revision and model,
and writes private node `.env`, isolated `codex-home/config.toml`, and config
references before launch. The API key never travels in this create request or
argv. A failed initialization prevents launch. Only the existing runtime startup
gate may subsequently acknowledge a running child.

An exact initialization replay reads matching local metadata/configuration
without rewriting credentials. It does not prove runtime health or guarantee no
later launcher attempt. Files are atomically replaced individually; this is not
a cross-file transaction. Failed fresh children may retain protected partial
configuration for inspection/cleanup; no existing live node is an initialization
target. Do not blindly retry using a different profile or identity.

## Recovery coordinates

1. **Startup:** authoritative creation handler is
   `agent-node/src/runtime/create-node-daemon.ts`; local initialization is
   `agent-network/src/daemon-provider-initialize.ts`, dispatched by
   `agent-network/bin/cli.ts`. Existing Daemon launcher/deployment remains unchanged.
2. **Ports/routing:** no new listener, tunnel, or proxy. Existing Hub `create_node`
   request and Daemon SSE/pending-reconcile paths deliver the request.
3. **Secrets:** API keys come only from the owning Daemon's private Provider store;
   templates and Hub requests contain identifiers, never keys. Fresh child files
   are private. ChatGPT credentials must not be copied from another identity.
4. **Upgrade/verify:** merge first, then rebuild CLI/runtime/Hub from exact main
   source via the existing formal release gates. Verify reported versions and
   actual scoped initialization receipt; configuration-only is not inference.
   No new published minimum version is claimed by this branch.
5. **Rollback:** retain the previous installation/configuration before software
   replacement. Rollback of software does not undo newly initialized node files;
   inspect the exact fresh child and restore its protected backup if applicable.
   Never remove a shared Codex home or rewrite a running node for rollback.
6. **Data:** Provider credentials, child config, local workdir registry and Codex
   sessions are private state, not reproduced by clone. Recover from authorized
   protected backups or explicitly recreate profiles/identities. This Docker
   suite rehearses synthetic fresh-child initialization, not production recovery.

Run the bounded core suite with
`sg docker -c 'sh tests/test906-provider-create/run.sh'`.
