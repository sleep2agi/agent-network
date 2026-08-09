import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

test("CLI option and positional parsing share cli-args.ts", () => {
  const source = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");
  expect(source).toContain(
    'import { parseCliOptions, positionalArgs } from "../src/cli-args";',
  );
  expect(source).toContain("return parseCliOptions(args);");
  expect(source).not.toContain("const BOOLEAN_FLAGS = new Set(");
});
