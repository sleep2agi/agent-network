import { copresenceThreadPlan } from "./codex-copresence-thread";
import { resumeAndVerifyCodexThread, type CodexRecoveryVerification } from "./codex-copresence-recovery";

export const SAFE_CODEX_THREAD_ID = /^[A-Za-z0-9_-]+$/;

async function defaultWebSocketCtor(): Promise<any> {
  const globalCtor = (globalThis as any).WebSocket;
  if (typeof globalCtor === "function") return globalCtor;
  try {
    const undici = await import("undici");
    if (typeof (undici as any).WebSocket === "function") return (undici as any).WebSocket;
  } catch { /* fall through */ }
  throw new Error("no WebSocket available — need Bun / Node 22+ (global WebSocket) or `undici` in node_modules");
}

function alreadyInitialized(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === -32600) return true;
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" && /already initialized/i.test(message);
}

/** Minimal JSON-RPC client used only while bringing up a co-presence app-server. */
export async function createCodexCopresenceThread(
  ws: string,
  timeoutMs: number,
  resumeThreadId?: string,
  model?: string,
  injectedWebSocketCtor?: any,
): Promise<{ threadId: string; verification?: CodexRecoveryVerification; freshDeferred: boolean; resumedModel?: string }> {
  const WsCtor = injectedWebSocketCtor ?? await defaultWebSocketCtor();
  const socket = new WsCtor(ws);
  const deadline = Date.now() + timeoutMs;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ws open timeout on ${ws}`)), Math.max(1, deadline - Date.now()));
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", (event: any) => { clearTimeout(timer); reject(new Error(`ws error: ${event?.message || event}`)); }, { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
  socket.addEventListener("message", (event: any) => {
    let message: any;
    try { message = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString()); } catch { return; }
    if (typeof message?.id !== "number" || message.method) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) {
      const rpcError = new Error(`${message.error.code}: ${message.error.message}`);
      (rpcError as Error & { code?: number }).code = message.error.code;
      request.reject(rpcError);
    } else request.resolve(message.result);
  });
  const request = (method: string, params: any, requestTimeoutMs: number) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`request ${method} timeout`)); }, requestTimeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  const notify = (method: string, params: any) => socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  try {
    try {
      await request("initialize", { clientInfo: { name: "anet-copresence-creator", title: "creator", version: "0.0.1" } }, 10_000);
      notify("initialized", {});
    } catch (error) {
      if (!alreadyInitialized(error)) throw error;
    }
    const plan = copresenceThreadPlan(resumeThreadId);
    if (plan.method !== "thread/resume") return { threadId: "", freshDeferred: true };
    if (!SAFE_CODEX_THREAD_ID.test(plan.params.threadId)) throw new Error("stored threadId has unexpected shape");
    const { resumedModel, ...verification } = await resumeAndVerifyCodexThread(
      plan.params.threadId,
      (method, params) => request(method, params, method === "thread/resume" ? Math.max(1, deadline - Date.now()) : 15_000),
      model,
    );
    return { threadId: plan.params.threadId, verification, freshDeferred: false, resumedModel };
  } finally {
    try { socket.close(); } catch { /* ignore */ }
  }
}
