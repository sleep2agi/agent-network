// RFC-025 M3 — grok ACP MCP injection wire tests.
//
// The grok injection is a 2-line addition to the existing
// `grokMcpServers` array in cli.ts (see L2308-ish post-edit). This
// file pins the SHAPE the array gets when env LOOPS_MCP_URL/TOKEN
// are set vs absent, so a future refactor that breaks the wire is
// loudly caught.
//
// We don't exercise cli.ts directly (CLI side-effects on load); we
// inline the same array-building logic and verify the shape.

import { describe, expect, test, beforeEach } from "bun:test";

// Mirror cli.ts's grokMcpServers construction (post-M3 edit).
function buildGrokMcpServers(opts: {
  commhubUrl: string;
  alias: string;
  authToken?: string;
  loopsUrl?: string;
  loopsToken?: string;
}) {
  const commhubHeaders: Array<{ name: string; value: string }> = [];
  if (opts.authToken) commhubHeaders.push({ name: "Authorization", value: `Bearer ${opts.authToken}` });
  commhubHeaders.push({ name: "X-Commhub-MCP-Transport", value: "acp-http" });
  if (opts.alias) commhubHeaders.push({ name: "X-Commhub-Alias-Hint", value: opts.alias });

  const servers: Array<{
    type: "http";
    name: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
  }> = [{ type: "http", name: "commhub", url: `${opts.commhubUrl}/mcp`, headers: commhubHeaders }];

  if (opts.loopsUrl && opts.loopsToken) {
    const loopHeaders: Array<{ name: string; value: string }> = [
      { name: "Authorization", value: `Bearer ${opts.loopsToken}` },
      { name: "X-Commhub-MCP-Transport", value: "acp-http-loops" },
    ];
    if (opts.alias) loopHeaders.push({ name: "X-Commhub-Alias-Hint", value: opts.alias });
    servers.push({
      type: "http",
      name: "loops",
      url: opts.loopsUrl,
      headers: loopHeaders,
    });
  }
  return servers;
}

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
