import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _clearDirectStorageCacheForTest,
  probeHubStorageUploadLimit,
  uploadBufferViaStorageRelay,
} from "./direct-storage";
import { resolveAttachmentToLocalPath } from "./fetch-attachment";

const TEST_DIR = join(tmpdir(), `anet-direct-storage-test-${process.pid}-${Date.now()}`);

beforeEach(() => {
  _clearDirectStorageCacheForTest();
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("uploadBufferViaStorageRelay", () => {
  test("direct ModelScope/OSS/S3 path: presign -> direct PUT (no Hub token leaked) -> complete", async () => {
    const payload = new Uint8Array(Buffer.from("video-or-image-binary-payload-0123456789"));
    const calls: Array<{ url: string; method: string; auth?: string; cookie?: string; bodyLen?: number }> = [];
    let putBytes: Uint8Array | null = null;

    const fakeFetch: typeof fetch = async (input: any, init: any) => {
      const url = String(input);
      const method = String(init?.method || "GET");
      const headers = (init?.headers || {}) as Record<string, string>;
      calls.push({ url, method, auth: headers.Authorization, cookie: headers.Cookie });

      if (url === "http://hub.test:9200/api/uploads/presign") {
        const body = JSON.parse(String(init.body));
        expect(body.size).toBe(payload.byteLength);
        expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(body.name).toBe("demo.mp4");
        return Response.json({
          ok: true,
          mode: "direct",
          provider: "modelscope",
          file_id: "msfile1234567890abcdef1234567890",
          skip_upload: false,
          upload: {
            method: "PUT",
            url: "https://storage.external.test/lfs/put/obj1",
            headers: { "X-Custom-Sig": "sig-xyz" },
          },
          complete_url: "/api/uploads/complete",
        });
      }
      if (url === "https://storage.external.test/lfs/put/obj1") {
        // Hub auth token must NEVER be sent to external storage URL.
        expect(headers.Authorization).toBeUndefined();
        expect(headers["X-Custom-Sig"]).toBe("sig-xyz");
        putBytes = new Uint8Array(init.body);
        return new Response("", { status: 200 });
      }
      if (url === "http://hub.test:9200/api/uploads/complete") {
        const body = JSON.parse(String(init.body));
        expect(body.file_id).toBe("msfile1234567890abcdef1234567890");
        return Response.json({
          ok: true,
          file_id: "msfile1234567890abcdef1234567890",
          url: "/api/files/msfile1234567890abcdef1234567890",
          name: "demo.mp4",
          mime: "video/mp4",
          size: payload.byteLength,
          storage_provider: "modelscope",
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    };

    const res = await uploadBufferViaStorageRelay({
      hubUrl: "http://hub.test:9200",
      authToken: "ntok_secret_hub_token",
      bytes: payload,
      name: "demo.mp4",
      mime: "video/mp4",
      fetch: fakeFetch,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file_id).toBe("msfile1234567890abcdef1234567890");
    expect(res.storage_provider).toBe("modelscope");
    expect(putBytes).toEqual(payload);
    // Zero calls to legacy /api/upload.
    expect(calls.map((c) => c.url)).toEqual([
      "http://hub.test:9200/api/uploads/presign",
      "https://storage.external.test/lfs/put/obj1",
      "http://hub.test:9200/api/uploads/complete",
    ]);
  });

  test("LFS dedup (skip_upload=true) skips PUT and commits directly", async () => {
    const payload = new Uint8Array(Buffer.from("duplicate-blob-content"));
    const urls: string[] = [];
    const fakeFetch: typeof fetch = async (input: any) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/api/uploads/presign")) {
        return Response.json({
          ok: true,
          mode: "direct",
          provider: "modelscope",
          file_id: "dedup1234567890abcdef12345678901",
          skip_upload: true,
          upload: null,
        });
      }
      if (url.endsWith("/api/uploads/complete")) {
        return Response.json({
          ok: true,
          file_id: "dedup1234567890abcdef12345678901",
          url: "/api/files/dedup1234567890abcdef12345678901",
          size: payload.byteLength,
          mime: "image/png",
          storage_provider: "modelscope",
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const res = await uploadBufferViaStorageRelay({
      hubUrl: "http://hub.test:9200",
      authToken: "ntok_x",
      bytes: payload,
      name: "dup.png",
      mime: "image/png",
      fetch: fakeFetch,
    });
    expect(res.ok).toBe(true);
    expect(urls).toEqual([
      "http://hub.test:9200/api/uploads/presign",
      "http://hub.test:9200/api/uploads/complete",
    ]);
  });

  test("falls back transparently to multipart /api/upload when Hub returns mode=hub or 404", async () => {
    const payload = new Uint8Array(Buffer.from("small-local-image"));
    const urls: string[] = [];
    const fakeFetch: typeof fetch = async (input: any) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/api/uploads/presign")) {
        return Response.json({ ok: true, mode: "hub", upload_url: "/api/upload" });
      }
      if (url.endsWith("/api/upload")) {
        return Response.json({
          ok: true,
          file_id: "hublocal1234567890abcdef12345678",
          url: "/api/files/hublocal1234567890abcdef12345678",
          size: payload.byteLength,
          mime: "image/png",
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const res = await uploadBufferViaStorageRelay({
      hubUrl: "http://hub.test:9200",
      authToken: "ntok_x",
      bytes: payload,
      name: "small.png",
      mime: "image/png",
      fetch: fakeFetch,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file_id).toBe("hublocal1234567890abcdef12345678");
    expect(urls).toEqual([
      "http://hub.test:9200/api/uploads/presign",
      "http://hub.test:9200/api/upload",
    ]);
  });

  test("degradation: retries fallback_upload on accelerate PUT failure, and degrades <=12MiB to Hub /api/upload when all direct PUTs fail", async () => {
    const payload = new Uint8Array(Buffer.from("small-image-for-fallback-resilience"));

    // Case 1: Primary accelerate PUT fails -> succeeds via Tier-2 regional fallback_upload (0 Hub bytes)
    const tier2Urls: string[] = [];
    const tier2Fetch: typeof fetch = async (input: any) => {
      const url = String(input);
      tier2Urls.push(url);
      if (url.endsWith("/api/uploads/presign")) {
        return Response.json({
          ok: true,
          mode: "direct",
          provider: "s3",
          file_id: "tier2fb1234567890abcdef123456789",
          skip_upload: false,
          upload: { method: "PUT", url: "https://bucket.s3-accelerate.amazonaws.com/k", headers: {} },
          fallback_upload: { method: "PUT", url: "https://bucket.s3.us-west-1.amazonaws.com/k", headers: {} },
        });
      }
      if (url.includes("s3-accelerate")) throw new Error("edge timeout");
      if (url.includes("s3.us-west-1")) return new Response("", { status: 200 });
      if (url.endsWith("/api/uploads/complete")) {
        return Response.json({ ok: true, file_id: "tier2fb1234567890abcdef123456789", url: "/api/files/tier2fb1234567890abcdef123456789", size: payload.byteLength, mime: "image/png" });
      }
      throw new Error(`unexpected ${url}`);
    };
    const r2 = await uploadBufferViaStorageRelay({
      hubUrl: "http://hub.test:9200",
      authToken: "ntok_x",
      bytes: payload,
      name: "pic.png",
      mime: "image/png",
      fetch: tier2Fetch,
    });
    expect(r2.ok).toBe(true);
    expect(tier2Urls).toEqual([
      "http://hub.test:9200/api/uploads/presign",
      "https://bucket.s3-accelerate.amazonaws.com/k",
      "https://bucket.s3.us-west-1.amazonaws.com/k",
      "http://hub.test:9200/api/uploads/complete",
    ]);

    // Case 2: All direct PUTs fail for <=12MiB -> degrades transparently to Hub multipart POST /api/upload
    const tier3Urls: string[] = [];
    const tier3Fetch: typeof fetch = async (input: any) => {
      const url = String(input);
      tier3Urls.push(url);
      if (url.endsWith("/api/uploads/presign")) {
        return Response.json({
          ok: true,
          mode: "direct",
          provider: "s3",
          file_id: "tier3fb1234567890abcdef123456789",
          skip_upload: false,
          upload: { method: "PUT", url: "https://bucket.s3-accelerate.amazonaws.com/k", headers: {} },
          fallback_upload: { method: "PUT", url: "https://bucket.s3.us-west-1.amazonaws.com/k", headers: {} },
        });
      }
      if (url.includes("amazonaws.com")) return new Response("unavailable", { status: 503 });
      if (url.endsWith("/api/upload")) {
        return Response.json({ ok: true, file_id: "hubdegraded1234567890abcdef12345", url: "/api/files/hubdegraded1234567890abcdef12345", size: payload.byteLength, mime: "image/png" });
      }
      throw new Error(`unexpected ${url}`);
    };
    const r3 = await uploadBufferViaStorageRelay({
      hubUrl: "http://hub.test:9200",
      authToken: "ntok_x",
      bytes: payload,
      name: "pic.png",
      mime: "image/png",
      fetch: tier3Fetch,
    });
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.file_id).toBe("hubdegraded1234567890abcdef12345");
    expect(tier3Urls).toEqual([
      "http://hub.test:9200/api/uploads/presign",
      "https://bucket.s3-accelerate.amazonaws.com/k",
      "https://bucket.s3.us-west-1.amazonaws.com/k",
      "http://hub.test:9200/api/upload",
    ]);

    // Case 3 (P2): >12MiB presign 502 MUST surface real presign error and NEVER waste bandwidth into Hub /api/upload (413)
    const oversizePayload = new Uint8Array(12 * 1024 * 1024 + 1);
    const oversizeUrls: string[] = [];
    const rOversize = await uploadBufferViaStorageRelay({
      hubUrl: "http://hub.test:9200",
      authToken: "ntok_x",
      bytes: oversizePayload,
      name: "13mb.mp4",
      mime: "video/mp4",
      fetch: (async (input: any) => {
        const u = String(input);
        oversizeUrls.push(u);
        return Response.json({ ok: false, error: "storage_presign_failed", message: "LFS upstream 502" }, { status: 502 });
      }) as typeof fetch,
    });
    expect(rOversize.ok).toBe(false);
    if (!rOversize.ok) expect(rOversize.message).toContain("LFS upstream 502");
    expect(oversizeUrls).toEqual(["http://hub.test:9200/api/uploads/presign"]);
  });
});

describe("resolveAttachmentToLocalPath — direct external download", () => {
  test("downloads bytes directly from ModelScope URL returned by /api/files/:id/direct (0 Hub bytes)", async () => {
    const payload = Buffer.from("direct-modelscope-video-bytes-abcdef");
    const calls: Array<{ url: string; auth?: string; cookie?: string }> = [];

    const fakeFetch: typeof fetch = async (input: any, init: any) => {
      const url = String(input);
      const headers = (init?.headers || {}) as Record<string, string>;
      calls.push({ url, auth: headers.Authorization, cookie: headers.Cookie });

      if (url === "http://hub.test:9200/api/files/directfile123456/direct") {
        expect(headers.Authorization).toBe("Bearer ntok_node_1");
        return Response.json({
          ok: true,
          mode: "direct",
          provider: "modelscope",
          file_id: "directfile123456",
          url: "https://www.modelscope.cn/api/v1/datasets/owner/relay/repo?Revision=master&FilePath=anet-files/a.mp4",
          headers: {
            Authorization: "Bearer ms_tok_999",
            Cookie: "m_session_id=ms_tok_999",
          },
          size: payload.length,
        });
      }
      if (url.startsWith("https://www.modelscope.cn/")) {
        expect(headers.Authorization).toBe("Bearer ms_tok_999");
        expect(headers.Cookie).toBe("m_session_id=ms_tok_999");
        return new Response(payload, {
          status: 200,
          headers: { "Content-Length": String(payload.length) },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    };

    const res = await resolveAttachmentToLocalPath(
      { file_id: "directfile123456", name: "clip.mp4", mime: "video/mp4", size: payload.length },
      { hubUrl: "http://hub.test:9200", authToken: "ntok_node_1", cacheDir: TEST_DIR, fetch: fakeFetch },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(existsSync(res.localPath)).toBe(true);
    expect(readFileSync(res.localPath)).toEqual(payload);
    // Never hit /api/files/directfile123456 proxy!
    expect(calls.map((c) => c.url)).toEqual([
      "http://hub.test:9200/api/files/directfile123456/direct",
      "https://www.modelscope.cn/api/v1/datasets/owner/relay/repo?Revision=master&FilePath=anet-files/a.mp4",
    ]);
  });

  test("3-tier download cascade: primary direct fails -> regional fallback_url fails -> Hub ?proxy=1 delivers exact bytes", async () => {
    const payload = Buffer.from("hub-proxy-fallback-bytes-99999");
    const visited: string[] = [];

    const fakeFetch: typeof fetch = async (input: any) => {
      const url = String(input);
      visited.push(url);
      if (url === "http://hub.test:9200/api/files/cascadefile12345/direct") {
        return Response.json({
          ok: true,
          mode: "direct",
          provider: "s3",
          file_id: "cascadefile12345",
          url: "https://bucket.s3-accelerate.amazonaws.com/k",
          fallback_url: "https://bucket.s3.us-west-1.amazonaws.com/k",
          proxy_url: "/api/files/cascadefile12345?proxy=1",
          headers: {},
          size: payload.length,
        });
      }
      if (url.includes("s3-accelerate")) throw new Error("edge blocked");
      if (url.includes("s3.us-west-1")) return new Response("timeout", { status: 504 });
      if (url === "http://hub.test:9200/api/files/cascadefile12345?proxy=1") {
        return new Response(payload, { status: 200, headers: { "Content-Length": String(payload.length) } });
      }
      throw new Error(`unexpected fetch to ${url}`);
    };

    const res = await resolveAttachmentToLocalPath(
      { file_id: "cascadefile12345", name: "photo.jpg", mime: "image/jpeg", size: payload.length },
      { hubUrl: "http://hub.test:9200", authToken: "ntok_node_1", cacheDir: TEST_DIR, fetch: fakeFetch },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(readFileSync(res.localPath)).toEqual(payload);
    expect(visited).toEqual([
      "http://hub.test:9200/api/files/cascadefile12345/direct",
      "https://bucket.s3-accelerate.amazonaws.com/k",
      "https://bucket.s3.us-west-1.amazonaws.com/k",
      "http://hub.test:9200/api/files/cascadefile12345?proxy=1",
    ]);
  });

  test("probeHubStorageUploadLimit reads Hub remote limit and falls back to 12 MiB when disabled", async () => {
    const enabledLimit = await probeHubStorageUploadLimit({
      hubUrl: "http://hub.enabled.test:9200",
      authToken: "ntok_enabled",
      fetch: (async () => Response.json({ ok: true, enabled: true, max_file_bytes: 150 * 1024 * 1024 })) as any,
    });
    expect(enabledLimit).toBe(150 * 1024 * 1024);

    const disabledLimit = await probeHubStorageUploadLimit({
      hubUrl: "http://hub.disabled.test:9200",
      authToken: "ntok_disabled",
      fetch: (async () => Response.json({ ok: true, enabled: false, max_file_bytes: 100 * 1024 * 1024 })) as any,
    });
    expect(disabledLimit).toBe(12 * 1024 * 1024);
  });

  test("sends X-ANet-Caller-Cloud: aws on presign & direct download when running on AWS", async () => {
    const prev = process.env.ANET_CALLER_CLOUD;
    process.env.ANET_CALLER_CLOUD = "aws";
    _clearDirectStorageCacheForTest();
    try {
      const seenHeaders: Array<{ url: string; cloud?: string }> = [];
      const payload = Buffer.from("aws-direct-route-bytes");
      const fakeFetch: typeof fetch = async (input: any, init: any) => {
        const url = String(input);
        const h = (init?.headers || {}) as Record<string, string>;
        seenHeaders.push({ url, cloud: h["X-ANet-Caller-Cloud"] });
        if (url.endsWith("/api/uploads/presign")) {
          return Response.json({
            ok: true,
            mode: "direct",
            provider: "s3",
            route: "regional",
            file_id: "awsroute12345678",
            skip_upload: true,
            upload: null,
          });
        }
        if (url.endsWith("/api/uploads/complete")) {
          return Response.json({ ok: true, file_id: "awsroute12345678", url: "/api/files/awsroute12345678" });
        }
        if (url.endsWith("/api/files/awsroute12345678/direct")) {
          return Response.json({
            ok: true,
            mode: "direct",
            provider: "s3",
            route: "regional",
            url: "https://bucket.s3.us-west-1.amazonaws.com/k",
            headers: {},
          });
        }
        return new Response(payload, { status: 200, headers: { "Content-Length": String(payload.length) } });
      };

      const up = await uploadBufferViaStorageRelay({
        hubUrl: "http://hub.test:9200",
        authToken: "ntok_aws_1",
        bytes: payload,
        name: "a.bin",
        mime: "application/octet-stream",
        fetch: fakeFetch,
      });
      expect(up.ok).toBe(true);
      const dl = await resolveAttachmentToLocalPath(
        { file_id: "awsroute12345678", name: "a.bin", mime: "application/octet-stream", size: payload.length },
        { hubUrl: "http://hub.test:9200", authToken: "ntok_aws_1", cacheDir: TEST_DIR, fetch: fakeFetch },
      );
      expect(dl.ok).toBe(true);
      expect(seenHeaders.find((s) => s.url.endsWith("/api/uploads/presign"))?.cloud).toBe("aws");
      expect(seenHeaders.find((s) => s.url.endsWith("/api/files/awsroute12345678/direct"))?.cloud).toBe("aws");
      // External S3 URL must never receive our internal Hub routing header
      expect(seenHeaders.find((s) => s.url.includes("s3.us-west-1"))?.cloud).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ANET_CALLER_CLOUD;
      else process.env.ANET_CALLER_CLOUD = prev;
      _clearDirectStorageCacheForTest();
    }
  });
});
