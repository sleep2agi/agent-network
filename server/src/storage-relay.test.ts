import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DIR = mkdtempSync(join(tmpdir(), "anet-storage-relay-test-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR ||= join(PRIVATE_DIR, "uploads");
process.env.ANET_HUB_SECRET_VAULT_KEY = "ab".repeat(32);
const PREV_ALLOW_LOOPBACK = process.env.ANET_STORAGE_ALLOW_LOOPBACK;
// Explicit test-only opt-in for local mock provider E2E; SSRF tests below explicitly test default (unset/false) behavior.
process.env.ANET_STORAGE_ALLOW_LOOPBACK = "1";

let hubServer: ReturnType<typeof Bun.serve>;
let hubBase = "";

let mockProviderServer: ReturnType<typeof Bun.serve>;
let mockProviderBase = "";

// Mock ModelScope & S3/OSS state
const lfsObjects = new Map<string, Uint8Array>(); // sha256 -> raw bytes
const lfsCommits: Array<{ repo: string; revision: string; actions: any[] }> = [];
const s3Objects = new Map<string, Uint8Array>(); // pathname -> raw bytes
let mockRepoVisibility: number | undefined = 1; // 1 = Private, 5 = Public
let mockExpectedToken = "ms_test_secret_token_9876543210";
let mockDeduplicateOid: string | null = null;
let mockModelScopeEmptyObjectsDedup = false;
let mockCommitBusyFailuresRemaining = 0;
let mockExternalUploadHost = false;
let capturedPutAuthHeader: string | null = null;
let mockBucketPublicList = false;
let mockBucketPublicObjectRead = false;
let mockBucketAclMode: "private" | "oss-public-read" | "oss-public-read-write" | "s3-all-users" | "s3-auth-users" | "forbidden" = "private";
let mockBucketPolicyStatus: "private" | "public" | "unsupported" = "private";
let mockBucketPolicyPublic = false;

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

      // 0. SSRF redirect trap for E2E verification (both /api/storage/test and legacy /api/files/:id proxy)
      if (req.method === "GET" && url.pathname === "/api/v1/datasets/owner/ssrf-redirect-repo") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://169.254.169.254/latest/meta-data/iam/security-credentials/" },
        });
      }
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/v1/datasets/owner/ssrf-proxy-redirect/repo") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://169.254.169.254/latest/meta-data/" },
        });
      }

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
          if (mockModelScopeEmptyObjectsDedup) {
            return Response.json({
              Code: 200,
              Success: true,
              Data: { objects: [], "reused-objects": [] },
            });
          }
          return Response.json({
            transfer: "basic",
            objects: [{ oid: obj.oid, size: obj.size }], // no actions.upload => dedup!
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
        if (mockCommitBusyFailuresRemaining > 0) {
          mockCommitBusyFailuresRemaining--;
          return Response.json(
            { Code: 10030000001, Success: false, Message: "commit lock busy, please try again" },
            { status: 429 },
          );
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

      // 6. Mock S3 / OSS path-style endpoints (validates presigned query params + privacy probes)
      const isSignedOss = url.searchParams.get("x-oss-signature-version") === "OSS4-HMAC-SHA256"
        && !!url.searchParams.get("x-oss-signature");
      const isSignedS3 = url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256"
        && !!url.searchParams.get("X-Amz-Signature");
      if (isSignedOss || isSignedS3) {
        if (req.method === "GET" && url.searchParams.has("acl")) {
          if (mockBucketAclMode === "forbidden") return new Response("AccessDenied", { status: 403 });
          if (mockBucketAclMode === "oss-public-read") {
            return new Response("<AccessControlPolicy><AccessControlList><Grant>public-read</Grant></AccessControlList></AccessControlPolicy>", { status: 200 });
          }
          if (mockBucketAclMode === "oss-public-read-write") {
            return new Response("<AccessControlPolicy><AccessControlList><Grant>public-read-write</Grant></AccessControlList></AccessControlPolicy>", { status: 200 });
          }
          if (mockBucketAclMode === "s3-all-users") {
            return new Response("<AccessControlPolicy><AccessControlList><Grant><Grantee><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee><Permission>READ</Permission></Grant></AccessControlList></AccessControlPolicy>", { status: 200 });
          }
          if (mockBucketAclMode === "s3-auth-users") {
            return new Response("<AccessControlPolicy><AccessControlList><Grant><Grantee><URI>http://acs.amazonaws.com/groups/global/AuthenticatedUsers</URI></Grantee><Permission>READ</Permission></Grant></AccessControlList></AccessControlPolicy>", { status: 200 });
          }
          return new Response(
            isSignedOss
              ? "<AccessControlPolicy><AccessControlList><Grant>private</Grant></AccessControlList></AccessControlPolicy>"
              : "<AccessControlPolicy><AccessControlList><Grant><Grantee><ID>owner-id</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>",
            { status: 200 },
          );
        }
        if (req.method === "GET" && url.searchParams.has("policyStatus")) {
          if (mockBucketPolicyStatus === "unsupported") return new Response("NotImplemented", { status: 501 });
          return new Response(
            `<PolicyStatus><IsPublic>${mockBucketPolicyStatus === "public" ? "true" : "false"}</IsPublic></PolicyStatus>`,
            { status: 200 },
          );
        }
        if (req.method === "GET" && url.searchParams.has("policy")) {
          if (!mockBucketPolicyPublic) return new Response("NoSuchBucketPolicy", { status: 404 });
          return Response.json({
            Version: "1",
            Statement: [{ Effect: "Allow", Principal: ["*"], Action: ["oss:GetObject"], Resource: ["*"] }],
          });
        }
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

      // 7. Unsigned S3 / OSS anonymous access probes (403 on private buckets; 200 when public mock flags enabled)
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        return mockBucketPublicList
          ? new Response("<ListBucketResult><Name>public</Name></ListBucketResult>", { status: 200 })
          : new Response("AccessDenied", { status: 403 });
      }
      if (req.method === "HEAD") {
        return mockBucketPublicObjectRead
          ? new Response(null, { status: 200 })
          : new Response(null, { status: 403 });
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
  if (PREV_ALLOW_LOOPBACK === undefined) delete process.env.ANET_STORAGE_ALLOW_LOOPBACK;
  else process.env.ANET_STORAGE_ALLOW_LOOPBACK = PREV_ALLOW_LOOPBACK;
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

  test("supports AWS S3 & Aliyun OSS Transfer Acceleration (virtual-host DNS + regional control-plane probes) and Cloudflare R2 path-style", async () => {
    const {
      signObjectStoragePresignedUrl,
      validateStorageConfigUrlsAsync,
      testNetworkStorageConfig,
    } = await import("./storage-relay.js");

    // 1. AWS S3 Transfer Acceleration presigns <bucket>.s3-accelerate.amazonaws.com with bucket's real signing region
    const fixedDate = new Date("2026-11-28T06:00:00Z");
    const s3AccPut = signObjectStoragePresignedUrl({
      provider: "s3",
      method: "PUT",
      bucket: "anet-private-usw1",
      region: "us-west-1",
      endpoint: "https://s3-accelerate.amazonaws.com",
      objectKey: "anet-files/net_1/2026-11-28/vid.mp4",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      accessKeySecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresSeconds: 900,
      now: fixedDate,
    });
    const uAcc = new URL(s3AccPut);
    expect(uAcc.hostname).toBe("anet-private-usw1.s3-accelerate.amazonaws.com");
    expect(uAcc.searchParams.get("X-Amz-Credential")).toBe("AKIAIOSFODNN7EXAMPLE/20261128/us-west-1/s3/aws4_request");

    // 2. Cloudflare R2 uses path-style addressing so *.r2.cloudflarestorage.com TLS cert matches cleanly
    const r2Put = signObjectStoragePresignedUrl({
      provider: "s3",
      method: "PUT",
      bucket: "anet-r2-private",
      region: "auto",
      endpoint: "https://acct123456.r2.cloudflarestorage.com",
      objectKey: "anet-files/net_1/2026-11-28/pic.png",
      accessKeyId: "R2ACCESSKEY1234",
      accessKeySecret: "R2SECRETKEY987654321",
      expiresSeconds: 900,
      now: fixedDate,
    });
    const uR2 = new URL(r2Put);
    expect(uR2.hostname).toBe("acct123456.r2.cloudflarestorage.com");
    expect(uR2.pathname).toBe("/anet-r2-private/anet-files/net_1/2026-11-28/pic.png");

    // 3. Bucket with dots is rejected for AWS S3 Transfer Acceleration (wildcard TLS incompatibility)
    const dotBucket = await validateStorageConfigUrlsAsync(
      ownerNetworkId,
      {
        provider: "s3",
        bucket: "anet.dotted.bucket",
        region: "us-west-1",
        endpoint: "https://s3-accelerate.amazonaws.com",
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        access_key_secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      { allowLoopback: false, lookupFn: async () => [{ address: "52.219.120.1", family: 4 }] },
    );
    expect(dotBucket.ok).toBe(false);
    if (!dotBucket.ok) expect(dotBucket.error).toBe("invalid_bucket");

    // 4. Write-time DNS SSRF validation resolves <bucket>.s3-accelerate.amazonaws.com (NOT bare apex which has no DNS record!)
    const lookedUpHosts: string[] = [];
    const accelDnsOk = await validateStorageConfigUrlsAsync(
      ownerNetworkId,
      {
        provider: "s3",
        bucket: "anet-private-usw1",
        region: "us-west-1",
        endpoint: "https://s3-accelerate.amazonaws.com",
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        access_key_secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      {
        allowLoopback: false,
        lookupFn: async (host) => {
          lookedUpHosts.push(host);
          if (host === "s3-accelerate.amazonaws.com") {
            throw Object.assign(new Error("ENOTFOUND bare apex"), { code: "ENOTFOUND" });
          }
          return [{ address: "52.219.120.1", family: 4 }];
        },
      },
    );
    expect(accelDnsOk.ok).toBe(true);
    expect(lookedUpHosts).toContain("anet-private-usw1.s3-accelerate.amazonaws.com");
    expect(lookedUpHosts).toContain("anet-private-usw1.s3.us-west-1.amazonaws.com");
    expect(lookedUpHosts).not.toContain("s3-accelerate.amazonaws.com");

    // Same for Aliyun OSS Transfer Acceleration (bare oss-accelerate.aliyuncs.com has no DNS record)
    const ossHosts: string[] = [];
    const ossDnsOk = await validateStorageConfigUrlsAsync(
      ownerNetworkId,
      {
        provider: "oss",
        bucket: "anet-private-oss",
        region: "cn-hongkong",
        endpoint: "https://oss-accelerate.aliyuncs.com",
        access_key_id: "LTAI5tMockAccessKeyId",
        access_key_secret: "MockOssSecretKey999999",
      },
      {
        allowLoopback: false,
        lookupFn: async (host) => {
          ossHosts.push(host);
          if (host === "oss-accelerate.aliyuncs.com") {
            throw Object.assign(new Error("ENOTFOUND bare apex"), { code: "ENOTFOUND" });
          }
          return [{ address: "47.88.1.1", family: 4 }];
        },
      },
    );
    expect(ossDnsOk.ok).toBe(true);
    expect(ossHosts).toContain("anet-private-oss.oss-accelerate.aliyuncs.com");
    expect(ossHosts).toContain("anet-private-oss.oss-cn-hongkong.aliyuncs.com");

    // 5. testNetworkStorageConfig sends data-plane HEAD to s3-accelerate, but privacy probes (?acl/?policyStatus/anon) to regional s3.<region>
    const hitUrls: string[] = [];
    const accelFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      hitUrls.push(`${init?.method || "GET"} ${u.hostname}${u.search ? "?" + [...u.searchParams.keys()].sort().join(",") : ""}`);
      if (u.hostname === "anet-private-usw1.s3-accelerate.amazonaws.com" && init?.method === "HEAD") {
        return new Response(null, { status: 404 });
      }
      if (u.hostname === "anet-private-usw1.s3.us-west-1.amazonaws.com") {
        if (u.searchParams.has("acl")) {
          return new Response("<AccessControlPolicy><AccessControlList><Grant><Grantee><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>", { status: 200 });
        }
        if (u.searchParams.has("policyStatus")) {
          return new Response("<PolicyStatus><IsPublic>false</IsPublic></PolicyStatus>", { status: 200 });
        }
        return new Response("AccessDenied", { status: 403 });
      }
      return new Response("unexpected host", { status: 400 });
    }) as unknown as typeof fetch;

    const testAcc = await testNetworkStorageConfig(
      ownerNetworkId,
      {
        provider: "s3",
        bucket: "anet-private-usw1",
        region: "us-west-1",
        endpoint: "https://s3-accelerate.amazonaws.com",
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        access_key_secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      accelFetch,
      { allowLoopback: false, lookupFn: async () => [{ address: "52.219.120.1", family: 4 }] },
    );
    expect(testAcc.ok).toBe(true);
    expect(testAcc.visibility).toBe("private");
    expect(testAcc.message).toContain("传输加速");
    expect(hitUrls.some((h) => h.startsWith("HEAD anet-private-usw1.s3-accelerate.amazonaws.com"))).toBe(true);
    expect(hitUrls.some((h) => h.includes("anet-private-usw1.s3.us-west-1.amazonaws.com") && h.includes("acl"))).toBe(true);
    expect(hitUrls.some((h) => h.includes("anet-private-usw1.s3.us-west-1.amazonaws.com") && h.includes("policyStatus"))).toBe(true);

    // 6. Unconfigured Transfer Acceleration (HTTP 400 from accelerate endpoint) returns actionable Chinese guidance
    const unconfiguredAcc = await testNetworkStorageConfig(
      ownerNetworkId,
      {
        provider: "s3",
        bucket: "anet-private-usw1",
        region: "us-west-1",
        endpoint: "https://s3-accelerate.amazonaws.com",
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        access_key_secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      (async () => new Response(null, { status: 400 })) as unknown as typeof fetch,
      { allowLoopback: false, lookupFn: async () => [{ address: "52.219.120.1", family: 4 }] },
    );
    expect(unconfiguredAcc.ok).toBe(false);
    expect(unconfiguredAcc.message).toContain("Transfer Acceleration");
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

    // Test connection: Public repo MUST be hard-rejected (strict private-only policy!)
    mockRepoVisibility = 5;
    const testPubRes = await fetch(`${hubBase}/api/storage/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ network_id: ownerNetworkId }),
    });
    expect(testPubRes.status).toBe(400);
    const testPub: any = await testPubRes.json();
    expect(testPub.ok).toBe(false);
    expect(testPub.error).toBe("public_storage_forbidden");
    expect(testPub.visibility).toBe("public");

    // Saving enabled=true against a public ModelScope repo is also hard-rejected at write time!
    const putPubRes = await fetch(`${hubBase}/api/storage/config`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        enabled: true,
        provider: "modelscope",
        repo_id: "owner/relay-repo",
        endpoint: mockProviderBase,
      }),
    });
    expect(putPubRes.status).toBe(400);
    const putPub: any = await putPubRes.json();
    expect(putPub.ok).toBe(false);
    expect(putPub.error).toBe("public_storage_forbidden");

    // Unknown visibility also fails closed
    mockRepoVisibility = undefined;
    const testUnknownRes = await fetch(`${hubBase}/api/storage/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ network_id: ownerNetworkId }),
    });
    expect(testUnknownRes.status).toBe(400);
    const testUnknown: any = await testUnknownRes.json();
    expect(testUnknown.ok).toBe(false);
    expect(testUnknown.error).toBe("public_storage_forbidden");
    expect(testUnknown.visibility).toBe("unknown");

    // Disabling (enabled=false) always succeeds even if repo is not private/reachable
    const disableRes = await fetch(`${hubBase}/api/storage/config`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        enabled: false,
        provider: "modelscope",
        repo_id: "owner/relay-repo",
        endpoint: mockProviderBase,
      }),
    });
    expect(disableRes.status).toBe(200);
    expect((await disableRes.json() as any).enabled).toBe(false);

    // Restore private & re-enable for subsequent E2E lifecycle tests
    mockRepoVisibility = 1;
    const reEnableRes = await fetch(`${hubBase}/api/storage/config`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        enabled: true,
        provider: "modelscope",
        repo_id: "owner/relay-repo",
        endpoint: mockProviderBase,
      }),
    });
    expect(reEnableRes.status).toBe(200);
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

    // 7. Second presign of identical sha256 triggers LFS dedup (skip_upload = true!)
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

  test("strict private-only policy: blocks public_base_url, public OSS/S3 buckets (anon list/read/ACL/policy), and ignores legacy public_base_url", async () => {
    const { signObjectStoragePresignedUrl, resolveStorageDownload } = await import("./storage-relay.js");

    // 1. Subresource signing formats `?acl` per provider spec (OSS omits "=", AWS requires "=")
    const fixedDate = new Date("2026-11-27T12:00:00Z");
    const ossAclUrl = signObjectStoragePresignedUrl({
      provider: "oss",
      method: "GET",
      bucket: "anet-private",
      region: "oss-cn-hangzhou",
      objectKey: "",
      extraQuery: [["acl", ""]],
      accessKeyId: "LTAI5tTestAccessKey",
      accessKeySecret: "SecretValue1234567890",
      expiresSeconds: 120,
      now: fixedDate,
    });
    expect(ossAclUrl).toContain("?acl&x-oss-credential=");
    const s3AclUrl = signObjectStoragePresignedUrl({
      provider: "s3",
      method: "GET",
      bucket: "anet-private",
      region: "us-west-2",
      objectKey: "",
      extraQuery: [["acl", ""]],
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      accessKeySecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresSeconds: 120,
      now: fixedDate,
    });
    expect(s3AclUrl).toContain("&acl=&X-Amz-Signature=");

    // 2. Any non-empty public_base_url is rejected even for valid public HTTPS CDN URLs
    const cdnPut = await fetch(`${hubBase}/api/storage/config`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        enabled: true,
        provider: "oss",
        bucket: "anet-oss-bucket",
        region: "oss-cn-hangzhou",
        endpoint: mockProviderBase,
        public_base_url: "https://cdn.example.com/public",
        access_key_id: "LTAI5tMockAccessKeyId",
        access_key_secret: "MockOssSecretKey999999",
      }),
    });
    expect(cdnPut.status).toBe(400);
    expect((await cdnPut.json() as any).error).toBe("invalid_public_base_url");

    const putBucket = (provider: "oss" | "s3") => fetch(`${hubBase}/api/storage/config`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        enabled: true,
        provider,
        bucket: provider === "oss" ? "anet-oss-bucket" : "anet-s3-bucket",
        region: provider === "oss" ? "oss-cn-hangzhou" : "us-west-2",
        endpoint: mockProviderBase,
        access_key_id: "LTAI5tMockAccessKeyId",
        access_key_secret: "MockSecretKey999999",
      }),
    });

    try {
      // 3. Anonymous listable bucket -> hard-rejected on PUT & test
      mockBucketPublicList = true;
      const pubListPut = await putBucket("oss");
      expect(pubListPut.status).toBe(400);
      expect((await pubListPut.json() as any).error).toBe("public_storage_forbidden");
      mockBucketPublicList = false;

      // 4. Anonymous readable object -> hard-rejected
      mockBucketPublicObjectRead = true;
      const pubObjPut = await putBucket("s3");
      expect(pubObjPut.status).toBe(400);
      expect((await pubObjPut.json() as any).error).toBe("public_storage_forbidden");
      mockBucketPublicObjectRead = false;

      // 5. OSS public-read & public-read-write ACL -> hard-rejected
      for (const mode of ["oss-public-read", "oss-public-read-write"] as const) {
        mockBucketAclMode = mode;
        const r = await putBucket("oss");
        expect(r.status).toBe(400);
        expect((await r.json() as any).error).toBe("public_storage_forbidden");
      }
      mockBucketAclMode = "private";

      // 6. OSS wildcard bucket policy (Principal="*") -> hard-rejected
      mockBucketPolicyPublic = true;
      const ossPolPut = await putBucket("oss");
      expect(ossPolPut.status).toBe(400);
      expect((await ossPolPut.json() as any).error).toBe("public_storage_forbidden");
      mockBucketPolicyPublic = false;

      // 7. S3 AllUsers / AuthenticatedUsers ACL -> hard-rejected
      for (const mode of ["s3-all-users", "s3-auth-users"] as const) {
        mockBucketAclMode = mode;
        const r = await putBucket("s3");
        expect(r.status).toBe(400);
        expect((await r.json() as any).error).toBe("public_storage_forbidden");
      }
      mockBucketAclMode = "private";

      // 8. S3 GetBucketPolicyStatus IsPublic=true -> hard-rejected
      mockBucketPolicyStatus = "public";
      const s3PsPut = await putBucket("s3");
      expect(s3PsPut.status).toBe(400);
      expect((await s3PsPut.json() as any).error).toBe("public_storage_forbidden");

      // 9. S3-compatible store returning 501 for ?policyStatus falls back to ?policy JSON
      mockBucketPolicyStatus = "unsupported";
      mockBucketPolicyPublic = true;
      const s3CompatPut = await putBucket("s3");
      expect(s3CompatPut.status).toBe(400);
      expect((await s3CompatPut.json() as any).error).toBe("public_storage_forbidden");
      mockBucketPolicyPublic = false;
      mockBucketPolicyStatus = "private";

      // 10. Private S3 bucket with minimal IAM (?acl returns 403) passes cleanly with visibility=private
      mockBucketAclMode = "forbidden";
      const privS3Put = await putBucket("s3");
      expect(privS3Put.status).toBe(200);
      const privS3Test: any = await fetch(`${hubBase}/api/storage/test`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ network_id: ownerNetworkId }),
      }).then((r) => r.json());
      expect(privS3Test.ok).toBe(true);
      expect(privS3Test.visibility).toBe("private");

      // 11. resolveStorageDownload ignores legacy public_base_url metadata and ALWAYS signs privately
      const dl = resolveStorageDownload(ownerNetworkId, {
        provider: "s3",
        object_key: "anet-files/net/2026-11-28/legacy.png",
        sha256: "c".repeat(64),
        bucket: "anet-s3-bucket",
        region: "us-west-2",
        endpoint: mockProviderBase,
        public_base_url: "https://cdn.example.com/should-never-be-used",
      });
      expect(dl.ok).toBe(true);
      if (dl.ok) {
        expect(dl.url).not.toContain("cdn.example.com");
        expect(dl.url).toContain("X-Amz-Signature=");
      }
    } finally {
      mockBucketPublicList = false;
      mockBucketPublicObjectRead = false;
      mockBucketAclMode = "private";
      mockBucketPolicyStatus = "private";
      mockBucketPolicyPublic = false;
      await fetch(`${hubBase}/api/storage/config?network_id=${ownerNetworkId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
    }
  });

  test("ModelScope live empty-objects dedup, concurrent commit coalescing, and 429 lock-busy retry", async () => {
    const putMs = await fetch(`${hubBase}/api/storage/config`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        enabled: true,
        provider: "modelscope",
        repo_id: "owner/batch-repo",
        endpoint: mockProviderBase,
        api_token: mockExpectedToken,
      }),
    });
    expect(putMs.status).toBe(200);

    const commitsBefore = lfsCommits.length;
    try {
      // 1. Live ModelScope returns Data: { objects: [] } when blob already exists -> skip_upload=true
      const existingBytes = Buffer.from("modelscope-empty-objects-dedup-bytes");
      const existingSha = createHash("sha256").update(existingBytes).digest("hex");
      lfsObjects.set(existingSha, new Uint8Array(existingBytes));
      mockModelScopeEmptyObjectsDedup = true;

      const dedupPresign: any = await fetch(`${hubBase}/api/uploads/presign`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          network_id: ownerNetworkId,
          name: "dedup-empty.png",
          mime: "image/png",
          size: existingBytes.length,
          sha256: existingSha,
        }),
      }).then((r) => r.json());
      expect(dedupPresign.ok).toBe(true);
      expect(dedupPresign.skip_upload).toBe(true);
      expect(dedupPresign.upload).toBeNull();

      // 2. Concurrent /complete calls coalesce into a single commit AND survive a 429 commit-lock-busy response
      const otherBytes1 = Buffer.from("batch-item-1-bytes");
      const otherBytes2 = Buffer.from("batch-item-2-bytes");
      const sha1 = createHash("sha256").update(otherBytes1).digest("hex");
      const sha2 = createHash("sha256").update(otherBytes2).digest("hex");
      lfsObjects.set(sha1, new Uint8Array(otherBytes1));
      lfsObjects.set(sha2, new Uint8Array(otherBytes2));

      const [p1, p2] = await Promise.all([
        fetch(`${hubBase}/api/uploads/presign`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ network_id: ownerNetworkId, name: "b1.png", mime: "image/png", size: otherBytes1.length, sha256: sha1 }),
        }).then((r) => r.json() as Promise<any>),
        fetch(`${hubBase}/api/uploads/presign`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ network_id: ownerNetworkId, name: "b2.png", mime: "image/png", size: otherBytes2.length, sha256: sha2 }),
        }).then((r) => r.json() as Promise<any>),
      ]);
      expect(p1.ok && p2.ok).toBe(true);

      // Inject 1 transient 429 Code 10030000001 ("commit lock busy") on the batched commit
      mockCommitBusyFailuresRemaining = 1;
      const [c0, c1, c2] = await Promise.all([dedupPresign.file_id, p1.file_id, p2.file_id].map((fileId) =>
        fetch(`${hubBase}/api/uploads/complete`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: fileId }),
        }).then((r) => r.json() as Promise<any>),
      ));
      expect(c0.ok).toBe(true);
      expect(c1.ok).toBe(true);
      expect(c2.ok).toBe(true);
      expect(mockCommitBusyFailuresRemaining).toBe(0);

      // All 3 concurrent completions landed in ONE coalesced Git commit!
      const newCommits = lfsCommits.slice(commitsBefore);
      expect(newCommits.length).toBe(1);
      expect(newCommits[0].actions.length).toBe(3);
    } finally {
      mockModelScopeEmptyObjectsDedup = false;
      mockCommitBusyFailuresRemaining = 0;
      await fetch(`${hubBase}/api/storage/config?network_id=${ownerNetworkId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
    }
  });
});

describe("Storage Relay SSRF Hardening (#5719)", () => {
  test("isForbiddenStorageIp blocks RFC1918, 127/8, 169.254/16, 100.64/10, 0/8, multicast, ::, ::1, fc00::/7, fe80::/10, and IPv4-mapped IPv6", async () => {
    const { isForbiddenStorageIp } = await import("./storage-relay.js");

    const alwaysForbidden = [
      // RFC1918
      "10.0.0.0", "10.0.0.1", "10.255.255.254",
      "172.16.0.0", "172.16.0.1", "172.24.10.20", "172.31.255.255",
      "192.168.0.0", "192.168.1.1", "192.168.255.254",
      // Link-local & cloud metadata
      "169.254.0.1", "169.254.169.254", "169.254.255.254",
      // CGNAT (RFC6598, incl. Aliyun 100.100.100.200 metadata)
      "100.64.0.0", "100.64.0.1", "100.100.100.200", "100.127.255.255",
      // Unspecified / multicast / reserved
      "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
      // IPv6 unspecified / ULA (full fc00::/7) / link-local (full fe80::/10) / multicast
      "::", "0:0:0:0:0:0:0:0",
      "fc00::1", "fcff::1", "fd00::1", "fd12:3456:789a::1", "fdff:ffff::1",
      "fe80::1", "fe80::1%eth0", "fe90::1", "fea0::1", "febf:ffff::1",
      "fec0::1", "ff02::1",
      // IPv4-mapped IPv6 (both dotted-quad and URL-normalized hex form) + NAT64 + 6to4
      "::ffff:10.0.0.1", "::ffff:a00:1",
      "::ffff:172.16.0.1", "::ffff:192.168.1.1",
      "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::FFFF:169.254.169.254",
      "::ffff:100.64.0.1", "::ffff:0.0.0.0",
      "::10.0.0.1", "64:ff9b::10.0.0.1", "2002:0a00:0001::1",
      // Malformed / non-IP fails closed
      "", "not-an-ip", "999.0.0.1",
    ];
    for (const ip of alwaysForbidden) {
      expect(isForbiddenStorageIp(ip)).toBe(true);
      // Even when loopback is opted in for tests, non-loopback internal ranges MUST remain forbidden!
      expect(isForbiddenStorageIp(ip, { allowLoopback: true })).toBe(true);
    }

    const loopbackIps = [
      "127.0.0.1", "127.0.0.0", "127.255.255.254",
      "::1", "[::1]", "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1", "::ffff:7f00:1",
    ];
    for (const ip of loopbackIps) {
      expect(isForbiddenStorageIp(ip)).toBe(true);
      expect(isForbiddenStorageIp(ip, { allowLoopback: false })).toBe(true);
      expect(isForbiddenStorageIp(ip, { allowLoopback: true })).toBe(false);
    }

    const publicIps = [
      "1.1.1.1", "8.8.8.8", "47.96.1.1", "93.184.216.34",
      // Adjacent boundaries outside private/CGNAT ranges
      "172.15.255.255", "172.32.0.1", "192.167.255.255", "192.169.0.1",
      "100.63.255.255", "100.128.0.1",
      // Public IPv6 & public IPv4-mapped IPv6
      "2606:4700:4700::1111", "2408:4001::1", "::ffff:93.184.216.34",
    ];
    for (const ip of publicIps) {
      expect(isForbiddenStorageIp(ip)).toBe(false);
    }
  });

  test("validateStorageUrl rejects private/loopback/obfuscated/non-https URLs by default and honors test loopback opt-in only for loopback", async () => {
    const { validateStorageUrl } = await import("./storage-relay.js");

    const blockedByDefault = [
      "https://10.0.0.1",
      "https://172.16.0.1",
      "https://172.31.255.254",
      "https://192.168.1.1",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1",
      "https://100.100.100.200",
      "https://0.0.0.0",
      "https://127.0.0.1",
      "http://127.0.0.1:9200",
      "https://127.255.0.1",
      "https://localhost",
      "http://localhost:9200",
      "https://sub.localhost",
      "https://[::1]",
      "http://[::1]:9200",
      "https://[::]",
      "https://[fc00::1]",
      "https://[fd12:3456::1]",
      "https://[fe80::1]",
      "https://[febf::1]",
      "https://[::ffff:10.0.0.1]",
      "https://[::ffff:169.254.169.254]",
      "https://[::ffff:127.0.0.1]",
      // Obfuscated integer / hex / octal IPv4 forms normalized by URL parser
      "https://2130706433",
      "https://0x7f000001",
      "https://0xa9fea9fe",
      "https://0177.0.0.1",
      // Non-https & embedded credentials
      "http://www.modelscope.cn",
      "https://user:pass@www.modelscope.cn",
      "file:///etc/passwd",
      "ftp://files.example.com",
    ];
    for (const bad of blockedByDefault) {
      const res = validateStorageUrl(bad, "invalid_endpoint", { allowLoopback: false });
      expect(res.ok).toBe(false);
    }

    // Public HTTPS & blank (use default endpoint) allowed
    expect(validateStorageUrl("https://www.modelscope.cn", "invalid_endpoint", { allowLoopback: false }).ok).toBe(true);
    expect(validateStorageUrl("", "invalid_endpoint", { allowLoopback: false }).ok).toBe(true);

    // Explicit test opt-in allows loopback ONLY; RFC1918/link-local/CGNAT/ULA/plain-http-public remain blocked
    expect(validateStorageUrl("http://127.0.0.1:18080", "invalid_endpoint", { allowLoopback: true }).ok).toBe(true);
    expect(validateStorageUrl("http://localhost:18080", "invalid_endpoint", { allowLoopback: true }).ok).toBe(true);
    expect(validateStorageUrl("http://[::1]:18080", "invalid_endpoint", { allowLoopback: true }).ok).toBe(true);
    expect(validateStorageUrl("https://10.0.0.1", "invalid_endpoint", { allowLoopback: true }).ok).toBe(false);
    expect(validateStorageUrl("https://169.254.169.254", "invalid_endpoint", { allowLoopback: true }).ok).toBe(false);
    expect(validateStorageUrl("https://100.64.0.1", "invalid_endpoint", { allowLoopback: true }).ok).toBe(false);
    expect(validateStorageUrl("https://[fc00::1]", "invalid_endpoint", { allowLoopback: true }).ok).toBe(false);
    expect(validateStorageUrl("https://[fe80::1]", "invalid_endpoint", { allowLoopback: true }).ok).toBe(false);
    expect(validateStorageUrl("http://www.modelscope.cn", "invalid_endpoint", { allowLoopback: true }).ok).toBe(false);
  });

  test("assertSafeStorageUrl checks DNS-resolved IPs and fails closed on DNS errors or empty results", async () => {
    const { assertSafeStorageUrl, StorageSsrfError } = await import("./storage-relay.js");

    // Public IPv4 + IPv6 DNS resolution succeeds
    const ok = await assertSafeStorageUrl("https://storage.public.example", {
      allowLoopback: false,
      lookupFn: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ],
    });
    expect(ok.hostname).toBe("storage.public.example");

    // Every forbidden CIDR resolved via DNS MUST be rejected
    const dnsForbiddenTargets = [
      { address: "10.0.0.5", family: 4 },
      { address: "172.16.4.2", family: 4 },
      { address: "192.168.10.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
      { address: "169.254.169.254", family: 4 },
      { address: "100.64.0.10", family: 4 },
      { address: "0.0.0.0", family: 4 },
      { address: "::1", family: 6 },
      { address: "::", family: 6 },
      { address: "fc00::1", family: 6 },
      { address: "fd12:3456::1", family: 6 },
      { address: "fe80::1", family: 6 },
      { address: "febf::1", family: 6 },
      { address: "::ffff:10.0.0.1", family: 6 },
      { address: "::ffff:169.254.169.254", family: 6 },
    ];
    for (const rec of dnsForbiddenTargets) {
      await expect(
        assertSafeStorageUrl("https://rebind.evil.example", {
          allowLoopback: false,
          lookupFn: async () => [rec],
        }),
      ).rejects.toMatchObject({ name: "StorageSsrfError", code: "storage_ssrf_blocked" });
    }

    // Mixed public + private DNS records MUST reject (cannot cherry-pick safe record)
    await expect(
      assertSafeStorageUrl("https://dual-homed.evil.example", {
        allowLoopback: false,
        lookupFn: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toBeInstanceOf(StorageSsrfError);

    // DNS empty result -> FAIL CLOSED
    await expect(
      assertSafeStorageUrl("https://empty.dns.example", {
        allowLoopback: false,
        lookupFn: async () => [],
      }),
    ).rejects.toMatchObject({ name: "StorageSsrfError", code: "storage_ssrf_dns_failed" });

    // DNS lookup exception -> FAIL CLOSED
    await expect(
      assertSafeStorageUrl("https://nxdomain.example", {
        allowLoopback: false,
        lookupFn: async () => {
          const err: any = new Error("getaddrinfo ENOTFOUND nxdomain.example");
          err.code = "ENOTFOUND";
          throw err;
        },
      }),
    ).rejects.toMatchObject({ name: "StorageSsrfError", code: "storage_ssrf_dns_failed" });

    // Domain resolving to loopback is rejected by default, allowed ONLY with allowLoopback=true
    await expect(
      assertSafeStorageUrl("https://localtest.example", {
        allowLoopback: false,
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).rejects.toMatchObject({ code: "storage_ssrf_blocked" });
    const lbOk = await assertSafeStorageUrl("https://localtest.example", {
      allowLoopback: true,
      lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    expect(lbOk.addresses[0].address).toBe("127.0.0.1");
  });

  test("safeStorageFetch re-validates every redirect target, blocks hops to internal IPs/DNS failures, and strips auth on cross-origin redirect", async () => {
    const { safeStorageFetch } = await import("./storage-relay.js");

    // 1. Redirect to literal metadata IP -> blocked BEFORE second hop fetch
    let calls = 0;
    await expect(
      safeStorageFetch(
        "https://public.example/start",
        { headers: { Authorization: "Bearer secret", Cookie: "m_session_id=secret" } },
        {
          allowLoopback: false,
          lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
          fetchFn: (async () => {
            calls++;
            return new Response(null, { status: 302, headers: { Location: "https://169.254.169.254/latest/meta-data" } });
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "storage_ssrf_blocked" });
    expect(calls).toBe(1);

    // 2. Redirect to domain resolving to RFC1918 IP -> blocked BEFORE second hop fetch
    calls = 0;
    await expect(
      safeStorageFetch(
        "https://public.example/start",
        {},
        {
          allowLoopback: false,
          lookupFn: async (host) =>
            host === "public.example"
              ? [{ address: "93.184.216.34", family: 4 }]
              : [{ address: "10.0.0.8", family: 4 }],
          fetchFn: (async () => {
            calls++;
            return new Response(null, { status: 302, headers: { Location: "https://internal.corp.example/admin" } });
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "storage_ssrf_blocked" });
    expect(calls).toBe(1);

    // 3. Redirect to HTTPS -> HTTP downgrade -> blocked
    calls = 0;
    await expect(
      safeStorageFetch(
        "https://public.example/start",
        {},
        {
          allowLoopback: false,
          lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
          fetchFn: (async () => {
            calls++;
            return new Response(null, { status: 302, headers: { Location: "http://public.example/insecure" } });
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "storage_ssrf_blocked" });
    expect(calls).toBe(1);

    // 4. Cross-origin redirect between two public hosts -> allowed AND strips Authorization & Cookie!
    const seenHeaders: Array<{ url: string; auth: string | null; cookie: string | null }> = [];
    const okRes = await safeStorageFetch(
      "https://origin-a.example/file",
      { headers: { Authorization: "Bearer ms_secret", Cookie: "m_session_id=ms_secret" } },
      {
        allowLoopback: false,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
          const u = String(url);
          const h = new Headers(init?.headers);
          seenHeaders.push({ url: u, auth: h.get("Authorization"), cookie: h.get("Cookie") });
          if (u.startsWith("https://origin-a.example/")) {
            return new Response(null, { status: 302, headers: { Location: "https://cdn-b.example/blob" } });
          }
          return new Response("ok-body", { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.text()).toBe("ok-body");
    expect(seenHeaders).toHaveLength(2);
    expect(seenHeaders[0].auth).toBe("Bearer ms_secret");
    expect(seenHeaders[0].cookie).toBe("m_session_id=ms_secret");
    expect(seenHeaders[1].auth).toBeNull();
    expect(seenHeaders[1].cookie).toBeNull();

    // 5. Redirect loop exceeding cap -> rejected
    let loopCount = 0;
    await expect(
      safeStorageFetch(
        "https://loop.example/0",
        {},
        {
          allowLoopback: false,
          maxRedirects: 2,
          lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
          fetchFn: (async () => {
            loopCount++;
            return new Response(null, { status: 302, headers: { Location: `https://loop.example/${loopCount}` } });
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "storage_ssrf_too_many_redirects" });
    expect(loopCount).toBe(3);
  });

  test("driver operations (test/presign/complete) block DNS-resolved private IPs before any outbound fetch", async () => {
    const {
      testNetworkStorageConfig,
      presignStorageUpload,
      completeStorageUpload,
      validateStorageConfigUrlsAsync,
    } = await import("./storage-relay.js");

    let fetchCalled = 0;
    const neverCalledFetch = (async () => {
      fetchCalled++;
      return new Response("should not be reached", { status: 200 });
    }) as unknown as typeof fetch;

    const privateLookup = async () => [{ address: "10.0.0.42", family: 4 }];
    const emptyLookup = async () => [];
    const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

    // Write-time async DNS validation blocks domains resolving to private IP or failing DNS
    const writePriv = await validateStorageConfigUrlsAsync(
      ownerNetworkId,
      {
        provider: "modelscope",
        repo_id: "owner/relay-repo",
        endpoint: "https://evil-internal.example",
        api_token: "ms_test_secret_token_9876543210",
      },
      { allowLoopback: false, lookupFn: privateLookup },
    );
    expect(writePriv.ok).toBe(false);
    if (!writePriv.ok) expect(writePriv.error).toBe("invalid_endpoint");

    const writeEmptyDns = await validateStorageConfigUrlsAsync(
      ownerNetworkId,
      {
        provider: "modelscope",
        repo_id: "owner/relay-repo",
        public_base_url: "https://nxdomain.cdn.example",
        api_token: "ms_test_secret_token_9876543210",
      },
      { allowLoopback: false, lookupFn: emptyLookup },
    );
    expect(writeEmptyDns.ok).toBe(false);
    if (!writeEmptyDns.ok) expect(writeEmptyDns.error).toBe("invalid_public_base_url");

    const writePublicOk = await validateStorageConfigUrlsAsync(
      ownerNetworkId,
      {
        provider: "modelscope",
        repo_id: "owner/relay-repo",
        endpoint: "https://storage.public.example",
        api_token: "ms_test_secret_token_9876543210",
      },
      { allowLoopback: false, lookupFn: publicLookup },
    );
    expect(writePublicOk.ok).toBe(true);

    const testRes = await testNetworkStorageConfig(
      ownerNetworkId,
      {
        provider: "modelscope",
        repo_id: "owner/relay-repo",
        endpoint: "https://evil-internal.example",
        api_token: "ms_test_secret_token_9876543210",
      },
      neverCalledFetch,
      { allowLoopback: false, lookupFn: privateLookup },
    );
    expect(testRes.ok).toBe(false);
    expect(testRes.error).toBe("storage_ssrf_blocked");
    expect(fetchCalled).toBe(0);

    const testDnsEmpty = await testNetworkStorageConfig(
      ownerNetworkId,
      {
        provider: "oss",
        bucket: "my-bucket",
        region: "cn-hangzhou",
        endpoint: "https://no-dns.example",
        access_key_id: "LTAI5tMockAccessKeyId",
        access_key_secret: "MockOssSecretKey999999",
      },
      neverCalledFetch,
      { allowLoopback: false, lookupFn: emptyLookup },
    );
    expect(testDnsEmpty.ok).toBe(false);
    expect(testDnsEmpty.error).toBe("storage_ssrf_dns_failed");
    expect(fetchCalled).toBe(0);

    const cfg = {
      network_id: ownerNetworkId,
      enabled: true,
      provider: "modelscope" as const,
      endpoint: "https://evil-internal.example",
      region: "",
      bucket: "",
      repo_id: "owner/relay-repo",
      repo_type: "dataset" as const,
      revision: "master",
      prefix: "anet-files",
      public_base_url: "",
      max_file_bytes: 100 * 1024 * 1024,
      secrets: { token: "ms_test_secret_token_9876543210" },
    };

    const presignRes = await presignStorageUpload(
      cfg,
      {
        networkId: ownerNetworkId,
        dateBucket: "2026-11-27",
        fileId: "f_ssrf_1",
        ext: ".bin",
        size: 10,
        sha256: "a".repeat(64),
        mime: "application/octet-stream",
      },
      neverCalledFetch,
      { allowLoopback: false, lookupFn: privateLookup },
    );
    expect(presignRes.ok).toBe(false);
    if (!presignRes.ok) {
      expect(presignRes.status).toBe(400);
      expect(presignRes.error).toBe("storage_ssrf_blocked");
    }
    expect(fetchCalled).toBe(0);

    const completeRes = await completeStorageUpload(
      cfg,
      {
        fileId: "f_ssrf_1",
        size: 10,
        storage: {
          provider: "modelscope",
          object_key: "anet-files/net/2026-11-27/f_ssrf_1.bin",
          sha256: "a".repeat(64),
          repo_id: "owner/relay-repo",
          repo_type: "dataset",
          revision: "master",
          endpoint: "https://evil-internal.example",
        },
      },
      neverCalledFetch,
      { allowLoopback: false, lookupFn: privateLookup },
    );
    expect(completeRes.ok).toBe(false);
    if (!completeRes.ok) {
      expect(completeRes.status).toBe(400);
      expect(completeRes.error).toBe("storage_ssrf_blocked");
    }
    expect(fetchCalled).toBe(0);

    // Malicious ModelScope LFS response returning an internal uploadAction.href is rejected
    const poisonedHrefRes = await presignStorageUpload(
      { ...cfg, endpoint: "https://storage.public.example" },
      {
        networkId: ownerNetworkId,
        dateBucket: "2026-11-27",
        fileId: "f_ssrf_2",
        ext: ".bin",
        size: 10,
        sha256: "b".repeat(64),
        mime: "application/octet-stream",
      },
      (async () =>
        Response.json({
          objects: [{ oid: "b".repeat(64), size: 10, actions: { upload: { href: "https://169.254.169.254/latest/meta-data" } } }],
        })) as unknown as typeof fetch,
      { allowLoopback: false, lookupFn: publicLookup },
    );
    expect(poisonedHrefRes.ok).toBe(false);
    if (!poisonedHrefRes.ok) {
      expect(poisonedHrefRes.error).toBe("storage_presign_bad_response");
    }
  });

  test("HTTP /api/storage/config & /api/storage/test reject private/loopback endpoints in production mode and block redirect-to-metadata SSRF", async () => {
    // 1. Production mode (ANET_STORAGE_ALLOW_LOOPBACK unset): all internal & loopback URLs return 400
    delete process.env.ANET_STORAGE_ALLOW_LOOPBACK;
    try {
      const forbiddenEndpoints = [
        "https://10.0.0.1",
        "https://172.16.0.1",
        "https://192.168.1.1",
        "https://169.254.169.254",
        "https://100.64.0.1",
        "https://127.0.0.1",
        mockProviderBase,
        "https://localhost",
        "https://[::1]",
        "https://[fc00::1]",
        "https://[fd12:3456::1]",
        "https://[fe80::1]",
        "https://[febf::1]",
        "https://[::ffff:169.254.169.254]",
      ];
      for (const ep of forbiddenEndpoints) {
        const putRes = await fetch(`${hubBase}/api/storage/config`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            network_id: ownerNetworkId,
            provider: "modelscope",
            repo_id: "owner/relay-repo",
            endpoint: ep,
            api_token: mockExpectedToken,
          }),
        });
        expect(putRes.status).toBe(400);
        const putBody: any = await putRes.json();
        expect(putBody.ok).toBe(false);
        expect(putBody.error).toBe("invalid_endpoint");

        const testRes = await fetch(`${hubBase}/api/storage/test`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            network_id: ownerNetworkId,
            provider: "modelscope",
            repo_id: "owner/relay-repo",
            endpoint: ep,
            api_token: mockExpectedToken,
          }),
        });
        expect(testRes.status).toBe(400);
        const testBody: any = await testRes.json();
        expect(testBody.ok).toBe(false);
      }

      // Also reject private public_base_url
      const badPub = await fetch(`${hubBase}/api/storage/config`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          network_id: ownerNetworkId,
          provider: "modelscope",
          repo_id: "owner/relay-repo",
          public_base_url: "https://169.254.169.254/bucket",
          api_token: mockExpectedToken,
        }),
      });
      expect(badPub.status).toBe(400);
      expect((await badPub.json() as any).error).toBe("invalid_public_base_url");
    } finally {
      process.env.ANET_STORAGE_ALLOW_LOOPBACK = "1";
    }

    // 2. Live HTTP redirect-to-metadata trap: even with loopback enabled for the mock provider,
    // a 302 redirect to 169.254.169.254 MUST be blocked by safeStorageFetch on BOTH /api/storage/test AND legacy /api/files/:id!
    const redirectTest = await fetch(`${hubBase}/api/storage/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        provider: "modelscope",
        repo_id: "owner/ssrf-redirect-repo",
        endpoint: mockProviderBase,
        api_token: mockExpectedToken,
      }),
    });
    expect(redirectTest.status).toBe(400);
    const redirectBody: any = await redirectTest.json();
    expect(redirectBody.ok).toBe(false);
    expect(redirectBody.error).toBe("storage_ssrf_blocked");

    // 3. Legacy GET /api/files/:id private ModelScope proxy also blocks 302 redirect to metadata IP
    const putProxyCfg = await fetch(`${hubBase}/api/storage/config`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        enabled: true,
        provider: "modelscope",
        repo_id: "owner/ssrf-proxy-redirect",
        endpoint: mockProviderBase,
        api_token: mockExpectedToken,
      }),
    });
    expect(putProxyCfg.status).toBe(200);
    const proxyPayload = Buffer.from("proxy-redirect-trap-bytes");
    const proxySha = createHash("sha256").update(proxyPayload).digest("hex");
    const proxyPresign: any = await fetch(`${hubBase}/api/uploads/presign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network_id: ownerNetworkId,
        name: "trap.bin",
        mime: "application/octet-stream",
        size: proxyPayload.length,
        sha256: proxySha,
      }),
    }).then((r) => r.json());
    expect(proxyPresign.ok).toBe(true);
    await fetch(proxyPresign.upload.url, { method: "PUT", headers: proxyPresign.upload.headers, body: proxyPayload });
    const proxyComplete: any = await fetch(`${hubBase}/api/uploads/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: proxyPresign.file_id }),
    }).then((r) => r.json());
    expect(proxyComplete.ok).toBe(true);

    const legacyRedirectRes = await fetch(`${hubBase}/api/files/${proxyPresign.file_id}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(legacyRedirectRes.status).toBe(400);
    const legacyRedirectBody: any = await legacyRedirectRes.json();
    expect(legacyRedirectBody.ok).toBe(false);
    expect(legacyRedirectBody.error).toBe("storage_ssrf_blocked");

    // Clean up storage config after SSRF E2E test
    await fetch(`${hubBase}/api/storage/config?network_id=${ownerNetworkId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
  });
});
