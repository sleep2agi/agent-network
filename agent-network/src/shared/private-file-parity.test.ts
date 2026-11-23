import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #3812 —— "is this secret file private to the current user" must give the same answer whether
// `anet` (this package) or agent-node asks. The two packages cannot import each other, so the
// module is copied byte for byte and this gate goes red when one side changes without the other.
const HERE = import.meta.dir;
const AGENT_NODE = join(HERE, "..", "..", "..", "agent-node", "src", "shared");
const NAME = "private-file.ts";

describe("#3812 the private-file module is byte-identical across packages", () => {
  test(NAME, () => {
    const ours = readFileSync(join(HERE, NAME), "utf8");
    const theirs = readFileSync(join(AGENT_NODE, NAME), "utf8");
    expect(ours.length).toBeGreaterThan(500);
    expect(ours).toBe(theirs);
  });

  test("depends on node builtins only — that is what makes the copy possible", () => {
    const specs = readFileSync(join(HERE, NAME), "utf8").split("\n")
      .map((line) => /^\s*import[^"']*from\s+["']([^"']+)["']/.exec(line)?.[1])
      .filter((spec): spec is string => !!spec);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec.startsWith("node:")).toBe(true);
  });

  test("no caller still judges the shared OpenCode password file by mode bits", () => {
    const cli = readFileSync(join(HERE, "..", "..", "bin", "cli.ts"), "utf8");
    expect(cli).toContain("const passwordVerdict = isPrivateFile(passwordFile);");
    expect(cli).not.toMatch(/passwordStat\.mode & 0o077/);
    for (const rel of ["cli.ts", join("runtime", "opencode-shared-server-registry.ts")]) {
      const src = readFileSync(join(AGENT_NODE, "..", rel), "utf8");
      expect(src).not.toMatch(/passwordStat\.mode & 0o077/);
      expect(src).toContain("assertPrivateFile(");
    }
  });
});
