import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import { GROK_COPRESENCE_PROFILE_ENV } from "./profile-selection";

interface ProbeResult {
  profile: string;
  tools: string[];
  sandboxProfile: string;
  args: string[];
  renderedProfile: string;
  automaticTools: Record<string, { human: boolean; network: boolean }>;
  toolNearMisses: Array<[string, boolean]>;
}

function probe(profile: "commhub-only" | "x-search" | "repo-read"): ProbeResult {
  const child = spawnSync(process.execPath, [join(import.meta.dir, "profile-process-probe.ts")], {
    encoding: "utf8",
    env: { ...process.env, [GROK_COPRESENCE_PROFILE_ENV]: profile },
  });
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout);
}

describe("Grok co-presence profile is pinned for the whole process", () => {
  test("same input yields three exact, non-overlapping process capabilities", () => {
    const restricted = probe("commhub-only");
    const xSearch = probe("x-search");
    const repoRead = probe("repo-read");

    expect(restricted.profile).toBe("commhub-only");
    expect(restricted.tools).toEqual(["todo_write", "search_tool", "use_tool"]);
    expect(restricted.sandboxProfile).toBe("anet-test232-workspace");
    expect(restricted.args).toContain("--disable-web-search");
    expect(restricted.renderedProfile).not.toContain("  - web_search");
    expect(restricted.automaticTools).toEqual({
      todo_write: { human: true, network: true },
      search_tool: { human: true, network: true },
      use_tool: { human: true, network: true },
    });

    expect(xSearch.profile).toBe("x-search");
    expect(xSearch.tools).toEqual(["todo_write", "search_tool", "use_tool", "web_search"]);
    expect(xSearch.sandboxProfile).toBe("anet-test232-workspace");
    expect(xSearch.args).not.toContain("--disable-web-search");
    expect(xSearch.renderedProfile).toContain("  - web_search");
    expect(xSearch.renderedProfile).toContain("not an x.com-only network sandbox");
    expect(xSearch.automaticTools.web_search).toEqual({ human: true, network: true });

    expect(repoRead.profile).toBe("repo-read");
    expect(repoRead.tools).toEqual([
      "todo_write", "search_tool", "use_tool", "read_file", "grep", "list_dir",
    ]);
    expect(repoRead.sandboxProfile).toBe("anet-test232-strict");
    expect(repoRead.args).toContain("--disable-web-search");
    expect(repoRead.renderedProfile).toContain("strict sandbox");
    for (const tool of ["read_file", "grep", "list_dir"]) {
      expect(repoRead.automaticTools[tool]).toEqual({ human: true, network: true });
    }

    expect(repoRead.toolNearMisses).toEqual([
      ["web_search2", false], ["WebSearch", false], [" web_search", false],
      ["web_search ", false], ["web-search", false], ["web_search\n", false],
      ["ｗｅｂ＿ｓｅａｒｃｈ", false], ["not_web_search", false],
      ["read_file2", false], ["Read", false], ["read-file", false], [" grep", false],
      ["list_dir ", false], ["list_directory", false],
    ]);

    for (const result of [restricted, xSearch, repoRead]) {
      const denied = result.args.flatMap((value, index) => result.args[index - 1] === "--deny" ? [value] : []);
      expect(denied).toContain("Bash");
      expect(denied).toContain("Write");
      expect(denied).toContain("WebFetch");
      expect(denied).toContain("Read(/runtime/private)");
      expect(denied).toContain("Grep(/runtime/private/**)");
    }
  });
});
