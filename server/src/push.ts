// ── SSE Push: 实时推送事件给 Agent ──────────────────
// Agent 连 GET /events/:session → 保持 SSE 长连接
// send_task 写 inbox 后 → pushEvent() → 秒达

import { eventBus, type RenameCommittedEvent } from "./event_bus";

type SSEClient = {
  controller: ReadableStreamDefaultController;
  encoder: TextEncoder;
};

// 一个 session 可能有多个 SSE 连接（重连时短暂并存）
const clients = new Map<string, SSEClient[]>();

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** 创建 SSE Response 并注册到 clients map */
export function createSSEStream(sessionName: string, networkId?: string | null): Response {
  const encoder = new TextEncoder();
  let ctrl: ReadableStreamDefaultController;
  const key = clientKey(sessionName, networkId);

  const stream = new ReadableStream({
    start(controller) {
      ctrl = controller;
      const client: SSEClient = { controller, encoder };

      if (!clients.has(key)) {
        clients.set(key, []);
      }
      clients.get(key)!.push(client);
      console.log(`[${ts()}] SSE ← ${key} connected (${clients.get(key)!.length} clients)`);

      // 发送初始心跳
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected", session: sessionName, network_id: networkId ?? null })}\n\n`));

      // Periodic keepalive every 30s to prevent proxy/LB idle timeout
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          clearInterval(keepalive);
        }
      }, 30_000);
      (client as any)._keepalive = keepalive;
    },
    cancel() {
      // 断线清理
      const arr = clients.get(key);
      if (arr) {
        const idx = arr.findIndex(c => c.controller === ctrl);
        if (idx !== -1) {
          clearInterval((arr[idx] as any)._keepalive);
          arr.splice(idx, 1);
        }
        if (arr.length === 0) clients.delete(key);
        console.log(`[${ts()}] SSE ✕ ${key} disconnected (${arr.length} remaining)`);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
}

function clientKey(sessionName: string, networkId?: string | null): string {
  return `${networkId || "global"}:${sessionName}`;
}

function rekeyClient(oldSessionName: string, newSessionName: string, networkId?: string | null): number {
  if (!oldSessionName || !newSessionName || oldSessionName === newSessionName) return 0;
  const oldKey = clientKey(oldSessionName, networkId);
  const newKey = clientKey(newSessionName, networkId);
  const oldClients = clients.get(oldKey);
  if (!oldClients || oldClients.length === 0) return 0;

  const existing = clients.get(newKey) || [];
  clients.set(newKey, existing.concat(oldClients));
  clients.delete(oldKey);
  console.log(`[${ts()}] SSE ↔ rekey ${oldKey} → ${newKey} (${oldClients.length} clients)`);
  return oldClients.length;
}

eventBus.on("rename-committed", (event: RenameCommittedEvent) => {
  try {
    rekeyClient(event.old_alias, event.new_alias, event.networkId);
  } catch (e: any) {
    console.log(`[${ts()}] SSE rekey failed: ${e?.message || e}`);
  }
});

/** 推送事件给指定 session 的所有 SSE 连接 */
export function pushEvent(sessionName: string, event: Record<string, unknown>, networkId?: string | null): void {
  const arr = clients.get(clientKey(sessionName, networkId ?? (event.network_id as string | null | undefined)));
  if (!arr || arr.length === 0) return;

  const data = `data: ${JSON.stringify(event)}\n\n`;
  const dead: number[] = [];

  for (let i = 0; i < arr.length; i++) {
    try {
      arr[i].controller.enqueue(arr[i].encoder.encode(data));
    } catch {
      dead.push(i);
    }
  }

  // 清理死连接
  for (let i = dead.length - 1; i >= 0; i--) {
    arr.splice(dead[i], 1);
  }
  if (arr.length === 0) clients.delete(clientKey(sessionName, networkId ?? (event.network_id as string | null | undefined)));
}

export function __resetSSEClientsForTest(): void {
  clients.clear();
}

/** 获取当前 SSE 连接统计 */
export function getSSEStats(): { total: number; sessions: Record<string, number> } {
  let total = 0;
  const sessions: Record<string, number> = {};
  for (const [name, arr] of clients) {
    sessions[name] = arr.length;
    total += arr.length;
  }
  return { total, sessions };
}
