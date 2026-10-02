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
  // 只压完整的 200:206 Partial Content / Content-Range / 附件下载(Content-Disposition)都有自己的
  // 字节语义(Range 客户端按 Content-Length 数字节),压了就错 —— CI 的 /api/files Range 测试抓到的。
  if (res.status !== 200 || !res.body) return false;
  if (res.headers.get("content-encoding") || res.headers.get("content-range") || res.headers.get("content-disposition")) return false;
  const ct = res.headers.get("content-type") || "";
  if (/text\/event-stream/i.test(ct)) return false;
  return COMPRESSIBLE.test(ct);
}

// 2026-09-30(连接较慢横幅):任务页每 15 s 轮询 ~1 MB 的需求表,每次都在事件循环上同步 gzip 一遍,
// 而两次轮询之间表多半没变。带内容哈希 ETag 的响应(conditionalJson)标一个键,同一份正文只压一次。
// 键就是正文的哈希,所以不同调用者拿到同一份压缩字节是安全的:字节相同 ⇔ 正文相同。
export const GZIP_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const gzipKeys = new WeakMap<Response, string>();
const gzipCache = new Map<string, Uint8Array>();
let gzipCacheBytes = 0;
export const gzipCacheStats = { hits: 0, misses: 0 };

/** 标记这个响应的正文由 `key`(正文的内容哈希)唯一决定:压缩结果可以按键复用。 */
export function markGzipReusable(res: Response, key: string): Response {
  gzipKeys.set(res, key);
  return res;
}

function gzipCached(key: string | undefined, raw: () => Promise<Uint8Array>): Promise<{ raw: Uint8Array | null; gz: Uint8Array | null }> | { raw: null; gz: Uint8Array } {
  if (key) {
    const hit = gzipCache.get(key);
    if (hit) {
      gzipCacheStats.hits++;
      gzipCache.delete(key);
      gzipCache.set(key, hit); // 最近用过的挪到队尾(LRU)
      return { raw: null, gz: hit };
    }
  }
  return raw().then(bytes => {
    if (bytes.byteLength < GZIP_MIN_BYTES) return { raw: bytes, gz: null };
    // 可复用的正文(带键)压一次、存起来、反复发:压缩级别拉到 9 —— 多花的那点 CPU 只花一次,
    // 而线上每次都少发 ~3%(#431 实测:旧节点别名解析读 29.6 KB → 28.6 KB)。不带键的照旧默认级别。
    const gz = key ? Bun.gzipSync(bytes, { level: 9 }) : Bun.gzipSync(bytes);
    if (key) gzipCacheStats.misses++;
    if (key && gz.byteLength <= GZIP_CACHE_MAX_BYTES / 4) {
      gzipCache.set(key, gz);
      gzipCacheBytes += gz.byteLength;
      for (const [k, v] of gzipCache) {
        if (gzipCacheBytes <= GZIP_CACHE_MAX_BYTES) break;
        gzipCache.delete(k);
        gzipCacheBytes -= v.byteLength;
      }
    }
    return { raw: bytes, gz };
  });
}

/** Test-only. */
export function __resetGzipCacheForTest(): void {
  gzipCache.clear();
  gzipCacheBytes = 0;
  gzipCacheStats.hits = 0;
  gzipCacheStats.misses = 0;
}

/**
 * Gzip a finished response when the client asked for it and the body is worth it.
 * Reads the body once; callers must not have consumed it. Anything streamed or
 * not compressible is returned untouched (same object).
 */
export async function maybeGzipResponse(req: Request, res: Response | undefined | void): Promise<Response | undefined> {
  if (!res) return res as undefined;
  if (req.method === "HEAD" || !wantsGzip(req) || !isCompressibleResponse(res)) return res;
  const got = await gzipCached(gzipKeys.get(res), async () => new Uint8Array(await res.arrayBuffer()));
  if (!got.gz) {
    return new Response(got.raw, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  const gz = got.gz;
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
