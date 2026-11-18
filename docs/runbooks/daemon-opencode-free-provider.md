# Daemon-owned free OpenCode Provider (phase 2, in progress)

## Contract and current boundary

The first-run default is intended to be OpenCode V2 with a keyless free OpenCode
model. This change supplies the Provider storage/discovery primitives, **not yet
the complete first-run launch flow**. Windows admission is deliberately unchanged
until the no-terminal startup and identity-bound teardown lane are implemented
and tested. No default Agent, runtime version or unsafe-tools policy is changed
by these primitives.

Use the existing daemon `provider-store/state.json` (schema 1), bound to its
network and daemon identity; do not put a new Provider registry in a child node.
The additive Provider entry is:

```json
{
  "id": "opencode",
  "label": "OpenCode free",
  "enabled": true,
  "runtimes": [{
    "runtime": "opencode-cli",
    "auth": [{ "id": "free", "kind": "free", "models": ["opencode/<discovered-id>"] }]
  }]
}
```

`models` are cached identifiers, **not price/entitlement evidence**. Production
launch must re-read the daemon's owned, authenticated native `/api/model` in
the target project scope before selecting a model. Existing API-key and saved
subscription entries retain their Codex adapters; this change does not claim
those adapters already work with OpenCode. Free entries reject keys, account
references, custom endpoint URLs and foreign provider IDs. Public snapshots say
`credential_present:false`, `verification:not_checked`, `application:not_applied`.

## Explicit execution consent

App owns the UI explaining file read/write and command execution. The local
caller must pass `unsafeToolsConsent:true` explicitly to resolve a free Provider.
Omission, false, strings or other truthy values do not grant consent. Saving or
discovering a free Provider does not grant it either. The existing node flag
`opencodeUnsafeTools=true` must only be derived from this explicit acceptance in
the forthcoming launch adapter. Do not remove the V2 execution refusal globally.

## Native dynamic discovery

Pin stock `@opencode/cli@2.0.22`; do not auto-upgrade to npm latest. Use the
existing authenticated loopback-only, redirect-denying, bounded reader and the
exact target `x-opencode-directory`. `/api/info` must match the pin. Only return
public model identifiers, never raw model settings/headers/body.

`freeOpenCodeModels` preserves native order and includes only provider `opencode`,
`enabled:true`, nondeprecated recognized statuses, nonempty cost arrays and
numeric zero input/output/cache.read/cache.write in **every** price tier. Missing
costs, unknown costs, strings and partial cache fields are not free. No model-name
heuristic, configured-default fallback or paid fallback is allowed. No candidates
means `opencode_free_model_unavailable`. The snapshot may precede plugin settlement;
the future bootstrap adapter must retry with a fixed deadline, not guess a model.
Catalog candidates are not invocation-verified; the first model reply is separate.

## Rebuild and verification

The independent Dockerfile is `tests/test3636-daemon-opencode-free/Dockerfile`.
It pins Bun/Node base digests and installs OpenCode into a container-private
prefix, not the host. Repository lockfiles provide application dependencies.

```sh
sg docker -c 'docker build -f tests/test3636-daemon-opencode-free/Dockerfile -t anet-daemon-free-provider .'
sg docker -c 'docker run --rm --network none --init anet-daemon-free-provider'
```

Tests run atomic policy/store checks first, then real Hub/compiled CLI Provider
transport, then stock native OpenCode discovery and model stub transport. Fake
model endpoint/cost overrides exist only inside the disposable native fixture;
they are not production price evidence. No free-tier credits or user keys used.
Full daemon task/stop ACK, signed App/GUI/IPC and native Windows/macOS are separate
pending gates; do not infer them from Linux catalog transport green.

## Recovery and rollback boundary

1. No new resident production service/startup script is deployed in this slice.
   The test `serve` process is started/stopped by the fixture only.
2. No reverse proxy, tunnel or production port mapping changes. Test servers bind
   loopback in a networking-disabled container.
3. Free Provider needs no model API key. Native server test authentication is
   fixture-only, not a production secret source. Existing saved accounts/keys
   retain their private daemon custody and backup requirements.
4. Build from the exact repository commit and run the independent Docker suite;
   package/version/default activation remains a separate authorized release.
5. No migration rewrites existing state. Before rolling software back to a build
   without the additive free runtime/kind, remove the new Provider using a capable
   build or restore the pre-change encrypted Provider-store backup. Older readers
   reject unsupported entries; do not claim automatic downgrade compatibility.
6. Git reconstructs software/schema, not user Provider state, private accounts,
   keys or sessions. Those require existing private data backups or re-registration.
   There is no new backup service/location or claim of a full recovery drill here.
