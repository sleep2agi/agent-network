// The exact set of tools a node-server exposes in outbound-only mode.
//
// It lives in its own module for one reason: tests need to assert against it,
// and importing node-server.ts to read a constant BOOTS THE SERVER — it opens
// an MCP stdio connection and starts an SSE listener on import. Verified by
// doing exactly that: `bun -e 'import { OUTBOUND_TOOL_NAMES } from
// "./src/node-server.ts"'` printed `[commhub] MCP stdio connected` before it
// printed the constant. A test harness that boots a live server just to read a
// list is a harness that fails for reasons unrelated to what it tests.
//
// Why a shared constant at all: tests/test235-grok-mcp-outbound-only asserted a
// hard-coded copy of three names. `commhub_upload_file` shipped in #693 and made
// it four, so that assertion has been wrong on main — and nothing reported it,
// because no workflow and neither qa.sh list runs test235.

export const OUTBOUND_TOOL_NAMES = new Set([
  "commhub_send_task",
  "commhub_send_message",
  "commhub_get_all_status",
  "commhub_upload_file",
]);
