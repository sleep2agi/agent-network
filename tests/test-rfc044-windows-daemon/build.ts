import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../..");
function bun(args: string[], cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
bun(["build", "agent-network/bin/cli.ts", "--outdir", "agent-network/dist/bin", "--target", "node", "--external", "@sleep2agi/commhub-server", "--external", "bun:sqlite", "--external", "../../server/*"]);
mkdirSync(resolve(root, "agent-network/dist/bin"), { recursive: true });
copyFileSync(resolve(root, "agent-network/bin/anet.cjs"), resolve(root, "agent-network/dist/bin/anet.cjs"));
bun(["build", "agent-network/src/node-server.ts", "--outdir", "agent-network/dist/src", "--target", "node"]);
bun(["run", "build"], resolve(root, "agent-node"));
