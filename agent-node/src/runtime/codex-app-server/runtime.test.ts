// RFC-030 — unit tests for the owned codex app-server argv builder.
// Locks the auto-approve wiring (approval_policy / sandbox_mode) and the
// CommHub MCP wiring (url + bearer-token-env-var): passed as `-c` overrides
// only when set, in a stable order, token never in argv, --listen always last.

import { describe, expect, test } from "bun:test";
import { buildOwnedAppServerArgs, COMMHUB_MCP_TOKEN_ENV } from "./runtime";

const URL = "ws://127.0.0.1:24555";

describe("buildOwnedAppServerArgs", () => {
  test("no opts → bare app-server (codex defaults apply)", () => {
    expect(buildOwnedAppServerArgs(URL)).toEqual(["app-server", "--listen", URL]);
  });

  test("approval_policy only → single -c override before --listen", () => {
    expect(buildOwnedAppServerArgs(URL, { approvalPolicy: "never" })).toEqual([
      "app-server", "-c", "approval_policy=never", "--listen", URL,
    ]);
  });

  test("sandbox_mode only → single -c override", () => {
    expect(buildOwnedAppServerArgs(URL, { sandboxMode: "workspace-write" })).toEqual([
      "app-server", "-c", "sandbox_mode=workspace-write", "--listen", URL,
    ]);
  });

  test("auto-approve posture (never + danger-full-access) → both overrides, policy first", () => {
    expect(buildOwnedAppServerArgs(URL, { approvalPolicy: "never", sandboxMode: "danger-full-access" })).toEqual([
      "app-server",
      "-c", "approval_policy=never",
      "-c", "sandbox_mode=danger-full-access",
      "--listen", URL,
    ]);
  });

  test("commhubMcpUrl → adds url + bearer-token-env-var -c overrides", () => {
    const args = buildOwnedAppServerArgs(URL, { commhubMcpUrl: "http://127.0.0.1:9200" });
    expect(args).toEqual([
      "app-server",
      "-c", `mcp_servers.commhub.url="http://127.0.0.1:9200"`,
      "-c", `mcp_servers.commhub.bearer_token_env_var="${COMMHUB_MCP_TOKEN_ENV}"`,
      "--listen", URL,
    ]);
  });

  test("the CommHub bearer TOKEN never appears in argv (only the env-var NAME)", () => {
    const args = buildOwnedAppServerArgs(URL, { commhubMcpUrl: "http://127.0.0.1:9200" });
    const joined = args.join(" ");
    expect(joined).toContain("bearer_token_env_var");
    expect(joined).not.toMatch(/ntok_|utok_|Bearer /);
  });

  test("full production posture (yolo + commhub MCP) → stable order, --listen last", () => {
    const args = buildOwnedAppServerArgs(URL, {
      approvalPolicy: "never", sandboxMode: "danger-full-access", commhubMcpUrl: "http://h/mcp-hub",
    });
    expect(args.slice(0, 7)).toEqual([
      "app-server",
      "-c", "approval_policy=never",
      "-c", "sandbox_mode=danger-full-access",
      "-c", `mcp_servers.commhub.url="http://h/mcp-hub"`,
    ]);
    expect(args[args.length - 2]).toBe("--listen");
    expect(args[args.length - 1]).toBe(URL);
  });
});
