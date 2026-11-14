# OpenCode V2 model/depth diagnostics (#4822)

## Contract: stock `@opencode/cli` 2.0.22 only

For the HTTP co-presence runtime, a native model selection is
`{providerID, id, variant?}`. Create a session with `model` set to that object;
switch via `POST /api/session/{sessionID}/model` with `{model: selection}`.
`GET /api/session/{sessionID}` returns `data.model`. Subsequent prompts use the
session selection; the depth is not an invented extra prompt field.

Do **not** put `#high` into the HTTP `id`. The CLI's `provider/model#variant`
is a string-selector representation, not the HTTP wire shape. ACP
`session/set_model` is a separate protocol: this work does not establish its
variant encoding or extend the V1/ACP implementation.

Reuse the existing `modelVariant` config-update route and `applyVariantConfig`.
For `{model: "provider/model", modelVariant: "high"}`, the stock co-presence
handle exposes `setSelectedModelAndVariant`, forwarded through the shared wrapper.
It validates the target against the native catalog, performs **one** POST with
the whole model object, then verifies provider, model and depth together. It
never performs two sequential switches or restarts. Older handles without this
method still reject the combination. A model-only switch need not preserve depth.

The existing bounded idle wait remains. A combined request that cannot obtain
local idle returns busy without queueing a depth-only intent for the wrong model.
Concurrent variant writers are rejected; an admitted combined request supersedes
an older queued depth. Ambiguous writes return unknown without automatic replay
or default-model fallback. This is one mutation with verified readback, **not**
an atomic lock against a simultaneous human TUI turn.

If a readback shows the requested model but a different depth, the adapter returns
`{status:"unknown", detail:"model_applied_variant_readback_mismatch"}`. The existing
CLI ack maps unknown to timeout and preserves that detail in `error`; it never
acks applied or introduces a new partial status. This describes observed state,
not proof that a particular writer caused the mismatch. Do not automatically replay.

## One read-only command

From the repository root, with Bun available:

```sh
bun scripts/opencode-v2-model-depth.ts /absolute/path/to/.anet/nodes/NODE ses_SESSION
```

The command reads the existing private (0600) endpoint record. It never starts
or upgrades a server, rewrites configuration, sends a prompt, or prints its
authorization. It returns native provider IDs, model IDs, `availableDepths`,
and the selected session's `current: {provider, model, depth}` in one JSON result.
Current selection is not inferred from the catalog default. Missing depth is
`null` (unknown/unreported); an explicit native `default` remains `default`.
Missing variant metadata is `null`, whereas an explicit empty list is `[]`.
Concurrent selection changes detected across the read fail rather than mix
current values. This is not a transactional catalog snapshot or an ABA guard.

The native server must report exactly 2.0.22; mismatches fail with expected and
observed versions, never silently choose another model. The existing launch pin
is unchanged. The command is local read-only diagnostics, not a Hub network
authorization/projection endpoint; its scope labels are explicitly local.

Catalogs can be incomplete immediately after startup. Metadata availability
does not prove credentials work or the provider can accept a paid request.
`completeness: unknown` and `invocationVerified: false` intentionally remain.
Non-ASCII directory headers retain the existing explicit transport limitation.

## Reproduce transport acceptance

```sh
sg docker -c 'docker build -f tests/test4822-model-depth/Dockerfile -t anet-test4822 .'
sg docker -c 'docker run --rm --network none anet-test4822'
```

The dedicated image installs the fixed package and checks the Linux x64 ELF
SHA256 `32cf5aa0a69a650e36277e3315d189835ddc79fb9aa1d0aef5025be5af5ad122`.
Other architectures require separately reviewed artifact evidence.
The isolated test uses a throwaway HOME, no production credentials, no tmux,
and no crontab. It first runs targeted tests, then starts the stock runtime
with a loopback synthetic Provider. In one session it selects the same model
at `low` and `high`, captures actual `reasoning_effort` values at the Provider,
and checks different Provider-generated response markers in native messages.
It then exercises the production config adapter -> shared wrapper -> combined
writer against that stock server, changes to `fixture/other` + `high`, checks
the Provider request and response, rejects an unlisted depth without changing
the selection, and invokes the diagnostic command to verify the current value.
This proves parameter transport and response routing, not a real
LLM's reasoning quality. No arbitrary existing models are invoked.

## Operational/recovery boundary

This change adds no persistent service, port, proxy, or credentials. Existing
node startup and endpoint-record generation are unchanged. Keep normal node
credentials in the established secret source, never in this diagnostic output.
After rebuilding a host, restore/start its node through the existing runtime
runbook before using this command; a missing record is an error, not authority
to create a replacement server. To roll back diagnostics, use the prior source
revision; no database migration or persistent state rollback is needed. Native
session history still requires its existing data backup. Nothing here authorizes
production deployment or replacement of a shared OpenCode Server.
