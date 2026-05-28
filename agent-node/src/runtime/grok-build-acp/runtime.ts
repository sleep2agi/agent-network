import { GrokAcpClient } from "./client";
import { newGrokTurnState, reduceGrokAcpNotification } from "./events";
import type { GrokAcpNotification, GrokTurnState } from "./events";

// #204 — ACP `session/new` / `session/load` accepts an mcpServers list. Empty
// list lets Grok CLI fall back to reading `<cwd>/.mcp.json`, which is the
// Vincent 5月28日 UAT bug source (file written once with `COMMHUB_ALIAS=<old>`
// then never refreshed, so every subsequent grok-build-acp node attributes
// outbound send_task as the *old* node). Caller now injects an explicit
// commhub entry per-session, sourced from the current node's identity, so
// stale-file env can't leak in.
//
// preview.3 schema correction (#204 regression): McpServer is an untagged
// serde enum with three variants — Stdio / Http / Sse. The Stdio variant
// has NO `type` discriminator field and uses `env: [{name,value}]` (array
// of EnvVariable, not key→value object). preview.2 wrongly used the
// .mcp.json file format shape (with `type: "stdio"` + object env), which
// failed Grok's serde untagged-enum validation with `-32602 Invalid params
// / data did not match any variant of untagged enum McpServer`. Schema
// reference: @zed-industries/agent-client-protocol@0.4.5
// schema/schema.json → $defs.McpServer.anyOf[Stdio].
export interface AcpEnvVariable {
  name: string;
  value: string;
}
export interface AcpHttpHeader {
  name: string;
  value: string;
}
// #204 preview.6 — supports both Stdio and Http McpServer variants per the
// ACP McpServer untagged enum (schema/schema.json $defs.McpServer.anyOf).
// Stdio path is left in place for `.mcp.json`-like setups; the preferred
// preview.6 transport is **Http**, which avoids spawning a subprocess
// entirely (no bun / node-server.js / framing-mismatch class of bugs that
// preview.2 → preview.5 chain ran into) and lets commhub-server's `/mcp`
// endpoint derive `from_session` directly from the ntok's tokenName
// (server/src/index.ts:446 — `node:<alias>` → callerAlias, the d1d867e
// 通信牛 hub-side bind that #194/#203/#204 all built on).
export type AcpMcpServerEntry =
  | {
      // Stdio variant (legacy, kept for completeness/fallback)
      name: string;
      command: string;
      args: string[];
      env: AcpEnvVariable[];
    }
  | {
      // Http variant — `type` discriminator IS required for Http/Sse per
      // schema (because url+headers field set is shared between them).
      type: "http";
      name: string;
      url: string;
      headers: AcpHttpHeader[];
    };

export interface GrokAcpTurnOptions {
  prompt: string;
  cwd?: string;
  sessionId?: string;
  timeoutMs?: number;
  drainMs?: number;
  binary?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * #204 — explicit MCP server list passed verbatim to `session/new` /
   * `session/load`. When provided, Grok CLI no longer falls back to the
   * cwd `.mcp.json`, so per-node env (COMMHUB_ALIAS / TOKEN / URL /
   * RESUME_ID) is always fresh. Empty list / undefined preserves the
   * pre-#204 behaviour.
   */
  mcpServers?: AcpMcpServerEntry[];
  onSession?: (sessionId: string) => void | Promise<void>;
  onEvent?: (event: GrokAcpNotification, state: GrokTurnState) => void;
  /**
   * #204 preview.4 — Grok agent's stderr stream (handshake errors, MCP
   * subprocess crash logs, etc.). Caller routes this to agent-node's
   * `debug()` / `warn()` so MCP subprocess failures surface in
   * `anet logs <alias>` instead of being silently dropped.
   */
  onStderr?: (chunk: string) => void;
}

export interface GrokAcpTurnResult {
  sessionId: string;
  replyText: string;
  stopReason?: string;
  promptResponse: unknown;
  state: GrokTurnState;
}

interface SessionResponse {
  sessionId?: string;
  session_id?: string;
}

interface InitializeResponse {
  authMethods?: Array<{ id?: string; name?: string }>;
}

/**
 * Run one Grok ACP prompt turn.
 *
 * This is intentionally not wired into agent-node's dispatch yet. It is the
 * smallest reusable adapter surface for Phase 1 integration:
 *   1. initialize ACP,
 *   2. load or create a session,
 *   3. persist the returned durable session id immediately,
 *   4. reduce streamed notifications with replay filtering,
 *   5. return the accumulated reply text.
 */
export async function runGrokAcpTurn(opts: GrokAcpTurnOptions): Promise<GrokAcpTurnResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const drainMs = opts.drainMs ?? 15_000;
  const childEnv = { ...process.env, ...opts.env };
  const client = new GrokAcpClient();
  const state = newGrokTurnState(opts.sessionId);

  const onNotification = (msg: GrokAcpNotification) => {
    reduceGrokAcpNotification(state, msg);
    opts.onEvent?.(msg, state);
  };
  client.on("notification", onNotification);

  // #204 preview.4 — surface grok agent stderr (which carries MCP subprocess
  // handshake errors) to caller so silent MCP-startup failures become
  // visible. Buffered per-line so partial chunks don't truncate words.
  let stderrBuffer = "";
  const onStderr = (chunk: string) => {
    if (!opts.onStderr) return;
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) opts.onStderr(line);
    }
  };
  if (opts.onStderr) client.on("stderr", onStderr);

  try {
    client.start({ cwd: opts.cwd, env: childEnv, binary: opts.binary });

    const init = await client.request<InitializeResponse>("initialize", {
      protocolVersion: "1",
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        // Only advertise capabilities implemented by GrokAcpClient.
        // Claiming terminal support lets Grok send terminal/* client
        // requests, which this adapter cannot satisfy and can surface as
        // generic ACP -32603 internal errors.
        terminal: false,
      },
    }, timeoutMs);
    const authMethod = selectAuthMethod(init, childEnv);
    await client.request("authenticate", { methodId: authMethod, meta: { headless: true } }, timeoutMs);

    // #204 — pass through the caller's mcpServers list; empty array preserves
    // pre-#204 behaviour so existing callers that don't yet build the entry
    // don't change shape silently. When non-empty, this overrides the cwd
    // `.mcp.json` lookup and Grok runs with the per-session env we injected.
    const mcpServers = opts.mcpServers ?? [];
    const session = opts.sessionId
      ? await client.request<SessionResponse>("session/load", { sessionId: opts.sessionId, cwd: opts.cwd, mcpServers }, timeoutMs)
      : await client.request<SessionResponse>("session/new", { cwd: opts.cwd, mcpServers }, timeoutMs);

    const sessionId = extractSessionId(session) ?? opts.sessionId;
    if (!sessionId) throw new Error("Grok ACP session response did not include sessionId");

    state.sessionId = sessionId;
    await opts.onSession?.(sessionId);

    const promptResponse = await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: opts.prompt }],
    }, timeoutMs);
    await waitForPromptDrain(state, drainMs);

    return {
      sessionId,
      replyText: state.replyText,
      stopReason: state.lastStopReason,
      promptResponse,
      state,
    };
  } finally {
    client.off("notification", onNotification);
    if (opts.onStderr) {
      client.off("stderr", onStderr);
      // Flush trailing partial line (if any) so we don't lose the last
      // chunk of stderr output (e.g. an error without a newline).
      if (stderrBuffer.trim()) opts.onStderr(stderrBuffer);
    }
    await client.close().catch(() => undefined);
  }
}

async function waitForPromptDrain(state: GrokTurnState, drainMs: number): Promise<void> {
  if (state.promptComplete || drainMs <= 0) return;
  const started = Date.now();
  while (!state.promptComplete && Date.now() - started < drainMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function selectAuthMethod(init: InitializeResponse, env: NodeJS.ProcessEnv): string {
  const ids = new Set((init.authMethods ?? []).map((method) => method.id).filter((id): id is string => typeof id === "string"));
  if (env.GROK_CODE_XAI_API_KEY && ids.has("xai.api_key")) return "xai.api_key";
  if (ids.has("cached_token")) return "cached_token";
  throw new Error(`Grok ACP authenticate failed: no supported non-interactive auth method (advertised=${JSON.stringify([...ids])})`);
}

function extractSessionId(value: unknown): string | undefined {
  const direct = value && typeof value === "object" ? value as SessionResponse : undefined;
  if (typeof direct?.sessionId === "string") return direct.sessionId;
  if (typeof direct?.session_id === "string") return direct.session_id;
  const result = (value && typeof value === "object" ? (value as { result?: unknown }).result : undefined);
  const nested = result && typeof result === "object" ? result as SessionResponse : undefined;
  if (typeof nested?.sessionId === "string") return nested.sessionId;
  if (typeof nested?.session_id === "string") return nested.session_id;
  return undefined;
}
