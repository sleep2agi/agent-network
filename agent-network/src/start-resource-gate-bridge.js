// .js on purpose. The implementation is the byte copy start-resource-gate.ts
// in this package (kept identical to agent-node's file by
// start-resource-gate-sync.test.ts). Importing ../../agent-node breaks every
// Docker image that copies only agent-network/. bun build follows this
// re-export and inlines the gate into dist/bin/cli.js.
export { waitForStartResources } from "./start-resource-gate.js";
