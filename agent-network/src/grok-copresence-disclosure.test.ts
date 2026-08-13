import { describe, expect, test } from "bun:test";
import { grokCopresenceDisclosure } from "./grok-copresence-disclosure";

describe("grok co-presence disclosure", () => {
  test("default profile reports the exact three tools and no web", () => {
    const disclosure = grokCopresenceDisclosure(undefined, "new");
    const text = disclosure.lines.join("\n");
    expect(disclosure.profile).toBe("commhub-only");
    expect(text).toContain("[todo_write,search_tool,use_tool]");
    expect(text).toContain("No filesystem, shell, web");
    expect(text).toContain("will pin this tool inventory");
    expect(text).not.toContain("web_search is enabled");
  });

  test("WebSearch profile reports general web_search without widening other tools", () => {
    const disclosure = grokCopresenceDisclosure(["WebSearch"], "new");
    const text = disclosure.lines.join("\n");
    expect(disclosure.profile).toBe("x-search");
    expect(text).toContain("[todo_write,search_tool,use_tool,web_search]");
    expect(text).toContain("General web_search is enabled");
    expect(text).toContain("WebFetch, filesystem, shell");
    expect(text).not.toContain("No filesystem, shell, web,");
  });

  test("repo-read profile reports only sandboxed project reads", () => {
    const disclosure = grokCopresenceDisclosure(["Read", "Grep", "Glob"], "new");
    const text = disclosure.lines.join("\n");
    expect(disclosure.profile).toBe("repo-read");
    expect(text).toContain("[todo_write,search_tool,use_tool,read_file,grep,list_dir]");
    expect(text).toContain("strict sandbox");
    expect(text).toContain("essential system paths");
    expect(text).toContain("protected credential paths");
    expect(text).toContain("shell, writes, web/media");
    expect(text).not.toContain("web_search is enabled");
  });

  test("near-match tools are disclosed as invalid rather than a reviewed profile", () => {
    for (const tools of [
      ["websearch"], ["WebSearch", "Bash"], [" WebSearch"],
      ["Read", "Glob", "Grep"], ["Read", "Grep"],
    ]) {
      const disclosure = grokCopresenceDisclosure(tools, "configured");
      expect(disclosure.profile).toBe("invalid");
      expect(disclosure.lines.join("\n")).toContain("startup will fail closed");
    }
  });

  test("resume warns that a changed config cannot mutate the existing session", () => {
    const text = grokCopresenceDisclosure(["WebSearch"], "resume").lines.join("\n");
    expect(text).toContain("keeps the tool inventory from session creation");
    expect(text).toContain("resume cannot apply a later profile change");
    expect(text).toContain("start it with --new-session");
  });
});
