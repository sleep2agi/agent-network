import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _clearDirectStorageCacheForTest, detectCallerCloud, probeHubStorageUploadLimit } from "./direct-storage";
import { uploadControlledLocalFile } from "./controlled-upload";
import { channelAttachmentCacheDir, downloadChannelAttachments } from "./channel-attachments";

const dirs: string[] = [];
const origCloud = process.env.ANET_CALLER_CLOUD;

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (origCloud === undefined) delete process.env.ANET_CALLER_CLOUD;
  else process.env.ANET_CALLER_CLOUD = origCloud;
  _clearDirectStorageCacheForTest();
});

describe("agent-network direct external storage relay (Claude Code channel)", () => {
  test("detectCallerCloud honors ANET_CALLER_CLOUD=aws override", () => {
    process.env.ANET_CALLER_CLOUD = "aws";
    _clearDirectStorageCacheForTest();
    expect(detectCallerCloud()).toBe("aws");
    process.env.ANET_CALLER_CLOUD = "none";
    _clearDirectStorageCacheForTest();
    expect(detectCallerCloud()).toBeUndefined();
  });

  test("probeHubStorageUploadLimit returns configured max_file_bytes when Hub external storage is enabled", async () => {
    const limit = await probeHubStorageUploadLimit({
      hubUrl: "https://hub.example",
      authToken: "ntok_probe_1",
      fetch: (async () => Response.json({
        ok: true,
        configured: true,
        enabled: true,
        max_file_bytes: 150 * 1024 * 1024,
      })) as typeof fetch,
    });
    expect(limit).toBe(150 * 1024 * 1024);
  });

  test("uploadControlledLocalFile uploads directly to S3 via presign -> PUT (with regional fallback) -> complete", async () => {
    process.env.ANET_CALLER_CLOUD = "aws";
    _clearDirectStorageCacheForTest();
    const root = mkdtempSync(join(tmpdir(), "anet-direct-up-"));
    dirs.push(root);
    const filePath = join(root, "report.png");
    const payload = Buffer.from("fake-png-bytes-for-s3-direct-upload");
    writeFileSync(filePath, payload);

    const calls: Array<{ method: string; url: string; cloudHeader: string | null }> = [];
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ method: init?.method || "GET", url, cloudHeader: headers.get("x-anet-caller-cloud") });
      if (url.endsWith("/api/uploads/presign")) {
        return Response.json({
          ok: true,
          mode: "direct",
          provider: "s3",
          file_id: "direct_s3_file_001",
          skip_upload: false,
          upload: { method: "PUT", url: "https://b.s3-accelerate.amazonaws.com/k", headers: { "Content-Type": "image/png" } },
          fallback_upload: { method: "PUT", url: "https://b.s3.us-west-2.amazonaws.com/k", headers: { "Content-Type": "image/png" } },
        });
      }
      if (url.includes("s3-accelerate")) {
        return new Response("edge timeout", { status: 503 });
      }
      if (url.includes("s3.us-west-2")) {
        return new Response("", { status: 200 });
      }
      if (url.endsWith("/api/uploads/complete")) {
        return Response.json({
          ok: true,
          file_id: "direct_s3_file_001",
          name: "report.png",
          mime: "image/png",
          size: payload.byteLength,
          url: "/api/files/direct_s3_file_001",
          storage_provider: "s3",
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const res = await uploadControlledLocalFile(filePath, {
      hubUrl: "https://hub.example",
      authToken: "ntok_claude_test",
      allowedRoots: [root],
      maxBytes: 100 * 1024 * 1024,
      fetch: fetchMock,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.file_id).toBe("direct_s3_file_001");
      expect(res.size).toBe(payload.byteLength);
    }
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      "POST https://hub.example/api/uploads/presign",
      "PUT https://b.s3-accelerate.amazonaws.com/k",
      "PUT https://b.s3.us-west-2.amazonaws.com/k",
      "POST https://hub.example/api/uploads/complete",
    ]);
    expect(calls[0]?.cloudHeader).toBe("aws");
  });

  test("downloadChannelAttachments downloads directly from S3 with regional fallback and Hub ?proxy=1 cascade", async () => {
    process.env.ANET_CALLER_CLOUD = "aws";
    _clearDirectStorageCacheForTest();
    const root = mkdtempSync(join(tmpdir(), "anet-direct-dl-"));
    dirs.push(root);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // Case 1: Tier-1 accelerate 503 -> Tier-2 regional S3 200 (0 bytes through Hub!)
    const urls1: string[] = [];
    let cloudHeaderSeen: string | null = null;
    const r1 = await downloadChannelAttachments({
      meta: { attachments: [{ type: "file", file_id: "s3_direct_dl_001", name: "shot.png", mime: "image/png", size: png.length }] },
    }, {
      hubUrl: "https://hub.example",
      authToken: "ntok_claude_dl",
      cacheDir: channelAttachmentCacheDir(root, "node-s3-1"),
      fetch: (async (input, init) => {
        const u = String(input);
        urls1.push(u);
        if (u.endsWith("/direct")) {
          cloudHeaderSeen = new Headers(init?.headers).get("x-anet-caller-cloud");
          return Response.json({
            ok: true,
            mode: "direct",
            provider: "s3",
            url: "https://b.s3-accelerate.amazonaws.com/shot.png",
            fallback_url: "https://b.s3.us-west-2.amazonaws.com/shot.png",
            headers: {},
          });
        }
        if (u.includes("s3-accelerate")) return new Response("err", { status: 503 });
        if (u.includes("s3.us-west-2")) return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
        return new Response("unexpected", { status: 500 });
      }) as typeof fetch,
    });
    expect(r1.failures).toEqual([]);
    expect(r1.paths).toHaveLength(1);
    expect([...readFileSync(r1.paths[0]!)]).toEqual([...png]);
    expect(cloudHeaderSeen).toBe("aws");
    expect(urls1).toEqual([
      "https://hub.example/api/files/s3_direct_dl_001/direct",
      "https://b.s3-accelerate.amazonaws.com/shot.png",
      "https://b.s3.us-west-2.amazonaws.com/shot.png",
    ]);

    // Case 2: Both direct URLs fail -> Tier-3 Hub ?proxy=1 succeeds
    const urls2: string[] = [];
    const r2 = await downloadChannelAttachments({
      meta: { attachments: [{ type: "file", file_id: "s3_direct_dl_002", name: "shot2.png", mime: "image/png", size: png.length }] },
    }, {
      hubUrl: "https://hub.example",
      authToken: "ntok_claude_dl",
      cacheDir: channelAttachmentCacheDir(root, "node-s3-2"),
      fetch: (async (input) => {
        const u = String(input);
        urls2.push(u);
        if (u.endsWith("/direct")) {
          return Response.json({
            ok: true,
            mode: "direct",
            provider: "s3",
            url: "https://b.s3-accelerate.amazonaws.com/shot2.png",
            fallback_url: "https://b.s3.us-west-2.amazonaws.com/shot2.png",
            headers: {},
          });
        }
        if (u.includes("amazonaws.com")) throw new Error("network unreachable");
        if (u.endsWith("?proxy=1")) return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
        return new Response("unexpected", { status: 500 });
      }) as typeof fetch,
    });
    expect(r2.failures).toEqual([]);
    expect(r2.paths).toHaveLength(1);
    expect(urls2).toEqual([
      "https://hub.example/api/files/s3_direct_dl_002/direct",
      "https://b.s3-accelerate.amazonaws.com/shot2.png",
      "https://b.s3.us-west-2.amazonaws.com/shot2.png",
      "https://hub.example/api/files/s3_direct_dl_002?proxy=1",
    ]);
  });

  test("aborts streaming download on the overflowing chunk when Content-Length is absent and cleans up temp file", async () => {
    const root = mkdtempSync(join(tmpdir(), "anet-stream-cap-"));
    dirs.push(root);
    const cacheDir = channelAttachmentCacheDir(root, "node-stream-cap");

    let chunksPulled = 0;
    let cancelled = false;
    const totalChunks = 10;
    const chunkSize = 400; // maxBytes = 1000 -> chunk 1 (400), chunk 2 (800), chunk 3 (1200 > 1000) must abort immediately

    const res = await downloadChannelAttachments({
      meta: { attachments: [{ type: "file", file_id: "stream_cap_001", name: "huge.pdf", mime: "application/pdf" }] },
    }, {
      hubUrl: "https://hub.example",
      authToken: "ntok_stream_test",
      cacheDir,
      maxBytes: 1000,
      fetch: (async (input) => {
        const u = String(input);
        if (u.endsWith("/direct")) {
          return Response.json({
            ok: true,
            mode: "direct",
            provider: "s3",
            url: "https://b.s3.us-west-2.amazonaws.com/huge.pdf",
            headers: {},
          });
        }
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (chunksPulled >= totalChunks) {
              controller.close();
              return;
            }
            chunksPulled++;
            controller.enqueue(new Uint8Array(chunkSize).fill(0x41));
          },
          cancel() {
            cancelled = true;
          },
        });
        // Deliberately omit Content-Length so pre-check cannot trigger.
        return new Response(stream, { status: 200, headers: { "content-type": "application/pdf" } });
      }) as typeof fetch,
    });

    expect(res.paths).toEqual([]);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]?.code).toBe("size_exceeded");
    expect(cancelled).toBe(true);
    // Must stop at or right after the overflowing 3rd chunk (allowing at most 1 queued pull in ReadableStream HWM=1), NEVER draining all 10 chunks.
    expect(chunksPulled).toBeLessThanOrEqual(4);
    expect(chunksPulled).toBeLessThan(totalChunks);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  test("gives regional retry and Hub ?proxy=1 fallback fresh AbortSignals after direct timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "anet-timeout-fallback-"));
    dirs.push(root);
    const cacheDir = channelAttachmentCacheDir(root, "node-timeout-fallback");
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const seen: Array<{ url: string; signal: AbortSignal | null | undefined; abortedAtEntry: boolean }> = [];
    const waitForAbort = (signal: AbortSignal | null | undefined) =>
      new Promise<Response>((_, reject) => {
        if (!signal) return reject(new Error("expected AbortSignal"));
        if (signal.aborted) return reject(new DOMException("already aborted", "AbortError"));
        signal.addEventListener("abort", () => {
          reject(new DOMException("timed out", "AbortError"));
        }, { once: true });
      });

    const res = await downloadChannelAttachments({
      meta: { attachments: [{ type: "file", file_id: "s3_timeout_fb_001", name: "timeout.png", mime: "image/png", size: png.length }] },
    }, {
      hubUrl: "https://hub.example",
      authToken: "ntok_timeout_test",
      cacheDir,
      fetchTimeoutMs: 40,
      fetch: (async (input, init) => {
        const u = String(input);
        const signal = init?.signal;
        if (u.endsWith("/direct")) {
          return Response.json({
            ok: true,
            mode: "direct",
            provider: "s3",
            url: "https://b.s3-accelerate.amazonaws.com/timeout.png",
            fallback_url: "https://b.s3.us-west-2.amazonaws.com/timeout.png",
            headers: {},
          });
        }
        seen.push({ url: u, signal, abortedAtEntry: Boolean(signal?.aborted) });
        if (u.includes("s3-accelerate") || u.includes("s3.us-west-2")) {
          // Stall until this attempt's own AbortController times out.
          return await waitForAbort(signal);
        }
        if (u.endsWith("?proxy=1")) {
          if (signal?.aborted) {
            throw new DOMException("fallback received pre-aborted signal", "AbortError");
          }
          return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
        }
        return new Response("unexpected", { status: 500 });
      }) as typeof fetch,
    });

    expect(res.failures).toEqual([]);
    expect(res.paths).toHaveLength(1);
    expect([...readFileSync(res.paths[0]!)]).toEqual([...png]);
    expect(seen.map(s => s.url)).toEqual([
      "https://b.s3-accelerate.amazonaws.com/timeout.png",
      "https://b.s3.us-west-2.amazonaws.com/timeout.png",
      "https://hub.example/api/files/s3_timeout_fb_001?proxy=1",
    ]);
    // Every attempt must start with a fresh, non-aborted AbortSignal.
    expect(seen.map(s => s.abortedAtEntry)).toEqual([false, false, false]);
    expect(seen[0]?.signal).toBeDefined();
    expect(seen[1]?.signal).toBeDefined();
    expect(seen[2]?.signal).toBeDefined();
    expect(seen[0]?.signal).not.toBe(seen[1]?.signal);
    expect(seen[1]?.signal).not.toBe(seen[2]?.signal);
    expect(seen[0]?.signal).not.toBe(seen[2]?.signal);
    // The timed-out direct signals are aborted, while the Hub fallback signal remains un-aborted.
    expect(seen[0]?.signal?.aborted).toBe(true);
    expect(seen[1]?.signal?.aborted).toBe(true);
    expect(seen[2]?.signal?.aborted).toBe(false);
  });
});
