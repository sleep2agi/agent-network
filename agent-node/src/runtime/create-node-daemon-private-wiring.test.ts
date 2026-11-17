import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("#633 daemon secret writers all use the private atomic choke point", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "create-node-daemon.ts"), "utf8");
  expect(source).not.toContain("writeFileSync(");
  // 2026-11-17 (#3627): the global ~/.anet/config.json writer is gone — the daemon
  // no longer writes the user's config at all, so its permission repair went with it.
  expect(source).not.toContain("repairPrivateConfigPermissions(");
  // Child config write plus the private, names-only source marker.
  expect(source.match(/atomicWriteJson\(/g)?.length).toBe(2);
  expect(source).toContain("atomicWriteJson(join(childWorkDir, '.anet', 'nodes', childDirName, 'secrets-source.json'), {");
  expect(source.match(/atomicWritePrivateText\(/g)?.length).toBe(1);
});
