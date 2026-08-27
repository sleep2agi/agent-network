/// <reference types="vite/client" />

export const COMMHUB_URL: string =
  (import.meta.env.VITE_COMMHUB_URL as string | undefined) ?? "http://localhost:9200";

type FetchOpts = RequestInit & { token?: string | null };

async function call<T>(path: string, opts: FetchOpts = {}): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.headers as Record<string, string> | undefined)
  };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${COMMHUB_URL}${path}`, { ...opts, headers });
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j?.error || JSON.stringify(j);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  return (await res.json()) as T;
}

// ── Hub MCP — Streamable HTTP JSON-RPC helper ──

type McpContentItem = { type: string; text?: string };
type McpToolEnvelope = {
  result?: { content?: McpContentItem[] };
  error?: { message?: string; code?: number; data?: unknown };
};

let mcpRpcId = 1;

async function mcpRpc<T>(token: string, method: string, params?: unknown): Promise<T> {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`
  };
  const res = await fetch(`${COMMHUB_URL}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: mcpRpcId++,
      method,
      ...(params === undefined ? {} : { params })
    })
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${raw}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice(6)) : raw ? JSON.parse(raw) : {};
  if (json.error) {
    throw new Error(json.error.message || JSON.stringify(json.error));
  }
  return json as T;
}

function parseMcpToolPayload<T>(envelope: McpToolEnvelope): T {
  if (envelope.error) {
    throw new Error(envelope.error.message || JSON.stringify(envelope.error));
  }
  const text = envelope.result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text content");
  return JSON.parse(text) as T;
}

export async function callMcpTool<T>(
  token: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  await mcpRpc(token, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "anet-client-app", version: "0.0.1" }
  });
  const envelope = await mcpRpc<McpToolEnvelope>(token, "tools/call", {
    name,
    arguments: args
  });
  return parseMcpToolPayload<T>(envelope);
}

// ── Auth ──

export type LoginResp = {
  ok: boolean;
  token: string;
  user: { id: string; email: string; display_name?: string };
};

export async function login(email: string, password: string): Promise<LoginResp> {
  return call<LoginResp>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

export type NetworksResp = {
  ok: boolean;
  networks: Array<{ id: string; name: string; role: string }>;
};

export function getNetworks(utok: string): Promise<NetworksResp> {
  return call<NetworksResp>("/api/networks", { token: utok });
}

export type NodeTokenResp = {
  ok: boolean;
  token: string;
  network_id: string;
  alias: string;
};

export function getNodeToken(
  utok: string,
  networkId: string,
  alias: string
): Promise<NodeTokenResp> {
  return call<NodeTokenResp>("/api/auth/node-token", {
    method: "POST",
    token: utok,
    body: JSON.stringify({ network_id: networkId, alias })
  });
}

// ── Sessions / nodes ──

export type SessionRow = {
  node_id?: string | null;
  alias: string;
  status: string;
  task?: string | null;
  runtime?: string | null;
  model?: string | null;
  updated_at?: string;
  network_id?: string | null;
};

export type StatusResp = {
  ok: boolean;
  sessions: SessionRow[];
  summary: { idle: number; working: number; offline: number; total: number };
};

export function getStatus(token: string, networkId?: string | null): Promise<StatusResp> {
  const qs = networkId ? `?network_id=${encodeURIComponent(networkId)}` : "";
  return call<StatusResp>(`/api/status${qs}`, { token });
}

export type HostSupervisor = {
  daemon_node_id: string;
  alias: string;
  hostname?: string | null;
  online: boolean;
  last_seen_at?: string | null;
  runtimes_supported: string[];
  allowed_secret_keys: string[];
  host_telemetry?: Record<string, unknown>;
};

export type ListHostSupervisorsResp = {
  ok: boolean;
  daemons: HostSupervisor[];
  count: number;
  error?: string;
};

export function listHostSupervisors(
  token: string,
  networkId?: string | null
): Promise<ListHostSupervisorsResp> {
  return callMcpTool<ListHostSupervisorsResp>(token, "list_host_supervisors", {
    ...(networkId ? { network_id: networkId } : {})
  });
}

export type CreateNodeResp = {
  ok: boolean;
  request_id?: string;
  error?: string;
  message?: string;
};

export function createNode(
  token: string,
  args: {
    daemon_node_id: string;
    name: string;
    runtime: string;
    model: string;
    network_id?: string | null;
  }
): Promise<CreateNodeResp> {
  return callMcpTool<CreateNodeResp>(token, "create_node", {
    daemon_node_id: args.daemon_node_id,
    node_spec: {
      name: args.name,
      runtime: args.runtime,
      model: args.model,
      flags: {},
      channels: []
    },
    ...(args.network_id ? { network_id: args.network_id } : {})
  });
}

export type NodeActionResp = {
  ok: boolean;
  update_id?: string;
  request_id?: string;
  apply_mode?: string;
  lifecycle_state?: string;
  error?: string;
  message?: string;
};

export function restartNode(
  token: string,
  nodeId: string,
  networkId?: string | null
): Promise<NodeActionResp> {
  return callMcpTool<NodeActionResp>(token, "restart_node", {
    node_id: nodeId,
    ...(networkId ? { network_id: networkId } : {})
  });
}

export function stopNode(
  token: string,
  nodeId: string,
  networkId?: string | null
): Promise<NodeActionResp> {
  return callMcpTool<NodeActionResp>(token, "stop_node", {
    child_node_id: nodeId,
    ...(networkId ? { network_id: networkId } : {})
  });
}

// ── Send task / chat ──

export type SendTaskResp = {
  ok: boolean;
  task_id: string;
  message_id: string;
};

export function sendTask(
  token: string,
  args: { alias: string; task: string; from?: string; network_id?: string; priority?: "high" | "normal" | "low" }
): Promise<SendTaskResp> {
  return call<SendTaskResp>("/api/task", {
    method: "POST",
    token,
    body: JSON.stringify({ priority: "normal", ...args })
  });
}

export type MessageRow = {
  id: string;
  session_name: string;
  to_alias?: string;
  from_alias?: string;
  type: string;
  priority?: string;
  content: string;
  from_session?: string;
  acked?: number;
  created_at?: string;
};

export type MessagesResp = {
  ok: boolean;
  messages: MessageRow[];
  pending_count?: number;
};

export function getMessages(
  token: string,
  args: { alias?: string; network_id?: string | null; limit?: number }
): Promise<MessagesResp> {
  const qs = new URLSearchParams();
  if (args.alias) qs.set("alias", args.alias);
  if (args.network_id) qs.set("network_id", args.network_id);
  if (args.limit) qs.set("limit", String(args.limit));
  const path = `/api/messages${qs.toString() ? `?${qs}` : ""}`;
  return call<MessagesResp>(path, { token });
}

// ── SSE — fetch+ReadableStream so we can pass Authorization header ──

export type SseEvent = {
  type: string;
  [k: string]: unknown;
};

async function* readSse(url: string, token: string, signal?: AbortSignal): AsyncGenerator<SseEvent, void, void> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk
        .split("\n")
        .find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const raw = dataLine.slice(6);
      try {
        yield JSON.parse(raw) as SseEvent;
      } catch {
        // skip non-JSON heartbeats
      }
    }
  }
}

export async function* streamEvents(
  alias: string,
  ntok: string,
  networkId: string,
  signal?: AbortSignal
): AsyncGenerator<SseEvent, void, void> {
  const url = `${COMMHUB_URL}/events/${encodeURIComponent(alias)}?network_id=${encodeURIComponent(networkId)}`;
  yield* readSse(url, ntok, signal);
}

export async function* streamUserEvents(
  utok: string,
  networkId: string,
  signal?: AbortSignal
): AsyncGenerator<SseEvent, void, void> {
  const url = `${COMMHUB_URL}/events/users/me?network_id=${encodeURIComponent(networkId)}`;
  yield* readSse(url, utok, signal);
}

// ── Live log — tmux capture-pane ──

export type TmuxResp = {
  ok: boolean;
  alias?: string;
  output?: string;
  error?: string;
};

export async function captureTmux(token: string, alias: string): Promise<TmuxResp> {
  try {
    return await call<TmuxResp>(`/api/tmux/${encodeURIComponent(alias)}`, { token });
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
