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

export type GrokMcpServerEntry =
  | {
      type: "http";
      name: string;
      url: string;
      headers: GrokMcpHeader[];
    }
  | {
      // ACP Stdio variant — no `type` discriminator (untagged enum).
      name: string;
      command: string;
      args: string[];
      env: GrokMcpHeader[]; // reused {name,value} shape
    };

export interface BuildGrokMcpServersOpts {
  commhubUrl: string;
  alias: string;
  authToken?: string;
  loopsUrl?: string;
  loopsToken?: string;
  /** #693 — absolute path to upload-file-mcp-stdio entry (bun/node script). */
  uploadMcpCommand?: string;
  uploadMcpArgs?: string[];
  nodeDir?: string;
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

  // #693 — local stdio MCP: controlled path → Hub /api/upload → file_id.
  // Path safety stays on the agent host; Hub never assumes shared FS.
  if (opts.uploadMcpCommand) {
    const env: GrokMcpHeader[] = [
      { name: "COMMHUB_URL", value: opts.commhubUrl },
    ];
    if (opts.authToken) env.push({ name: "COMMHUB_TOKEN", value: opts.authToken });
    if (opts.alias) {
      env.push({ name: "COMMHUB_ALIAS", value: opts.alias });
      env.push({ name: "ANET_UPLOAD_ALIAS", value: opts.alias });
    }
    if (opts.nodeDir) env.push({ name: "ANET_NODE_DIR", value: opts.nodeDir });
    servers.push({
      name: "commhub_upload",
      command: opts.uploadMcpCommand,
      args: opts.uploadMcpArgs ?? [],
      env,
    });
  }

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
