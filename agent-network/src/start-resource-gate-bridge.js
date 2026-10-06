// .js on purpose. A .ts re-export of the agent-node gate would become part of
// this package's program, tsc would infer rootDir as the repo root, and
// dist/src/*.d.ts would move under dist/agent-network/. bun build still
// follows this re-export and inlines the real gate into dist/bin/cli.js.
export { waitForStartResources } from "../../agent-node/src/runtime/codex-app-server/start-resource-gate.js";
