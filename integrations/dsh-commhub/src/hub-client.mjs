// CommHub node-side client: MCP tool calls over POST /mcp and the per-alias
// SSE doorbell at GET /events/<alias>. Same wire contract agent-node uses.
// The node token is held in a closure and never logged or returned.

const PROTOCOL = "2025-03-26";

export class HubError extends Error {
  constructor(message, { status, tool } = {}) {
    super(message);
    this.name = "HubError";
    this.status = status;
    this.tool = tool;
  }
}

function parseEnvelope(raw) {
  try { return JSON.parse(raw); } catch { /* SSE-framed body */ }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(\{.*\})\s*$/);
    if (m) return JSON.parse(m[1]);
  }
  return null;
}

/**
 * @param {{hub: string, token: string, networkId?: string, clientVersion?: string,
 *          fetch?: typeof fetch, timeoutMs?: number}} opts
 */
export function createHubClient(opts) {
  const hub = String(opts.hub || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(hub)) throw new Error("dsh-commhub: hub must be an http(s) URL");
  if (!opts.token) throw new Error("dsh-commhub: node token is required");
  const token = opts.token;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let sessionId = null;
  let rpcId = 0;

  const headers = () => ({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL,
    Authorization: `Bearer ${token}`,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });

  async function initialize() {
    sessionId = null;
    const res = await doFetch(`${hub}/mcp`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        jsonrpc: "2.0", id: ++rpcId, method: "initialize",
        params: { protocolVersion: PROTOCOL, capabilities: {},
          clientInfo: { name: "dsh-commhub", version: opts.clientVersion ?? "0" } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new HubError(`initialize: HTTP ${res.status}`, { status: res.status });
    sessionId = res.headers.get("mcp-session-id");
    await res.text();
  }

  async function callOnce(tool, args) {
    const res = await doFetch(`${hub}/mcp`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        jsonrpc: "2.0", id: ++rpcId, method: "tools/call",
        params: { name: tool, arguments: { ...(opts.networkId ? { network_id: opts.networkId } : {}), ...args } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    return { res, raw };
  }

  /** Call a hub MCP tool; returns the parsed JSON payload. Throws HubError on ok:false. */
  async function call(tool, args = {}) {
    if (!sessionId) await initialize();
    let { res, raw } = await callOnce(tool, args);
    // A restarted hub forgets MCP sessions: re-initialize once and retry.
    if (res.status === 404 || res.status === 400) {
      await initialize();
      ({ res, raw } = await callOnce(tool, args));
    }
    if (res.status === 401) throw new HubError(`${tool}: unauthorized (node token rejected)`, { status: 401, tool });
    const env = parseEnvelope(raw);
    if (!env) throw new HubError(`${tool}: empty response (HTTP ${res.status})`, { status: res.status, tool });
    if (env.error) throw new HubError(`${tool}: ${String(env.error.message ?? JSON.stringify(env.error)).slice(0, 300)}`, { status: res.status, tool });
    const text = env.result?.content?.[0]?.text;
    let payload = env.result;
    if (typeof text === "string") {
      try { payload = JSON.parse(text); } catch { payload = { ok: true, text }; }
    }
    // An offline target is not a failure: the hub answers ok:false + queued:true
    // with a message id, and delivers when the target comes back.
    if (payload && payload.ok === false && payload.queued === true) return { ...payload, ok: true, queued: true };
    if (payload && payload.ok === false) {
      throw new HubError(`${tool}: ${payload.error ?? payload.message ?? "failed"}`, { status: res.status, tool });
    }
    return payload;
  }

  /**
   * Async iterator over SSE events for `alias`. Ends when the stream closes;
   * the caller owns reconnect/backoff.
   */
  async function* events(alias, signal) {
    const res = await doFetch(`${hub}/events/${encodeURIComponent(alias)}`, {
      headers: { Accept: "text/event-stream", "Cache-Control": "no-cache", Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok || !res.body) throw new HubError(`events: HTTP ${res.status}`, { status: res.status });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try { yield JSON.parse(line.slice(6)); } catch { /* ignore malformed frame */ }
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
  }

  return { call, events, hub };
}
