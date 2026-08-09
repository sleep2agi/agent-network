import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("#633 daemon secret writers all use the private atomic choke point", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "create-node-daemon.ts"), "utf8");
  expect(source).not.toContain("writeFileSync(");
  expect(source).toContain("repairPrivateConfigPermissions(path);");
  expect(source.match(/atomicWriteJson\(/g)?.length).toBe(2);
  expect(source.match(/atomicWritePrivateText\(/g)?.length).toBe(1);
});
