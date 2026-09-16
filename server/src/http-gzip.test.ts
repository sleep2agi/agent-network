import { expect, test } from "bun:test";
import { maybeGzipResponse, wantsGzip, isCompressibleResponse, trimLightTask, GZIP_MIN_BYTES, LIGHT_TASK_MAX_CHARS } from "./http-gzip";

const big = JSON.stringify({ sessions: Array.from({ length: 200 }, (_, i) => ({ alias: `节点${i}`, task: "x".repeat(50) })) });
const json = (body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", ...extra } });
const reqWith = (ae?: string, method = "GET") =>
  new Request("http://hub/api/status?light=1", { method, headers: ae === undefined ? {} : { "Accept-Encoding": ae } });

test("wantsGzip reads Accept-Encoding, including q-values", () => {
  expect(wantsGzip(reqWith("gzip, deflate, br"))).toBe(true);
  expect(wantsGzip(reqWith("br;q=1.0, gzip;q=0.8"))).toBe(true);
  expect(wantsGzip(reqWith("identity"))).toBe(false);
  expect(wantsGzip(reqWith("gzip;q=0"))).toBe(false);
  expect(wantsGzip(reqWith())).toBe(false);
});

test("a large JSON body is gzipped only when the client asked, and round-trips", async () => {
  const out = await maybeGzipResponse(reqWith("gzip"), json(big));
  expect(out!.headers.get("Content-Encoding")).toBe("gzip");
  expect(out!.headers.get("Vary")).toContain("Accept-Encoding");
  const bytes = new Uint8Array(await out!.arrayBuffer());
  expect(bytes.byteLength).toBeLessThan(big.length / 3);
  expect(Number(out!.headers.get("Content-Length"))).toBe(bytes.byteLength);
  expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(big);
  expect(out!.headers.get("Content-Type")).toContain("application/json");

  const plain = json(big);
  expect(await maybeGzipResponse(reqWith(), plain)).toBe(plain); // untouched object
});

test("small, streamed, already-encoded, SSE, 204 and HEAD responses are left alone", async () => {
  const small = json("{\"ok\":true}");
  const outSmall = await maybeGzipResponse(reqWith("gzip"), small);
  expect(outSmall!.headers.get("Content-Encoding")).toBeNull();
  expect(await outSmall!.text()).toBe("{\"ok\":true}");
  expect(GZIP_MIN_BYTES).toBe(1024);

  const sse = new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } });
  expect(isCompressibleResponse(sse)).toBe(false);
  expect(await maybeGzipResponse(reqWith("gzip"), sse)).toBe(sse);

  const encoded = json(big, { "Content-Encoding": "br" });
  expect(await maybeGzipResponse(reqWith("gzip"), encoded)).toBe(encoded);

  const noContent = new Response(null, { status: 204 });
  expect(await maybeGzipResponse(reqWith("gzip"), noContent)).toBe(noContent);

  const head = json(big);
  expect(await maybeGzipResponse(reqWith("gzip", "HEAD"), head)).toBe(head);

  // /api/files downloads: Range replies and attachments keep their exact byte lengths (CI #509/#514 caught this)
  const partial = new Response("x".repeat(4096), { status: 206, headers: { "Content-Type": "text/plain", "Content-Range": "bytes 0-4095/8192" } });
  expect(await maybeGzipResponse(reqWith("gzip"), partial)).toBe(partial);
  const attachment = new Response("y".repeat(4096), { status: 200, headers: { "Content-Type": "text/plain", "Content-Disposition": "attachment; filename=\"a.txt\"" } });
  expect(await maybeGzipResponse(reqWith("gzip"), attachment)).toBe(attachment);

  const binary = new Response(new Uint8Array(4096), { headers: { "Content-Type": "image/png" } });
  expect(await maybeGzipResponse(reqWith("gzip"), binary)).toBe(binary);

  expect(await maybeGzipResponse(reqWith("gzip"), undefined)).toBeUndefined();
});

test("trimLightTask keeps a one-line preview under the cap", () => {
  expect(trimLightTask(null)).toBeNull();
  expect(trimLightTask("   ")).toBeNull();
  expect(trimLightTask("a\n  b")).toBe("a b");
  const long = "字".repeat(LIGHT_TASK_MAX_CHARS + 40);
  const t = trimLightTask(long)!;
  expect(t.endsWith("…")).toBe(true);
  expect([...t].length).toBe(LIGHT_TASK_MAX_CHARS + 1);
  expect(trimLightTask("short")).toBe("short");
});
