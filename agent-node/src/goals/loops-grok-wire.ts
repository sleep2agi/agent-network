// RFC-025 M3 — pure helper that builds the ACP `mcpServers` array
// injected into Grok via `session/new` (see cli.ts processWithGrok).
//
// Extracted from cli.ts so M4 unit tests can assert against the REAL
// export — pre-extraction the test file mirrored the build logic
// inline, which silently drifts the day cli.ts changes. Pure function
// = no env reads, no side effects; caller injects every input.
//
// Behavior is byte-identical to the inline pre-extraction version
// (verified by the existing 6 wire tests still passing after the
// extraction). Shape pinned by `loops-grok-wire.test.ts`.

export interface GrokMcpHeader {
  name: string;
  value: string;
}

export interface GrokMcpServerEntry {
  type: "http";
  name: string;
  url: string;
  headers: GrokMcpHeader[];
}

export interface BuildGrokMcpServersOpts {
  commhubUrl: string;
  alias: string;
  authToken?: string;
  loopsUrl?: string;
  loopsToken?: string;
}

export function buildGrokMcpServers(opts: BuildGrokMcpServersOpts): GrokMcpServerEntry[] {
  const commhubHeaders: GrokMcpHeader[] = [];
  if (opts.authToken) {
    commhubHeaders.push({ name: "Authorization", value: `Bearer ${opts.authToken}` });
  }
  commhubHeaders.push({ name: "X-Commhub-MCP-Transport", value: "acp-http" });
  if (opts.alias) {
    commhubHeaders.push({ name: "X-Commhub-Alias-Hint", value: opts.alias });
  }

  const servers: GrokMcpServerEntry[] = [{
    type: "http",
    name: "commhub",
    url: `${opts.commhubUrl}/mcp`,
    headers: commhubHeaders,
  }];

  if (opts.loopsUrl && opts.loopsToken) {
    const loopHeaders: GrokMcpHeader[] = [
      { name: "Authorization", value: `Bearer ${opts.loopsToken}` },
      { name: "X-Commhub-MCP-Transport", value: "acp-http-loops" },
    ];
    if (opts.alias) {
      loopHeaders.push({ name: "X-Commhub-Alias-Hint", value: opts.alias });
    }
    servers.push({
      type: "http",
      name: "loops",
      url: opts.loopsUrl,
      headers: loopHeaders,
    });
  }

  return servers;
}
