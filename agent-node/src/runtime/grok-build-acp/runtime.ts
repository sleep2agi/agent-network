import { GrokAcpClient } from "./client";
import { newGrokTurnState, reduceGrokAcpNotification } from "./events";
import type { GrokAcpNotification, GrokTurnState } from "./events";

export interface GrokAcpTurnOptions {
  prompt: string;
  cwd?: string;
  sessionId?: string;
  timeoutMs?: number;
  drainMs?: number;
  binary?: string;
  env?: NodeJS.ProcessEnv;
  onSession?: (sessionId: string) => void | Promise<void>;
  onEvent?: (event: GrokAcpNotification, state: GrokTurnState) => void;
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

    const session = opts.sessionId
      ? await client.request<SessionResponse>("session/load", { sessionId: opts.sessionId, cwd: opts.cwd, mcpServers: [] }, timeoutMs)
      : await client.request<SessionResponse>("session/new", { cwd: opts.cwd, mcpServers: [] }, timeoutMs);

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
