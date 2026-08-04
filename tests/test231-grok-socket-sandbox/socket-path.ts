import { grokCopresenceSocketPaths } from "/workspace/agent-network/src/grok-copresence-profile";

const paths = grokCopresenceSocketPaths("n_test231", {
  cwd: "/workspace/project",
  home: "/home/tester",
  uid: 1000,
  xdgRuntimeDir: "/run/user/1000",
  platform: "linux",
});

process.stdout.write(`${JSON.stringify(paths)}\n`);
