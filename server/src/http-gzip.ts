// 2026-09-16(Vincent:「发一个消息都要被吞一段时间」「打开窗口历史很久才出来」):
// 桌面端经 RELAY 连 hub,链路实测只有 ~13 KB/s;/api/status?light=1 128 KB 要 17 s,
// 一页 20 条任务 41 KB 要 5.6 s,而 hub 从不压缩。gzip 后 128 KB → 31 KB、137 KB → 49 KB。
// 只在客户端明确 `Accept-Encoding: gzip` 时压;text/event-stream(SSE)与流式 body 一律不碰。
export const GZIP_MIN_BYTES = 1024;

const COMPRESSIBLE = /^(application\/json|text\/(plain|html|css|javascript)|application\/javascript)\b/i;

export function wantsGzip(req: Request): boolean {
  const ae = req.headers.get("accept-encoding") || "";
  for (const part of ae.split(",")) {
    const [coding, ...params] = part.trim().split(";").map((x) => x.trim());
    if (coding.toLowerCase() !== "gzip") continue;
    const q = params.find((x) => /^q=/i.test(x));
    if (!q) return true;
    const n = Number(q.slice(2));
    return Number.isFinite(n) && n > 0;
  }
  return false;
}

export function isCompressibleResponse(res: Response): boolean {
  if (res.status === 204 || res.status === 304 || !res.body) return false;
  if (res.headers.get("content-encoding")) return false;
  const ct = res.headers.get("content-type") || "";
  if (/text\/event-stream/i.test(ct)) return false;
  return COMPRESSIBLE.test(ct);
}

/**
 * Gzip a finished response when the client asked for it and the body is worth it.
 * Reads the body once; callers must not have consumed it. Anything streamed or
 * not compressible is returned untouched (same object).
 */
export async function maybeGzipResponse(req: Request, res: Response | undefined | void): Promise<Response | undefined> {
  if (!res) return res as undefined;
  if (req.method === "HEAD" || !wantsGzip(req) || !isCompressibleResponse(res)) return res;
  const raw = new Uint8Array(await res.arrayBuffer());
  if (raw.byteLength < GZIP_MIN_BYTES) {
    return new Response(raw, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  const gz = Bun.gzipSync(raw);
  const headers = new Headers(res.headers);
  headers.set("Content-Encoding", "gzip");
  headers.set("Content-Length", String(gz.byteLength));
  const vary = headers.get("Vary");
  headers.set("Vary", vary && !/accept-encoding/i.test(vary) ? `${vary}, Accept-Encoding` : (vary || "Accept-Encoding"));
  return new Response(gz, { status: res.status, statusText: res.statusText, headers });
}

/** 轻量列表里的 task 只给列表预览用;全文占了 light 载荷的一半以上。 */
export const LIGHT_TASK_MAX_CHARS = 160;
export function trimLightTask(task: unknown): string | null {
  if (typeof task !== "string") return null;
  const t = task.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > LIGHT_TASK_MAX_CHARS ? `${t.slice(0, LIGHT_TASK_MAX_CHARS)}…` : t;
}
