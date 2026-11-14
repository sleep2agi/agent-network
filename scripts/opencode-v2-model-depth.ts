#!/usr/bin/env bun
// #4822. No service discovery/start, config mutations, prompts, or credentials in output.
import { resolve } from "node:path";
import { readOpenCodeV2CatalogEndpoint } from "../agent-node/src/runtime/opencode-v2-catalog-endpoint";
import { readOpenCodeModelDepth } from "../agent-node/src/runtime/opencode-v2-catalog";

async function main() {
  const [nodeWorkDir, sessionId, ...extra] = process.argv.slice(2);
  if (!nodeWorkDir || !sessionId || extra.length) {
    throw new Error("Usage: bun scripts/opencode-v2-model-depth.ts <node-work-dir> <ses_id>");
  }
  const endpoint = readOpenCodeV2CatalogEndpoint(resolve(nodeWorkDir));
  if (!endpoint) throw new Error("No private OpenCode V2 endpoint record for this node; no server was started.");
  const result = await readOpenCodeModelDepth({
    ...endpoint, sessionId,
    scope: { networkId: "local-diagnostic", daemonId: "local-diagnostic", directory: endpoint.directory },
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "OpenCode V2 model/depth read failed");
  process.exitCode = 1;
});
