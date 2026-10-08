# Codex bridge package download

The Codex app-server / co-presence launcher resolves its exact paired
`@sleep2agi/agent-node` before starting the bridge. A first npm download can be
slow behind a company proxy. The default resolution budget is 300,000 ms.

Set `ANET_AGENT_NODE_RESOLVE_TIMEOUT_MS=600000` in the launching environment
to allow ten minutes, then run your existing `anet node start <alias>` command.
The value must be an integer from 1 to 2147483647 milliseconds. This only changes
package resolution, not thread recovery, bridge attachment, or task timeouts.
`HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` in that environment are inherited by
the `npx` subprocess; node-specific `config.env` is not a substitute for the
launcher's environment at this stage. Never put proxy credentials in reports.

On timeout the error prints `npx -y @sleep2agi/agent-node@<exact> --print-entrypoint`
with the actual paired version. Run that command with the same user, proxy and
npm cache, then retry the original start command. No floating `@preview` fallback
or change to package identity validation is introduced. Explicit/pre-resolved
entrypoints do not run this fetch. Other runtimes are unchanged.

This setting does not install a service or change launch scripts, ports,
tunnels, secret sources or database state. Upgrade through the normal published
CLI release path; no production deployment is part of this change. Unset the
variable to restore the default; rolling back the CLI restores the former
120-second limit. Existing conversation and database backups remain necessary
for data recovery; this setting does not create them.
