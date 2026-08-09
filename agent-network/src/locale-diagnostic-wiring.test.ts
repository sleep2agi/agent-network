import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

test("#68 doctor reports the pure locale diagnostic as a warning", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cli = readFileSync(join(here, "..", "bin", "cli.ts"), "utf8");
  expect(cli).toContain('import { diagnoseLocale } from "../src/locale-diagnostic"');
  expect(cli).toContain("const locale = diagnoseLocale(process.env, process.platform);");
  expect(cli).toContain('"System locale",');
  expect(cli).toContain("export LANG=C.UTF-8 LC_ALL=C.UTF-8");
});
