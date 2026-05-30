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
  alias: string;
  status: string;
  task?: string | null;
  runtime?: string | null;
  model?: string | null;
  updated_at?: string;
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
  type: string;
  priority?: string;
  content: string;
  from_session?: string;
  created_at?: string;
};

export type MessagesResp = {
  ok: boolean;
  messages: MessageRow[];
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

export async function* streamEvents(
  alias: string,
  ntok: string,
  networkId: string,
  signal?: AbortSignal
): AsyncGenerator<SseEvent, void, void> {
  const url = `${COMMHUB_URL}/events/${encodeURIComponent(alias)}?network_id=${encodeURIComponent(networkId)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${ntok}` },
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
