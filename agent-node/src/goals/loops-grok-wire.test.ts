// RFC-025 M3 — grok ACP MCP injection wire tests.
//
// Post-M4-extraction these tests import the REAL `buildGrokMcpServers`
// export (was pre-extraction an inline mirror of cli.ts logic — which
// silently drifted any time cli.ts was edited; 通信龙 #306 nit caught).

import { describe, expect, test } from "bun:test";
import { buildGrokMcpServers } from "./loops-grok-wire";

describe("grok ACP MCP injection — RFC-025 M3 wire", () => {
  test("when LOOPS env unset, only commhub server (back-compat)", () => {
    const r = buildGrokMcpServers({
      commhubUrl: "http://hub:9200",
      alias: "grok-agent",
      authToken: "ntok_xyz",
    });
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("commhub");
  });

  test("when LOOPS env set, commhub + loops servers both present", () => {
    const r = buildGrokMcpServers({
      commhubUrl: "http://hub:9200",
      alias: "grok-agent",
      authToken: "ntok_xyz",
      loopsUrl: "http://127.0.0.1:53412/mcp",
      loopsToken: "test-token",
    });
    expect(r).toHaveLength(2);
    expect(r[0].name).toBe("commhub");
    expect(r[1].name).toBe("loops");
  });

  test("loops server entry: ACP http schema (type+url+headers array)", () => {
    const r = buildGrokMcpServers({
      commhubUrl: "http://hub:9200",
      alias: "grok-agent",
      loopsUrl: "http://127.0.0.1:53412/mcp",
      loopsToken: "test-token",
    });
    const loops = r[1];
    expect(loops.type).toBe("http");
    expect(loops.url).toBe("http://127.0.0.1:53412/mcp");
    expect(Array.isArray(loops.headers)).toBe(true);
  });

  test("loops headers: Authorization Bearer <token> + transport tag + alias hint", () => {
    const r = buildGrokMcpServers({
      commhubUrl: "http://hub:9200",
      alias: "grok-agent",
      loopsUrl: "http://127.0.0.1:53412/mcp",
      loopsToken: "secret-token-x",
    });
    const loopHeaders = r[1].headers;
    const findHdr = (n: string) => loopHeaders.find((h) => h.name === n)?.value;
    expect(findHdr("Authorization")).toBe("Bearer secret-token-x");
    expect(findHdr("X-Commhub-MCP-Transport")).toBe("acp-http-loops");
    expect(findHdr("X-Commhub-Alias-Hint")).toBe("grok-agent");
  });

  test("loops entry localhost URL only (per security constraint)", () => {
    // The URL is supplied by the parent process's started HTTP server
    // (which itself binds 127.0.0.1). Sanity pin: don't pass non-
    // localhost URLs through the wire — even if env says 0.0.0.0 or
    // public IP, the START side bound 127.0.0.1 so the env-stored
    // URL also starts with 127.0.0.1 by construction.
    const r = buildGrokMcpServers({
      commhubUrl: "http://hub:9200",
      alias: "grok-agent",
      loopsUrl: "http://127.0.0.1:53412/mcp",
      loopsToken: "x",
    });
    expect(r[1].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  });

  test("loops + commhub independent: commhub headers don't leak token, loops headers don't leak ntok", () => {
    const r = buildGrokMcpServers({
      commhubUrl: "http://hub:9200",
      alias: "grok-agent",
      authToken: "ntok_commhub",
      loopsUrl: "http://127.0.0.1:53412/mcp",
      loopsToken: "loops_random",
    });
    const commhubAuth = r[0].headers.find((h) => h.name === "Authorization")?.value;
    const loopsAuth = r[1].headers.find((h) => h.name === "Authorization")?.value;
    expect(commhubAuth).toBe("Bearer ntok_commhub");
    expect(loopsAuth).toBe("Bearer loops_random");
    expect(commhubAuth).not.toBe(loopsAuth);
  });
});

describe("grok ACP MCP injection — #693 upload stdio", () => {
  test("adds stdio commhub_upload when uploadMcpCommand provided", () => {
    const servers = buildGrokMcpServers({
      commhubUrl: "http://127.0.0.1:9200",
      alias: "g1",
      authToken: "ntok_abc",
      uploadMcpCommand: "bun",
      uploadMcpArgs: ["/app/upload-file-mcp-stdio.js"],
      nodeDir: "/home/x/.anet/nodes/n1",
    });
    expect(servers.length).toBe(2);
    const up = servers[1] as any;
    expect(up.name).toBe("commhub_upload");
    expect(up.command).toBe("bun");
    expect(up.args).toEqual(["/app/upload-file-mcp-stdio.js"]);
    expect(up.env.some((e: any) => e.name === "COMMHUB_TOKEN" && e.value === "ntok_abc")).toBe(true);
    expect(up.env.some((e: any) => e.name === "ANET_NODE_DIR")).toBe(true);
    // no type field on stdio variant
    expect(up.type).toBeUndefined();
  });
});
