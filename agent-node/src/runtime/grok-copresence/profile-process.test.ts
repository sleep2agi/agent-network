import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import { GROK_COPRESENCE_PROFILE_ENV } from "./profile-selection";

interface ProbeResult {
  profile: string;
  tools: string[];
  args: string[];
  renderedProfile: string;
  automaticWebSearch: { human: boolean; network: boolean };
  webSearchNearMisses: Array<[string, boolean]>;
}

function probe(profile: "commhub-only" | "x-search"): ProbeResult {
  const child = spawnSync(process.execPath, [join(import.meta.dir, "profile-process-probe.ts")], {
    encoding: "utf8",
    env: { ...process.env, [GROK_COPRESENCE_PROFILE_ENV]: profile },
  });
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout);
}

describe("Grok co-presence profile is pinned for the whole process", () => {
  test("same input yields two exact, non-overlapping process capabilities", () => {
    const restricted = probe("commhub-only");
    const xSearch = probe("x-search");

    expect(restricted.profile).toBe("commhub-only");
    expect(restricted.tools).toEqual(["todo_write", "search_tool", "use_tool"]);
    expect(restricted.args).toContain("--disable-web-search");
    expect(restricted.renderedProfile).not.toContain("  - web_search");
    expect(restricted.automaticWebSearch).toEqual({ human: false, network: false });

    expect(xSearch.profile).toBe("x-search");
    expect(xSearch.tools).toEqual(["todo_write", "search_tool", "use_tool", "web_search"]);
    expect(xSearch.args).not.toContain("--disable-web-search");
    expect(xSearch.renderedProfile).toContain("  - web_search");
    expect(xSearch.renderedProfile).toContain("not an x.com-only network sandbox");
    expect(xSearch.automaticWebSearch).toEqual({ human: true, network: true });
    expect(xSearch.webSearchNearMisses).toEqual([
      ["web_search2", false], ["WebSearch", false], [" web_search", false],
      ["web_search ", false], ["web-search", false], ["web_search\n", false],
      ["ｗｅｂ＿ｓｅａｒｃｈ", false], ["not_web_search", false],
    ]);

    for (const result of [restricted, xSearch]) {
      const denied = result.args.flatMap((value, index) => result.args[index - 1] === "--deny" ? [value] : []);
      expect(denied).toContain("Bash");
      expect(denied).toContain("Write");
      expect(denied).toContain("WebFetch");
    }
  });
});
