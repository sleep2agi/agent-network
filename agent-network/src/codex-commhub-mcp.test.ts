import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexCommhubMcpOverrides, COMMHUB_TOOLS_APPROVAL_KEY } from "./codex-commhub-mcp";

describe("#720 codexCommhubMcpOverrides", () => {
  test("quoted (POSIX launcher): url, bearer env name, commhub tools pre-approved", () => {
    expect(codexCommhubMcpOverrides("http://127.0.0.1:9200", "quoted")).toEqual([
      `mcp_servers.commhub.url="http://127.0.0.1:9200/mcp"`,
      `mcp_servers.commhub.bearer_token_env_var="ANET_CODEX_COMMHUB_TOKEN"`,
      `mcp_servers.commhub.default_tools_approval_mode="approve"`,
    ]);
  });

  test("bare (Windows launcher): no double quotes for cmd.exe to mangle", () => {
    const o = codexCommhubMcpOverrides("http://127.0.0.1:9200", "bare");
    expect(o).toEqual([
      "mcp_servers.commhub.url=http://127.0.0.1:9200/mcp",
      "mcp_servers.commhub.bearer_token_env_var=ANET_CODEX_COMMHUB_TOKEN",
      "mcp_servers.commhub.default_tools_approval_mode=approve",
    ]);
    expect(o.join(" ")).not.toContain('"');
  });

  test("only commhub is pre-approved", () => {
    const approvals = codexCommhubMcpOverrides("http://h", "quoted").filter((o) => o.includes("approval_mode"));
    expect(approvals).toEqual([`${COMMHUB_TOOLS_APPROVAL_KEY}="approve"`]);
    expect(COMMHUB_TOOLS_APPROVAL_KEY.startsWith("mcp_servers.commhub.")).toBe(true);
  });

  // Both co-presence launchers must take the list from this module — a launcher that
  // re-spells the commhub overrides inline would silently lose the pre-approval.
  test("cli.ts launchers use the shared list, no inline commhub -c fragments", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");
    expect(cli.match(/codexCommhubMcpOverrides\(opts\.hub, "(quoted|bare)"\)/g)?.sort()).toEqual([
      'codexCommhubMcpOverrides(opts.hub, "bare")',
      'codexCommhubMcpOverrides(opts.hub, "quoted")',
    ]);
    expect(cli).not.toMatch(/`mcp_servers\.commhub\.(url|bearer_token_env_var)=/);
  });
});
