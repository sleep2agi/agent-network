import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--help") {
  console.log("agent-node runtimes: claude-agent-sdk | codex-sdk | opencode-cli");
  process.exit(0);
}

writeFileSync(
  "/tmp/test386-exact-preview-launch.json",
  JSON.stringify({
    argv,
    executable: process.argv[1],
    opencodeBinary: process.env.ANET_OPENCODE_BIN,
    opencodeVersion: process.env.ANET_OPENCODE_VERSION,
    opencodeSafeBase: process.env.ANET_OPENCODE_SAFE_BASE,
    path: process.env.PATH,
  }, null, 2),
);
