// #695 —— Bun.serve 没注册 `error` 回调时,fetch 处理器抛出的异常会变成 Bun 的默认 500,
// body 不是 JSON;MCP 客户端于是只能报一个泛化的 -32603,拿不到任何一句人话。
// 这里把异常变成一个带 message 的 JSON 响应:/mcp 的客户端按 JSON-RPC 形状读 error.message,
// REST 客户端按本仓其它路由的 { ok:false, error, message } 形状读。
// 🔴 判据(#695 末评):同一个异常,响应里要带**那个异常的 message**,不是一个固定 JSON。

export interface ServeErrorBody {
  jsonrpc: "2.0";
  id: null;
  error: { code: -32603; message: string };
  ok: false;
  message: string;
}

export function serveErrorBody(err: unknown): ServeErrorBody {
  const raw = err instanceof Error ? err.message : String(err);
  const message = (raw && raw.trim()) ? raw.trim().slice(0, 500) : "internal error";
  return { jsonrpc: "2.0", id: null, error: { code: -32603, message }, ok: false, message };
}

export function buildServeErrorResponse(err: unknown): Response {
  const body = serveErrorBody(err);
  return new Response(JSON.stringify(body), {
    status: 500,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
