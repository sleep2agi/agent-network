import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// These modules must build independently in the CLI and runtime npm packages.
// Never patch only one copy of the no-follow/identity boundary.
for (const name of ["opencode-preset", "opencode-runtime-binding", "opencode-owner-mode", "posix-modes"]) {
  test(`OpenCode daemon/CLI security helper parity: ${name}`, () => {
    expect(readFileSync(new URL(`../../agent-node/src/shared/${name}.ts`, import.meta.url), "utf8"))
      .toBe(readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8"));
  });
}
