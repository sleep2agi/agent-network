import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The secrets loader must run in agent-node itself (most nodes start it
// directly) and in `anet` (the CLI writes the files; the launcher applies them
// to claude-code-cli, which it spawns without agent-node). The two packages
// cannot import each other, so — as with codex-auth-fingerprint.ts (#1918) —
// the file is copied byte-for-byte and this gate keeps the copies equal.
const HERE = import.meta.dir;
const NAME = "node-secrets.ts";

const importSpecs = (src: string): string[] =>
  src.split("\n")
    .map((line) => /^\s*import[^"']*from\s+["']([^"']+)["']/.exec(line)?.[1])
    .filter((spec): spec is string => !!spec);

describe("node-secrets.ts is byte-identical across packages", () => {
  test(NAME, () => {
    const ours = readFileSync(join(HERE, NAME), "utf8");
    const theirs = readFileSync(join(HERE, "..", "..", "agent-node", "src", NAME), "utf8");
    expect(ours.length).toBeGreaterThan(1000);
    expect(ours).toBe(theirs);
  });

  test("depends on node builtins only — that is what makes the copy possible", () => {
    const specs = importSpecs(readFileSync(join(HERE, NAME), "utf8"));
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec.startsWith("node:")).toBe(true);
  });
});
