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
  /**
   * 2026-10-31 —— **join 的前提是这条日志真的写下来了。**
   *
   * 生产者（我们）给一个短 id，写进 body + 响应头 + 服务端日志；
   * 消费者（用户/另一个 agent）只需要把它念回来。
   *
   * 没有它的时候，「用户报了一个 500」与「日志里那一行」之间只能靠
   * 时间 ± 猜测去 join —— 而时间戳在跨时区/日志滚动后不可用。
   * （反面教材：某系统的 400 出口既不写 sink 也不发 diagnostic id，
   *   于是那个失败在结构上就是**无法 join** 的，只能靠客户端自采集。）
   *
   * ⇒ 判据：**一个错误如果要求人去排查，它必须自带一个能被念回来的 id，
   *  且这个 id 必须真的出现在日志里**（两件事缺一，join 就不成立）。
   */
  error_id: string;
}

/** 短、可念、低碰撞：8 个十六进制字符（32 bit）。它**不是**安全边界，只是关联键。 */
function newErrorId(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

export function serveErrorBody(err: unknown, errorId: string = newErrorId()): ServeErrorBody {
  const raw = err instanceof Error ? err.message : String(err);
  const message = (raw && raw.trim()) ? raw.trim().slice(0, 500) : "internal error";
  return { jsonrpc: "2.0", id: null, error: { code: -32603, message }, ok: false, message, error_id: errorId };
}

/**
 * 日志一行、body 一份、响应头一份 —— **同一个 id**。
 * 三者不一致时，「念回 id」就 join 不上，而那比没有 id 更糟（它会让人以为有记录）。
 */
export function buildServeErrorResponse(err: unknown, log: (line: string) => void = console.error): Response {
  const body = serveErrorBody(err);
  log(`[serve-error] id=${body.error_id} ${body.message}`);
  return new Response(JSON.stringify(body), {
    status: 500,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-error-id": body.error_id,
    },
  });
}
