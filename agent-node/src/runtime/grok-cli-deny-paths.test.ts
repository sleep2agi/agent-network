import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { grokCliDenyPaths } from "./grok-cli-deny-paths";

const CLI_SOURCE = join(import.meta.dir, "..", "cli.ts");

describe("grokCliDenyPaths", () => {
  test("hides the two .anet directories, the node config, and project .mcp.json", () => {
    expect(grokCliDenyPaths({
      projectCwd: "/srv/project",
      userHome: "/home/user",
      nodeConfigPath: "/home/user/.anet/nodes/n1/config.json",
    })).toEqual([
      "/srv/project/.anet",
      "/home/user/.anet",
      "/home/user/.anet/nodes/n1/config.json",
      "/srv/project/.mcp.json",
    ]);
  });

  test("keeps a placeholder when the node has no config file", () => {
    // prepareGrokCliHome filters falsy entries; the caller has always passed
    // `configFilePath || ""`, so preserve that shape rather than quietly
    // changing the arity of what the callee receives.
    const paths = grokCliDenyPaths({ projectCwd: "/srv/p", userHome: "/home/user" });
    expect(paths).toHaveLength(4);
    expect(paths[2]).toBe("");
  });

  test("🔴 issue #885: the isolated GROK_HOME is NOT denied — this is the open gap", () => {
    // This test exists to make the gap *visible and unchangeable in silence*,
    // not to bless it. The isolated state home (`<stateGrokRoot>/<key>`) holds
    // the generated sandbox.toml, requirements.toml, and an `agent_id`
    // credential link, and an approved write tool can currently reach all of
    // them.
    //
    // When someone adds it, this assertion fails and forces them to state the
    // decision here. That is the point: #885 declined to ship the one-line fix
    // precisely because no test watched this list, so the fix could not be
    // reviewed as a behaviour change.
    const paths = grokCliDenyPaths({
      projectCwd: "/srv/p",
      userHome: "/home/user",
      nodeConfigPath: "/home/user/.anet/nodes/n1/config.json",
    });
    expect(paths.some((p) => p.includes(".anet-grok"))).toBe(false);
  });
});

describe("cli.ts call sites", () => {
  const source = readFileSync(CLI_SOURCE, "utf8");

  test("every denyPaths argument comes from grokCliDenyPaths", () => {
    // 🔴 The defect class this guards is "one of the two call sites drifts".
    // Asserting only that the helper is imported would pass while a literal
    // array sat next to it, so assert on the *shape at the call site*: after
    // `denyPaths:` there must be a call to the helper, never an array literal.
    const literals = source.match(/denyPaths:\s*\[/g) ?? [];
    expect(literals).toHaveLength(0);

    const viaHelper = source.match(/denyPaths:\s*grokCliDenyPaths\(/g) ?? [];
    // Both spawn paths (the co-presence leader and prepareRuntime) must be
    // covered. If a third appears, this number is meant to be updated
    // deliberately rather than by accident.
    expect(viaHelper).toHaveLength(2);
  });
});
