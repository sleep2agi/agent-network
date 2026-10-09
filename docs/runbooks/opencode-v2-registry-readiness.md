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
   Cleanup defers if a live descendant still owns that root. Roll back to a
   previously approved exact-main release via the same existing procedure.
6. Hub tasks, identities and other persistent business state are not in Git;
   they still require the deployment's established encrypted data backups or
   re-registration. The generated observer has no persistent data to restore.

No production configuration or data migration is part of this change. The
isolated tests are not a complete disaster-recovery exercise and do not prove
that a production backup exists or is restorable.
