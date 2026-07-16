import { realpathSync, statSync } from "fs";
import {
  validateOpencodePackageBinary,
} from "/repo/agent-network/src/opencode-package-binary";
import {
  resolvePinnedOpencodeBinary,
} from "/repo/agent-node/src/runtime/opencode-acp/binary";

const expectedVersion = "1.18.1";
const project = "/home/bun/project";
const probeCwd = "/home/bun/probe";
const requested = "/home/bun/prefix/node_modules/.bin/opencode";

if (process.getuid?.() !== 1000 || process.getgid?.() !== 1000) {
  throw new Error(`expected uid=gid=1000, got ${process.getuid?.()}:${process.getgid?.()}`);
}

const packageRoot = "/home/bun/prefix/node_modules/opencode-ai";
const groupWritablePaths = [
  "/home/bun/prefix",
  "/home/bun/prefix/node_modules",
  packageRoot,
  `${packageRoot}/bin`,
  `${packageRoot}/package.json`,
  `${packageRoot}/bin/opencode.exe`,
].filter((path) => (statSync(path).mode & 0o020) !== 0);
if (groupWritablePaths.length === 0) {
  throw new Error("fixture did not exercise the private uid=gid group-write policy");
}

const canonical = realpathSync(requested);
const networkBinary = validateOpencodePackageBinary(canonical, {
  expectedVersion,
  forbiddenRoots: [project],
});
if (networkBinary !== canonical) {
  throw new Error("network validator returned a different package entrypoint");
}

const agentNodeBinary = resolvePinnedOpencodeBinary({
  requestedBinary: networkBinary,
  expectedVersion,
  probeCwd,
  forbiddenRoots: [project],
  probeEnv: {
    HOME: "/home/bun",
    PATH: "/home/bun/prefix/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    XDG_CONFIG_HOME: "/home/bun/.config",
    XDG_DATA_HOME: "/home/bun/.local/share",
    XDG_CACHE_HOME: "/home/bun/.cache",
    XDG_STATE_HOME: "/home/bun/.local/state",
  },
});
if (agentNodeBinary !== canonical) {
  throw new Error("agent-node validator returned a different package entrypoint");
}

console.log(`PASS network validator: ${networkBinary}`);
console.log(`PASS agent-node validator + version probe: ${agentNodeBinary}`);
console.log(`PASS private uid=gid group-write paths: ${groupWritablePaths.length}`);
