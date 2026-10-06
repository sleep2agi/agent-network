// anet and agent-node each ship this gate. Docker images that copy only one
// package must still resolve it, so the two files are copies, not a cross-import.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

test("anet's start-resource-gate.ts matches agent-node byte for byte", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const anet = readFileSync(join(here, "start-resource-gate.ts"));
  const node = readFileSync(join(here, "../../agent-node/src/runtime/codex-app-server/start-resource-gate.ts"));
  expect(anet.equals(node)).toBe(true);
});
