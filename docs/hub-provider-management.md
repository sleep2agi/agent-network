# Hub Provider — implementation slice, not a published release

`daemon_provider_snapshot` now has network-scoped `hub_read`, `hub_put` and
`hub_bind` actions. `hub_read` uses `id=hub` plus `network_id`; `hub_put` uses
`id=provider.id`, CAS `revision`, and the configuration in `provider`;
`hub_bind` uses the source `id`/`revision` and
`provider={daemon_node_id,daemon_revision,confirm:true}`. Existing daemon actions
keep their wire contract. This shares the transport, not the ownership scope.
Metadata and encrypted
credentials are not a local client demo and not a model inference proxy.

- `read`: any authenticated network member reads redacted current-network
  metadata, configured models, protocol and revision. Node tokens are refused.
- `put`: the network owner supplies `revision` and `provider` containing id,
  label, enabled, protocol, HTTPS baseUrl, models and optionally key. Revision0
  creates. Later revisions require CAS. A missing key preserves an existing key
  only when endpoint and protocol are unchanged. No secret is echoed.
- `bind`: owner/admin explicitly confirms an id + source revision, one daemon
  identity and the daemon catalog revision. The response queues encrypted work;
  it is not proof of synchronization. Read the returned request_id using the
  existing `daemon_provider_snapshot` read tool and verify the exact receipt.

The key uses the existing AES-GCM network vault with an opaque network/id-scoped
reference. SQLite saves catalog revision and ciphertext atomically. The existing
short-lived daemon write queue delivers a selected profile over HTTPS/loopback,
never through a command-line argument. The daemon's pinned CLI writes its private
store and returns redacted metadata. Other daemon profiles remain present.

The first adapter is Codex TUI with OpenAI Responses: configured profiles are
managed as `hub_<opaque-id>` / `hub_key`. Chat Completions and Anthropic metadata
can be saved but dispatch is refused until the corresponding adapter lands.
No conversion to Responses, model access test, ChatGPT account copying, automatic
node restart or background distribution is performed. After distribution, use
the existing Daemon Provider selection/apply flow explicitly for an owned node.

Editing, rotating or disabling a source cancels still-pending queued bindings.
This cannot recall a recipient which already fetched the request or remove
installed copies. Revoke a compromised key at its actual provider, then rotate
and explicitly redistribute. Bindings record source revision and target;
installed configurations are not represented as live continuously inherited
references. Full runtime adapters and continuous inheritance remain follow-ups
on #907; this slice does not complete the whole requirement.

## Operations / six recovery coordinates

1. **Startup:** no new service. The checked-in Hub launcher authority is
   `deploy/hub/` (including `hub-provider906.sh` and its README); Daemon startup
   remains `deploy/daemon/` and `docs-site/docs/deploy/daemon.md`.
2. **Topology:** no new port, reverse proxy or tunnel. Existing /mcp uses the
   deployment's authenticated HTTPS routing. Secret distribution requires HTTPS
   or machine-local loopback; existing plaintext remote routes do not qualify.
3. **Secrets:** supply `ANET_HUB_SECRET_VAULT_KEY` from the deployment's secret
   source described in `deploy/hub/README.md`, not Git. Provider keys are owner
   input. No clone or anonymous fixture supplies production credentials.
4. **Upgrade and proof:** only main-built exact-SHA releases may be deployed.
   Inspect actual process/package version, call the real tool, then verify a
   chosen daemon's exact source revision and its catalog receipt. This branch
   creates TEST-ONLY evidence, not a supported published-version claim.
5. **Rollback:** retain the prior software pair and SQLite data backup using
   the existing Hub deployment procedure. Tables are additive; older software
   will not serve this feature. Do not delete catalog/vault data as a rollback
   shortcut. Already distributed keys are not revoked by software rollback.
6. **Data:** encrypted backups must include SQLite catalog, bindings, vault
   ciphertext and its separately protected master key. Each daemon's private
   Provider state requires its own identity-matched encrypted backup. Git
   reconstructs schema/software, not these secrets or data. Backup retention
   and restoration follow the existing deployment authority; no new backup
   service or full empty-machine recovery exercise is claimed here.

Core evidence: `tests/test907-hub-provider/`,
`docs/tests/report-test907-hub-provider.txt`. These use isolated synthetic
credentials/database and the real handlers/CLI, not production inference.

## Saved Hub key references (#1020, implementation continuation)

`hub_put` accepts `provider.secretKeyRef` instead of `provider.key`. The reference
is an existing current-network vault name (`[A-Z][A-Z0-9_]{0,63}`), not an identity
token or a secret value. Supplying both fields or a missing name is refused.
Owner-only saving and explicit per-Daemon distribution are unchanged.

New clients opt into reference metadata with
`hub_read` / `provider={include_secret_refs:true}`. The receipt adds
`secret_reference_supported:true` and each Provider's `secret_key_ref` name,
never its value. Old readers receive the original metadata shape. A client must
not treat an older Hub's successful catalog read as support for reference writes;
Hub `0.9.0-preview.125` is the required release target, not yet a published claim.

Selecting a different reference updates the stored reference atomically with
the configuration revision. Entering a new plaintext key instead detaches to
the Provider's private vault name; it never overwrites a separately named key.
Rotating a named key changes what a **future confirmed bind** reads. It does not
automatically rotate installed Daemons, cancel already fetched writes, apply to
nodes, or revoke a vendor key. Explicitly redistribute as needed.

No new service, port, environment variable or database migration is introduced.
Startup/routing/master-key/backup sources remain the six coordinates above.
Software rollback keeps vault and catalog data; previous Hub catalog/bind code
can read stored references but cannot author this new input. Restore encrypted
database and master key together through the existing backup procedure. The
isolated core fixture checks exact synthetic key bytes in the Daemon's local
application callback, without network inference or production changes.
