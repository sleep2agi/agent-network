# OpenCode V2 CommHub startup readiness (#539 / #832)

Scope: the pinned `@opencode/cli@2.0.22` preview runtime, still requiring the
existing unsafe-tools opt-in. This change does not enable V2 safe mode.

## Startup and ownership

The authoritative launcher remains `agent-node/src/runtime/opencode-copresence/runtime.ts`.
V2 MCP wiring embeds a dependency-free promise plugin from `v2-readiness.ts`
into a random, mode-0700 directory under the fresh private `XDG_DATA_HOME`.
Its `index.js` is mode 0600. No server-local script or additional download is
needed: the plugin source is part of the built runtime bundle.

After HTTP/auth health, before session creation or a TUI launcher/ready log,
the runtime requires both MCP connection and the final transformed tool list
containing `commhub_send_task` and `commhub_get_task`. Connection alone is not
sufficient. The plugin's authenticated RPC returns only `{ready:boolean}`;
it cannot execute tools or accept arbitrary tool names. No model warmup,
fixed-delay fallback or bypass on an unavailable observer is allowed.

The MCP observation phase has a positive finite startup budget covering HTTP
and response-body reads. It aborts on deadline or serve death even when a
transport ignores AbortSignal. It rechecks connection after registry success;
this is a startup observation, not a guarantee against future disconnects.
Post-readiness reconnect/recovery remains the existing runtime lifecycle.

## V2 capability decision (#828)

Decision recorded on 2026-10-09 for **`@opencode/cli@2.0.22` only**:
retain the explicit unsafe-tools preview gate. Native deny experiments are
not enough to offer an ANet default safe mode. They do not establish an OS
sandbox, nor do they constrain code that runs before model-tool dispatch.

| Capability | Observed evidence | Supported conclusion / limit |
| --- | --- | --- |
| Native shell/read/write/edit deny | Six configurations, 24 forced calls and six unauthenticated API refusals in [test828 policy](../tests/report-test828.txt) | Inline deny and project deny refused execution with unchanged/absent sentinels. Inline deny over project allow also refused. This is a pinned upstream experiment, not the product's safe preset. |
| Rule ordering and V1 environment switches | The same policy probe | A later matching allow executes; V1 deny environment switches do not override V2 inline allow. Do not copy V1 policy or infer safety from a deny rule's presence alone. |
| CommHub dispatch and receipt identity | [test828 MCP](../tests/report-test828-mcp.txt) | The controlled model called the real isolated Hub with the node's identity; sender spoofing was refused without a task write. The test used all-allow permissions and catalog discovery, not a selective safe policy or autonomous paid-model behavior. |
| Cold first-turn MCP availability | [test832 main restack](../tests/report-test832-main-restack.txt) | Three cold starts at 0/1200/3500 ms passed dispatch, identity and receipt checks. Missing tools, authentication refusal and startup deadline stop before model usage. Startup readiness does not promise permanent availability. |
| CLI lifecycle and generated observer cleanup | [test827 main restack](../tests/report-test827-main-restack.txt) and the stronger cleanup replay in [test832 main restack](../tests/report-test832-main-restack.txt) | Isolated Linux CLI/Hub/TUI start, receipt and stop were exercised. This does not accept native Windows/macOS clients, production rollout or complete backup restoration. |
| Default safe mode / hostile tasks | Not established by these suites | **Unsupported for V2.** Keep refusing V2 without explicit unsafe-tools opt-in; do not default, inherit or auto-retry that consent. Use only trusted workspaces and tasks in the preview. |

Before changing the last row, separately verify selective CommHub allow
without local-tool escape, plugin/local MCP execution before permissions,
user-global and managed configuration, agent-specific/saved permissions,
reload/discovery overrides, and filesystem/network/process isolation. A
passing identity test cannot stand in for any of these checks. Missing
evidence keeps the existing gate closed; it is not permission to broaden it.

The CLI/daemon/client entrypoints and signed client release have their own
acceptance under #829 and #539. Daemon create now rejects an explicit
generation whose installed `opencode --version` is not an accepted pin for
that generation, and requires a native `provider/model` for V2. Provider
presets and the signed client release remain separate. Package publication
or a merged UI patch does not change this capability decision. The table
consolidates existing evidence; it makes no new upstream-version or
registry-availability claim.

## Restore, validate and roll back

1. Restore the repository and an approved exact-main runtime release using the
   existing [co-presence runbook](opencode-tui-copresence.md). Branch builds are
   test-only; this document is not a release announcement.
2. Keep the existing loopback `serve` and Hub MCP endpoint topology. This adds
   no public port, proxy or tunnel. The private RPC is inside the authenticated
   V2 API on that same loopback port.
3. Node credentials still come from the existing node registration/configuration
   source and selected provider credentials from the node-local auth store.
   The plugin contains no credential. MCP uses the existing environment-token
   reference, not a token literal in inline configuration.
4. Validate the installed exact version and run `tests/test832-opencode-v2-registry`
   in Docker. Its real isolated Hub/native V2 first model turn must dispatch,
   preserve sender/recipient IDs and fetch the recipient's terminal receipt.
   Check missing-tool/auth/deadline negatives before accepting readiness.
5. Stop through the existing runtime close path before changing version.
   Startup failure reaps serve; the outer launcher removes its own instructions
   and the existing identity-checked launch-root cleanup removes the plugin.
   Close retries the same identity/live-process guarded cleanup for up to five
   seconds of waiting (at most 50 retries) while the attached TUI exits. Every
   retry revalidates ownership and live references; it never force-deletes or
   signals extra processes. Persistent live/unknown references leave the root
   in place with a warning, for the existing later stale-root sweep. This adds
   no service, configuration, port, credential source or persistent state.
   Cleanup defers if a live descendant still owns that root. Roll back to a
   previously approved exact-main release via the same existing procedure.
6. Hub tasks, identities and other persistent business state are not in Git;
   they still require the deployment's established encrypted data backups or
   re-registration. The generated observer has no persistent data to restore.

No production configuration or data migration is part of this change. The
isolated tests are not a complete disaster-recovery exercise and do not prove
that a production backup exists or is restorable.
