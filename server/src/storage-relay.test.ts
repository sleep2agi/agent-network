import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DIR = mkdtempSync(join(tmpdir(), "anet-storage-relay-test-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR ||= join(PRIVATE_DIR, "uploads");
process.env.ANET_HUB_SECRET_VAULT_KEY = "ab".repeat(32);

let hubServer: ReturnType<typeof Bun.serve>;
let hubBase = "";

let mockProviderServer: ReturnType<typeof Bun.serve>;
let mockProviderBase = "";

// Mock ModelScope & S3/OSS state
const lfsObjects = new Map<string, Uint8Array>(); // sha256 -> raw bytes
const lfsCommits: Array<{ repo: string; revision: string; actions: any[] }> = [];
const s3Objects = new Map<string, Uint8Array>(); // pathname -> raw bytes
let mockRepoVisibility = 1; // 1 = Private, 5 = Public
let mockExpectedToken = "ms_test_secret_token_9876543210";
let mockDeduplicateOid: string | null = null;
let mockExternalUploadHost = false;
let capturedPutAuthHeader: string | null = null;

let ownerToken = "";
let ownerNetworkId = "";
let memberToken = "";
let outsiderToken = "";
let outsiderNetworkId = "";
let nodeToken = "";

beforeAll(async () => {
  // Start local mock provider implementing both ModelScope LFS HTTP API and S3/OSS PUT/GET/HEAD.
  mockProviderServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("Authorization") || "";
      const cookie = req.headers.get("Cookie") || "";

      // 1. ModelScope repo info: GET /api/v1/{datasets|models}/{owner}/{repo}
      if (req.method === "GET" && /^\/api\/v1\/(datasets|models)\/[^/]+\/[^/]+$/.test(url.pathname)) {
        if (auth !== `Bearer ${mockExpectedToken}` || !cookie.includes(`m_session_id=${mockExpectedToken}`)) {
          return Response.json({ Code: 401, Message: "invalid token" }, { status: 401 });
        }
        return Response.json({
          Code: 200,
          Success: true,
          Data: { Visibility: mockRepoVisibility, Path: "owner", Name: "relay-repo" },
        });
      }

      // 2. ModelScope LFS batch: POST /api/v1/repos/{datasets|models}/{owner}/{repo}/info/lfs/objects/batch
      if (req.method === "POST" && url.pathname.endsWith("/info/lfs/objects/batch")) {
        if (auth !== `Bearer ${mockExpectedToken}`) {
          return Response.json({ Code: 401, Message: "unauthorized" }, { status: 401 });
        }
        const body: any = await req.json();
        const obj = body?.objects?.[0];
        if (!obj?.oid) return Response.json({ Code: 400, Message: "missing oid" }, { status: 400 });
        if (mockDeduplicateOid === obj.oid || lfsObjects.has(obj.oid)) {
          // Matches real ModelScope live dedup shape: Data.objects = []
          return Response.json({
            Code: 200,
            Data: { objects: [], "reused-objects": [] },
            Message: "success",
            Success: true,
          });
        }
        const uploadHref = mockExternalUploadHost
          ? `https://third-party-oss.example.invalid/lfs/${obj.oid}`
          : `${mockProviderBase}/lfs-upload/${obj.oid}`;
        return Response.json({
          transfer: "basic",
          objects: [{
            oid: obj.oid,
            size: obj.size,
            actions: {
              upload: {
                href: uploadHref,
                header: { "X-Lfs-Slot": "slot-1" },
              },
            },
          }],
        });
      }

      // 3. ModelScope LFS direct PUT: PUT /lfs-upload/:oid
      if (req.method === "PUT" && url.pathname.startsWith("/lfs-upload/")) {
        capturedPutAuthHeader = req.headers.get("Authorization");
        const oid = url.pathname.slice("/lfs-upload/".length);
        const bytes = new Uint8Array(await req.arrayBuffer());
        lfsObjects.set(oid, bytes);
        return Response.json({ Code: 200, Success: true });
      }

      // 4. ModelScope commit: POST /api/v1/repos/{datasets|models}/{owner}/{repo}/commit/:rev
      if (req.method === "POST" && url.pathname.includes("/commit/")) {
        if (auth !== `Bearer ${mockExpectedToken}`) {
          return Response.json({ Code: 401, Message: "unauthorized" }, { status: 401 });
        }
        const body: any = await req.json();
        const rev = url.pathname.split("/commit/")[1] || "master";
        lfsCommits.push({ repo: url.pathname, revision: rev, actions: body.actions || [] });
        return Response.json({ Code: 200, Success: true, Data: { commit_oid: "abc123" } });
      }

      // 5. ModelScope direct download: GET/HEAD /api/v1/{datasets|models}/{owner}/{repo}/repo?Revision=...&FilePath=...
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname.endsWith("/repo")) {
        if (auth !== `Bearer ${mockExpectedToken}` && !cookie.includes(`m_session_id=${mockExpectedToken}`)) {
          return new Response("unauthorized", { status: 401 });
        }
        const filePath = url.searchParams.get("FilePath") || "";
        const commit = [...lfsCommits].reverse().find((c) => c.actions.some((a) => a.path === filePath));
        const action = commit?.actions.find((a) => a.path === filePath);
        const blob = action ? lfsObjects.get(action.sha256) : undefined;
        if (!blob) return new Response("not found", { status: 404 });
        return new Response(req.method === "HEAD" ? null : blob, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(blob.byteLength),
            "Accept-Ranges": "bytes",
          },
        });
      }

      // 6. Mock S3 / OSS path-style endpoints (validates presigned query params presence)
      const isSignedOss = url.searchParams.get("x-oss-signature-version") === "OSS4-HMAC-SHA256"
        && !!url.searchParams.get("x-oss-signature");
      const isSignedS3 = url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256"
        && !!url.searchParams.get("X-Amz-Signature");
      if (isSignedOss || isSignedS3) {
        if (req.method === "PUT") {
          const bytes = new Uint8Array(await req.arrayBuffer());
          s3Objects.set(url.pathname, bytes);
          return new Response("", { status: 200 });
        }
        if (req.method === "HEAD") {
          const existing = s3Objects.get(url.pathname);
          if (!existing) return new Response(null, { status: 404 });
          return new Response(null, { status: 200, headers: { "Content-Length": String(existing.byteLength) } });
        }
        if (req.method === "GET") {
          const existing = s3Objects.get(url.pathname);
          if (!existing) return new Response("not found", { status: 404 });
          return new Response(existing, { status: 200, headers: { "Content-Length": String(existing.byteLength) } });
        }
      }

      return new Response("unhandled mock route", { status: 404 });
    },
  });
  mockProviderBase = `http://127.0.0.1:${mockProviderServer.port}`;

  const { db } = await import("./db.js");
  const { addNetworkMember, createNetworkTokenForNode, register } = await import("./auth.js");
  const suffix = Date.now();

  const boot = register(`storage_boot_${suffix}`, "StorageBoot-Strong-1!", undefined, "boot");
  expect(boot.ok).toBe(true);

  const owner = register(`storage_owner_${suffix}`, "StorageOwner-Strong-1!", undefined, "owner");
  expect(owner.ok).toBe(true);
  ownerToken = owner.token!;
  ownerNetworkId = owner.network_id!;

  const member = register(`storage_member_${suffix}`, "StorageMember-Strong-1!", undefined, "member");
  expect(member.ok).toBe(true);
  memberToken = member.token!;
  const memberUserId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `storage_member_${suffix}`)!.user_id;
  addNetworkMember(ownerNetworkId, memberUserId, "member");

  const outsider = register(`storage_outsider_${suffix}`, "StorageOutsider-Strong-1!", undefined, "outsider");
  expect(outsider.ok).toBe(true);
  outsiderToken = outsider.token!;
  outsiderNetworkId = outsider.network_id!;

  const ownerUserId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `storage_owner_${suffix}`)!.user_id;
  const minted = createNetworkTokenForNode(ownerUserId, ownerNetworkId, "storage-test-node");
  expect(minted.ok).toBe(true);
  nodeToken = minted.token!;

  const mod = await import("./server.js");
  hubServer = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  hubBase = `http://127.0.0.1:${hubServer.port}`;
}, 30_000);

afterAll(() => {
  try { hubServer?.stop(true); } catch {}
  try { mockProviderServer?.stop(true); } catch {}
  try { rmSync(PRIVATE_DIR, { recursive: true, force: true }); } catch {}
});

describe("SigV4 Presigned URL signing (Aliyun OSS & AWS S3)", () => {
  test("generates deterministic OSS4-HMAC-SHA256 virtual-host presigned URLs", async () => {
    const { signObjectStoragePresignedUrl } = await import("./storage-relay.js");
    const fixedDate = new Date("2026-11-27T12:00:00Z");
    const urlStr = signObjectStoragePresignedUrl({
      provider: "oss",
      method: "PUT",
      bucket: "anet-media",
      region: "oss-cn-hangzhou",
      objectKey: "anet-files/net_1/2026-11-27/abc12345.mp4",
      accessKeyId: "LTAI5tTestAccessKey",
      accessKeySecret: "SecretValue1234567890",
      expiresSeconds: 900,
      now: fixedDate,
    });
    const u = new URL(urlStr);
    expect(u.hostname).toBe("anet-media.oss-cn-hangzhou.aliyuncs.com");
    expect(u.pathname).toBe("/anet-files/net_1/2026-11-27/abc12345.mp4");
    expect(u.searchParams.get("x-oss-signature-version")).toBe("OSS4-HMAC-SHA256");
    expect(u.searchParams.get("x-oss-credential")).toBe("LTAI5tTestAccessKey/20261127/cn-hangzhou/oss/aliyun_v4_request");
    expect(u.searchParams.get("x-oss-date")).toBe("20261127T120000Z");
    expect(u.searchParams.get("x-oss-expires")).toBe("900");
    expect(u.searchParams.get("x-oss-signature")).toMatch(/^[0-9a-f]{64}$/);
    // Secret key must NEVER appear in the URL.
    expect(urlStr).not.toContain("SecretValue1234567890");
  });

  test("generates deterministic AWS4-HMAC-SHA256 presigned URLs with optional session token", async () => {
    const { signObjectStoragePresignedUrl } = await import("./storage-relay.js");
    const fixedDate = new Date("2026-11-27T12:00:00Z");
    const urlStr = signObjectStoragePresignedUrl({
      provider: "s3",
      method: "GET",
      bucket: "anet-s3-bucket",
      region: "us-west-2",
      objectKey: "anet-files/net_1/2026-11-27/pic.png",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      accessKeySecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken: "FwoGZXIvYXdzEBY",
      expiresSeconds: 600,
      now: fixedDate,
    });
    const u = new URL(urlStr);
    expect(u.hostname).toBe("anet-s3-bucket.s3.us-west-2.amazonaws.com");
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Credential")).toBe("AKIAIOSFODNN7EXAMPLE/20261127/us-west-2/s3/aws4_request");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(u.searchParams.get("X-Amz-Security-Token")).toBe("FwoGZXIvYXdzEBY");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(urlStr).not.toContain("wJalrXUtnFEMI");
  });
});

describe("Hub /api/storage/* & ModelScope/OSS/S3 direct relay HTTP E2E", () => {
  test("unconfigured network returns mode=hub on /api/uploads/presign and advertises storage_relay capability", async () => {
    const health = await fetch(`${hubBase}/health`).then((r) => r.json() as Promise<any>);
    expect(health.capabilities).toContain("storage_relay");

    const presignRes = await fetch(`${hubBase}/api/uploads/presign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "a.png", mime: "image/png", size: 123, sha256: "a".repeat(64) }),
    });
    expect(presignRes.status).toBe(200);
    const presignBody: any = await presignRes.json();
    expect(presignBody.mode).toBe("hub");
    expect(presignBody.upload_url).toBe("/api/upload");
  });

  test("ACL: member & node cannot write config; owner encrypts ModelScope token in vault and tests visibility", async () => {
    const memberPut = await fetch(`${hubBase}/api/storage/config`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ network_id: ownerNetworkId, provider: "modelscope", repo_id: "owner/relay", api_token: mockExpectedToken }),
    });
    expect(memberPut.status).toBe(403);

    const nodePut = await fetch(`${hubBase}/api/storage/config`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${nodeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "modelscope", repo_id: "owner/relay", api_token: mockExpectedToken }),
    });
    expect(nodePut.status).toBe(403);

    // Owner saves ModelScope config pointing at local mock server
    const putRes = await fetch(`${hubBase}/api/storage/config`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        enabled: true,
        provider: "modelscope",
        repo_id: "owner/relay-repo",
        repo_type: "dataset",
        revision: "master",
        prefix: "anet-files",
        endpoint: mockProviderBase,
        api_token: mockExpectedToken,
        max_file_bytes: 120 * 1024 * 1024,
      }),
    });
    expect(putRes.status).toBe(200);
    const saved: any = await putRes.json();
    expect(saved.ok).toBe(true);
    expect(saved.enabled).toBe(true);
    expect(saved.configured).toBe(true);
    expect(saved.provider).toBe("modelscope");
    expect(saved.key_hint).toBe("…3210");
    expect(JSON.stringify(saved)).not.toContain(mockExpectedToken);

    // DB stores ciphertext only, never plaintext token
    const { db } = await import("./db.js");
    const rawRow = db.get<any>("SELECT * FROM network_storage_configs WHERE network_id = ?1", ownerNetworkId);
    expect(rawRow.ciphertext_b64).toBeTruthy();
    expect(JSON.stringify(rawRow)).not.toContain(mockExpectedToken);

    // countNetworkContents recognizes network_storage_configs
    const { countNetworkContents } = await import("./auth.js");
    expect(countNetworkContents(ownerNetworkId).network_storage_configs).toBe(1);

    // Node token can read non-secret config metadata (can_manage = false)
    const nodeGet = await fetch(`${hubBase}/api/storage/config`, {
      headers: { Authorization: `Bearer ${nodeToken}` },
    }).then((r) => r.json() as Promise<any>);
    expect(nodeGet.enabled).toBe(true);
    expect(nodeGet.can_manage).toBe(false);
    expect(nodeGet.max_file_bytes).toBe(120 * 1024 * 1024);

    // Test connection: Private repo -> ok without warning
    mockRepoVisibility = 1;
    const testPriv = await fetch(`${hubBase}/api/storage/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ network_id: ownerNetworkId }),
    }).then((r) => r.json() as Promise<any>);
    expect(testPriv.ok).toBe(true);
    expect(testPriv.visibility).toBe("private");
    expect(testPriv.warning).toBeUndefined();

    // Test connection: Public repo -> ok WITH privacy warning
    mockRepoVisibility = 5;
    const testPub = await fetch(`${hubBase}/api/storage/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ network_id: ownerNetworkId }),
    }).then((r) => r.json() as Promise<any>);
    expect(testPub.ok).toBe(true);
    expect(testPub.visibility).toBe("public");
    expect(testPub.warning).toContain("公开");
    mockRepoVisibility = 1;
  });

  test("ModelScope full direct relay lifecycle: presign -> pending 404 -> direct PUT -> complete -> direct download + ACL + legacy proxy + dedup", async () => {
    const payload = Buffer.from("hello-modelscope-video-bytes-1234567890-abcdef");
    const sha256 = createHash("sha256").update(payload).digest("hex");

    // 1. Presign (0 file bytes sent to Hub)
    const presignRes = await fetch(`${hubBase}/api/uploads/presign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        name: "screen-demo.mp4",
        mime: "video/mp4",
        size: payload.length,
        sha256,
      }),
    });
    expect(presignRes.status).toBe(200);
    const presign: any = await presignRes.json();
    expect(presign.ok).toBe(true);
    expect(presign.mode).toBe("direct");
    expect(presign.provider).toBe("modelscope");
    expect(presign.skip_upload).toBe(false);
    expect(presign.upload.method).toBe("PUT");
    expect(presign.upload.url).toContain(`/lfs-upload/${sha256}`);

    // 2. While pending: both /direct and /api/files/:id MUST return 404!
    const pendingDirect = await fetch(`${hubBase}/api/files/${presign.file_id}/direct`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(pendingDirect.status).toBe(404);
    const pendingLegacy = await fetch(`${hubBase}/api/files/${presign.file_id}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(pendingLegacy.status).toBe(404);

    // Another member CANNOT hijack/complete owner's pending upload
    const hijackComplete = await fetch(`${hubBase}/api/uploads/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: presign.file_id }),
    });
    expect(hijackComplete.status).toBe(404);

    // 3. Direct PUT bytes to ModelScope mock (Hub never sees these bytes)
    const putRes = await fetch(presign.upload.url, {
      method: presign.upload.method,
      headers: presign.upload.headers,
      body: payload,
    });
    expect(putRes.status).toBe(200);
    expect(lfsObjects.get(sha256)).toEqual(new Uint8Array(payload));

    // 4. Complete (Hub commits LFS pointer to ModelScope)
    const completeRes = await fetch(`${hubBase}/api/uploads/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: presign.file_id }),
    });
    expect(completeRes.status).toBe(200);
    const completed: any = await completeRes.json();
    expect(completed.ok).toBe(true);
    expect(completed.file_id).toBe(presign.file_id);
    expect(completed.storage_provider).toBe("modelscope");
    expect(lfsCommits.length).toBeGreaterThanOrEqual(1);

    // 5. Authorized member & node get direct download descriptor; outsider gets 404!
    const outsiderDirect = await fetch(`${hubBase}/api/files/${presign.file_id}/direct`, {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(outsiderDirect.status).toBe(404);

    const nodeDirectRes = await fetch(`${hubBase}/api/files/${presign.file_id}/direct`, {
      headers: { Authorization: `Bearer ${nodeToken}` },
    });
    expect(nodeDirectRes.status).toBe(200);
    expect(nodeDirectRes.headers.get("Cache-Control")).toContain("no-store");
    const nodeDirect: any = await nodeDirectRes.json();
    expect(nodeDirect.mode).toBe("direct");
    expect(nodeDirect.provider).toBe("modelscope");
    expect(nodeDirect.url).toContain("/api/v1/datasets/owner/relay-repo/repo?");

    // Direct GET from ModelScope succeeds with exact bytes
    const directBytes = new Uint8Array(
      await fetch(nodeDirect.url, { headers: nodeDirect.headers }).then((r) => r.arrayBuffer()),
    );
    expect(Buffer.from(directBytes)).toEqual(payload);

    // 6. Legacy GET /api/files/:id transparently proxies for older clients (and respects restricted-member ACL!)
    const restrictedLegacy = await fetch(`${hubBase}/api/files/${presign.file_id}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(restrictedLegacy.status).toBe(404);

    const legacyRes = await fetch(`${hubBase}/api/files/${presign.file_id}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(legacyRes.status).toBe(200);
    expect(legacyRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await legacyRes.arrayBuffer())).toEqual(payload);

    // 7. Second presign of identical sha256 triggers LFS dedup (live ModelScope returns objects: [])
    const dedupRes = await fetch(`${hubBase}/api/uploads/presign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        name: "copy.mp4",
        mime: "video/mp4",
        size: payload.length,
        sha256,
      }),
    }).then((r) => r.json() as Promise<any>);
    expect(dedupRes.ok).toBe(true);
    expect(dedupRes.skip_upload).toBe(true);
    expect(dedupRes.upload).toBeNull();

    // 7b. Concurrent multi-file completions coalesce into a single ModelScope Git commit (prevents 429 commit lock busy!)
    const commitsBefore = lfsCommits.length;
    const batchFiles = await Promise.all([1, 2, 3].map(async (idx) => {
      const buf = Buffer.from(`concurrent-photo-${idx}-${Date.now()}`);
      const h = createHash("sha256").update(buf).digest("hex");
      const pr: any = await fetch(`${hubBase}/api/uploads/presign`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ network_id: ownerNetworkId, name: `p${idx}.png`, mime: "image/png", size: buf.length, sha256: h }),
      }).then((r) => r.json());
      await fetch(pr.upload.url, { method: "PUT", headers: pr.upload.headers, body: buf });
      return pr.file_id as string;
    }));
    const batchCompleted = await Promise.all(batchFiles.map((fid) =>
      fetch(`${hubBase}/api/uploads/complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fid }),
      }).then((r) => r.json() as Promise<any>),
    ));
    expect(batchCompleted.every((c) => c.ok === true)).toBe(true);
    expect(lfsCommits.length - commitsBefore).toBe(1);
    expect(lfsCommits[lfsCommits.length - 1].actions.length).toBe(3);

    // 8. Token leak defense: when ModelScope LFS returns an external host href, never attach ModelScope token!
    const otherSha = createHash("sha256").update("external-host-blob").digest("hex");
    mockExternalUploadHost = true;
    try {
      const extPresign = await fetch(`${hubBase}/api/uploads/presign`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          network_id: ownerNetworkId,
          name: "ext.bin",
          mime: "application/octet-stream",
          size: 18,
          sha256: otherSha,
        }),
      }).then((r) => r.json() as Promise<any>);
      expect(extPresign.ok).toBe(true);
      expect(extPresign.upload.url).toContain("third-party-oss.example.invalid");
      expect(extPresign.upload.headers.Authorization).toBeUndefined();
      expect(extPresign.upload.headers.Cookie).toBeUndefined();
    } finally {
      mockExternalUploadHost = false;
    }
  });

  test("DM scope isolation enforced on /api/files/:id/direct", async () => {
    const dmBytes = Buffer.from("private-dm-photo-bytes");
    const sha = createHash("sha256").update(dmBytes).digest("hex");
    const p: any = await fetch(`${hubBase}/api/uploads/presign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        purpose: "dm",
        name: "secret.png",
        mime: "image/png",
        size: dmBytes.length,
        sha256: sha,
      }),
    }).then((r) => r.json());
    expect(p.ok).toBe(true);
    await fetch(p.upload.url, { method: "PUT", headers: p.upload.headers, body: dmBytes });
    const c: any = await fetch(`${hubBase}/api/uploads/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: p.file_id }),
    }).then((r) => r.json());
    expect(c.ok).toBe(true);

    // Owner can access DM file; unrelated network member gets 404!
    const ownerCheck = await fetch(`${hubBase}/api/files/${p.file_id}/direct`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerCheck.status).toBe(200);

    const memberCheck = await fetch(`${hubBase}/api/files/${p.file_id}/direct`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(memberCheck.status).toBe(404);
  });

  test("Aliyun OSS direct relay: presign -> PUT -> HEAD verify -> /direct + 302 redirect on /api/files/:id", async () => {
    const putCfg = await fetch(`${hubBase}/api/storage/config`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        enabled: true,
        provider: "oss",
        bucket: "anet-oss-bucket",
        region: "oss-cn-hangzhou",
        endpoint: mockProviderBase,
        access_key_id: "LTAI5tMockAccessKeyId",
        access_key_secret: "MockOssSecretKey999999",
      }),
    });
    expect(putCfg.status).toBe(200);

    // Test connection succeeds (HEAD 404 = bucket accessible & credentials valid)
    const testOss: any = await fetch(`${hubBase}/api/storage/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ network_id: ownerNetworkId }),
    }).then((r) => r.json());
    expect(testOss.ok).toBe(true);
    expect(testOss.provider).toBe("oss");

    const payload = Buffer.from("oss-direct-upload-image-bytes-xyz");
    const presign: any = await fetch(`${hubBase}/api/uploads/presign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        name: "photo.jpg",
        mime: "image/jpeg",
        size: payload.length,
      }),
    }).then((r) => r.json());
    expect(presign.ok).toBe(true);
    expect(presign.provider).toBe("oss");
    expect(presign.upload.url).toContain("x-oss-signature-version=OSS4-HMAC-SHA256");

    // Completing before PUT fails with 400 storage_object_missing
    const earlyComplete = await fetch(`${hubBase}/api/uploads/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: presign.file_id }),
    });
    expect(earlyComplete.status).toBe(400);

    // Direct PUT to OSS mock
    const putRes = await fetch(presign.upload.url, { method: "PUT", body: payload });
    expect(putRes.status).toBe(200);

    // Complete verifies object size via HEAD and publishes file_id
    const done: any = await fetch(`${hubBase}/api/uploads/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: presign.file_id }),
    }).then((r) => r.json());
    expect(done.ok).toBe(true);
    expect(done.storage_provider).toBe("oss");

    // /api/files/:id returns 302 Found redirecting directly to presigned OSS GET URL (0 Hub bytes!)
    const redirectRes = await fetch(`${hubBase}/api/files/${presign.file_id}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
      redirect: "manual",
    });
    expect(redirectRes.status).toBe(302);
    const loc = redirectRes.headers.get("Location") || "";
    expect(loc).toContain("x-oss-signature-version=OSS4-HMAC-SHA256");
    const downloaded = Buffer.from(await fetch(loc).then((r) => r.arrayBuffer()));
    expect(downloaded).toEqual(payload);

    // DELETE clears config cleanly
    const delRes: any = await fetch(`${hubBase}/api/storage/config?network_id=${ownerNetworkId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken}` },
    }).then((r) => r.json());
    expect(delRes.ok).toBe(true);
    expect(delRes.configured).toBe(false);
    expect(delRes.enabled).toBe(false);
  });
});
