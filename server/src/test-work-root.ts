// A private work root for tests that build fixture packages the runtime will execute.
// The OpenCode/agent-node binary checks refuse anything under a world-writable directory
// such as /tmp (that is the point of those checks), so these fixtures cannot live in
// tmpdir(). They used to live under /work, which no current image provides.
// It must also sit outside the project tree (project-local packages are not trusted either).
// ANET_TEST_WORK_ROOT overrides; default is $HOME/.anet-test-work, mode 0700.
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function testWorkRoot(): string {
  const root = process.env.ANET_TEST_WORK_ROOT ?? join(homedir(), ".anet-test-work");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

export const testWorkPath = (prefix: string) => join(testWorkRoot(), prefix);
