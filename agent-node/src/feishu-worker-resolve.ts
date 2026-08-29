// Feishu worker path resolution. Pure — no side effects, no fs reads.
// Callers apply `existsSync` (or a test double) to the candidate list.
//
// Kept in its own file so the unit test does not import `cli.ts` (which
// has side-effectful module-level boot code — hub registration, goals
// scheduler startup, etc.). See issue #1379.

import { dirname, join } from "path";

/**
 * Compute candidate paths for the agent-network feishu worker script.
 *
 * Search order:
 *   1. `ANET_FEISHU_WORKER_PATH` env override (explicit).
 *   2. Dev sibling checkout: agent-node and agent-network laid out as siblings.
 *   3. Installed npm package layout (worker lives in @sleep2agi/agent-network).
 *   4. Global npm prefix layouts (POSIX `<prefix>/lib/node_modules` + Windows
 *      `<prefix>/node_modules`) — for the very common case where the user
 *      has `@sleep2agi/agent-network` installed globally and `anet node start`
 *      is running `agent-node` via `npx` (npx cache dir has no sibling
 *      agent-network because agent-node's package.json does not declare it
 *      as a dependency). Issue #1379.
 */
export function computeFeishuWorkerCandidates(opts: {
  here: string;
  envOverride?: string | undefined;
  npmConfigPrefix?: string | undefined;
  nodeExecPath?: string | undefined;
}): string[] {
  const { here, envOverride, npmConfigPrefix, nodeExecPath } = opts;
  const candidates: string[] = [];
  if (envOverride) candidates.push(envOverride);
  candidates.push(
    // dev sibling: ../../agent-network/{dist|src}/src/im/feishu/worker.{js|ts}
    join(here, "..", "..", "agent-network", "dist", "src", "im", "feishu", "worker.js"),
    join(here, "..", "..", "agent-network", "src", "im", "feishu", "worker.ts"),
    // installed npm package (agent-network and agent-node share node_modules root)
    join(here, "..", "..", "..", "@sleep2agi", "agent-network", "dist", "src", "im", "feishu", "worker.js"),
    // deeper node_modules layout (some hoisting setups)
    join(here, "..", "..", "..", "..", "@sleep2agi", "agent-network", "dist", "src", "im", "feishu", "worker.js"),
  );
  // Derive global npm prefix candidates. Two sources — either can be absent.
  //   • `npm_config_prefix` — set by npm when invoked; often unset in bare shells.
  //   • `process.execPath` — always set. Under POSIX global installs the node
  //     binary lives at `<prefix>/bin/node`; under Windows / some Linux distros
  //     it lives at `<prefix>/node`. Try both parents.
  const globalPrefixes: string[] = [];
  if (npmConfigPrefix) globalPrefixes.push(npmConfigPrefix);
  if (nodeExecPath) {
    const execDir = dirname(nodeExecPath);            // e.g. /usr/local/bin
    globalPrefixes.push(execDir);                      // Windows-style: <prefix>
    globalPrefixes.push(dirname(execDir));             // POSIX-style: <prefix>/bin → <prefix>
  }
  for (const prefix of globalPrefixes) {
    candidates.push(join(prefix, "lib", "node_modules", "@sleep2agi", "agent-network", "dist", "src", "im", "feishu", "worker.js"));
    candidates.push(join(prefix, "node_modules", "@sleep2agi", "agent-network", "dist", "src", "im", "feishu", "worker.js"));
  }
  return candidates;
}
