// ── SSE Push: 实时推送事件给 Agent ──────────────────
// Agent 连 GET /events/:session → 保持 SSE 长连接
// send_task 写 inbox 后 → pushEvent() → 秒达

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
export function createSSEStream(sessionName: string): Response {
  const encoder = new TextEncoder();
  let ctrl: ReadableStreamDefaultController;

  const stream = new ReadableStream({
    start(controller) {
      ctrl = controller;
      const client: SSEClient = { controller, encoder };

      if (!clients.has(sessionName)) {
        clients.set(sessionName, []);
      }
      clients.get(sessionName)!.push(client);
      console.log(`[${ts()}] SSE ← ${sessionName} connected (${clients.get(sessionName)!.length} clients)`);

      // 发送初始心跳
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected", session: sessionName })}\n\n`));

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
      const arr = clients.get(sessionName);
      if (arr) {
        const idx = arr.findIndex(c => c.controller === ctrl);
        if (idx !== -1) {
          clearInterval((arr[idx] as any)._keepalive);
          arr.splice(idx, 1);
        }
        if (arr.length === 0) clients.delete(sessionName);
        console.log(`[${ts()}] SSE ✕ ${sessionName} disconnected (${arr.length} remaining)`);
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

/** 推送事件给指定 session 的所有 SSE 连接 */
export function pushEvent(sessionName: string, event: Record<string, unknown>): void {
  const arr = clients.get(sessionName);
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
  if (arr.length === 0) clients.delete(sessionName);
}

/** 广播给多个 session */
export function pushBroadcast(sessionNames: string[], event: Record<string, unknown>): void {
  for (const name of sessionNames) {
    pushEvent(name, event);
  }
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
