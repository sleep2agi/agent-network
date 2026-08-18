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

function deniedTools(result: ProbeResult): string[] {
  return result.args.flatMap((value, index) => result.args[index - 1] === "--deny" ? [value] : []);
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
      const denied = deniedTools(result);
      for (const tool of [
        "run_terminal_command", "run_terminal_cmd", "search_replace", "write_file",
        "edit_file", "apply_patch", "write", "kill_command_or_subagent",
        "get_command_or_subagent_output", "wait_commands_or_subagents", "scheduler_create",
        "scheduler_delete", "scheduler_list", "monitor", "update_goal", "enter_plan_mode",
        "exit_plan_mode", "ask_user_question", "web_fetch", "http_request", "image_gen",
        "image_edit", "generate_image", "video_gen", "generate_video", "browser", "computer",
        "screenshot",
      ]) expect(denied).toContain(tool);
      for (const tool of [
        "run_terminal_command", "read_file", "search_replace", "list_dir", "grep",
        "kill_command_or_subagent", "todo_write", "get_command_or_subagent_output",
        "wait_commands_or_subagents", "scheduler_create", "scheduler_delete", "scheduler_list",
        "monitor", "search_tool", "use_tool", "update_goal", "enter_plan_mode", "exit_plan_mode",
        "ask_user_question", "web_search", "web_fetch", "image_gen", "image_edit", "video_gen",
        "write",
      ]) {
        expect(result.tools.includes(tool) || denied.includes(tool)).toBe(true);
      }
      expect(denied).toContain("Bash");
      expect(denied).toContain("Write");
      expect(denied).toContain("WebFetch");
      expect(denied).toContain("Read(/runtime/private)");
      expect(denied).toContain("Grep(/runtime/private/**)");
    }
    for (const tool of ["read_file", "grep", "list_dir", "web_search"]) {
      expect(deniedTools(restricted)).toContain(tool);
    }
    for (const tool of ["read_file", "grep", "list_dir"]) expect(deniedTools(xSearch)).toContain(tool);
    expect(deniedTools(xSearch)).not.toContain("web_search");
    expect(deniedTools(repoRead)).not.toContain("read_file");
    expect(deniedTools(repoRead)).not.toContain("grep");
    expect(deniedTools(repoRead)).not.toContain("list_dir");
    expect(deniedTools(repoRead)).toContain("web_search");
  });
});
