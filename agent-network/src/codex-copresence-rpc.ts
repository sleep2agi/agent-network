import { copresenceThreadPlan } from "./codex-copresence-thread";
import { resumeAndVerifyCodexThread, type CodexRecoveryVerification } from "./codex-copresence-recovery";
import { formatCopresenceRolloutSize, resolveCopresenceMaxPayloadBytes } from "./codex-copresence-resume-timeout";

export const SAFE_CODEX_THREAD_ID = /^[A-Za-z0-9_-]+$/;
async function defaultWebSocketCtor(maxPayload: number): Promise<any> {
  // Node's built-in WebSocket inherits undici's fixed receive ceiling. Codex
  // 0.133 cannot suppress turns on thread/resume, so a legitimate persisted
  // thread can exceed that ceiling by hundreds of MiB. `ws` lets this
  // loopback-only recovery client lift the ceiling; the overall recovery
  // deadline remains the resource bound. Bun's native client already accepts
  // the measured payload and avoids adding a second implementation there.
  if (!(process.versions as Record<string, string | undefined>).bun) {
    // Keep this runtime-only: source-only smoke images intentionally do not
    // install dependencies before bundling unrelated CLI paths.
    const wsModule = await import(["w", "s"].join(""));
    const NodeWebSocket = wsModule.WebSocket;
    return class CodexRecoveryWebSocket extends NodeWebSocket {
      constructor(url: string) {
        super(url, { maxPayload, perMessageDeflate: false });
      }
    };
  }
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
  options: { webSocketCtor?: any; rolloutBytes?: number | null } = {},
): Promise<{ threadId: string; verification?: CodexRecoveryVerification; freshDeferred: boolean; resumedModel?: string }> {
  const maxPayload = resolveCopresenceMaxPayloadBytes(options.rolloutBytes ?? null);
  const WsCtor = options.webSocketCtor ?? await defaultWebSocketCtor(maxPayload);
  const socket = new WsCtor(ws);
  const deadline = Date.now() + timeoutMs;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ws open timeout on ${ws}`)), Math.max(1, deadline - Date.now()));
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", (event: any) => { clearTimeout(timer); reject(new Error(`ws error: ${event?.message || event}`)); }, { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
  let socketFailure: Error | null = null;
  const rejectPending = (error: Error) => {
    socketFailure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.addEventListener("error", (event: any) => {
    const detail = event?.error?.message || event?.message || String(event?.error || event || "unknown websocket error");
    rejectPending(new Error(`Codex app-server WebSocket failed: ${detail}`));
  });
  socket.addEventListener("close", (event: any) => {
    const reason = typeof event?.reason === "string" && event.reason ? `: ${event.reason}` : "";
    rejectPending(socketFailure ?? new Error(`Codex app-server WebSocket closed (code ${event?.code ?? "unknown"})${reason}`));
  });
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
    if (socketFailure) {
      reject(socketFailure);
      return;
    }
    const id = nextId++;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      pending.delete(id);
      const diagnostic = method === "thread/resume"
        ? ` after ${Date.now() - startedAt}ms (${formatCopresenceRolloutSize(options.rolloutBytes ?? null)})`
        : "";
      reject(new Error(`request ${method} timeout${diagnostic}`));
    }, requestTimeoutMs);
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
      (method, params) => request(method, params, Math.max(1, deadline - Date.now())),
      model,
    );
    return { threadId: plan.params.threadId, verification, freshDeferred: false, resumedModel };
  } finally {
    try { socket.close(); } catch { /* ignore */ }
  }
}
