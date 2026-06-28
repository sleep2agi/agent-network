import { describe, expect, test } from "bun:test";
import {
  assertSecureTlsEnv,
  classifyProbeResponse,
  safelyFetchProbe,
} from "./probe-daemon.js";

describe("assertSecureTlsEnv (boot guard)", () => {
  test("clean env passes", () => {
    expect(() => assertSecureTlsEnv({})).not.toThrow();
  });
  test("NODE_TLS_REJECT_UNAUTHORIZED=0 throws", () => {
    expect(() => assertSecureTlsEnv({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }))
      .toThrow(/probe_tls_insecure_disabled/);
  });
});

describe("classifyProbeResponse — status enum mapping", () => {
  test("200 → ok", () => {
    const r = classifyProbeResponse({ resp: { status: 200 } as Response, errorKind: null }, "p", 150);
    expect(r.status).toBe("ok");
    expect(r.raw_status_code).toBe(200);
    expect(r.latency_ms).toBe(150);
  });
  test("401 → auth_fail", () => {
    expect(classifyProbeResponse({ resp: { status: 401 } as Response, errorKind: null }, "p", 50).status).toBe("auth_fail");
  });
  test("403 → auth_fail", () => {
    expect(classifyProbeResponse({ resp: { status: 403 } as Response, errorKind: null }, "p", 50).status).toBe("auth_fail");
  });
  test("429 → quota", () => {
    expect(classifyProbeResponse({ resp: { status: 429 } as Response, errorKind: null }, "p", 50).status).toBe("quota");
  });
  test("500 → vendor_5xx", () => {
    expect(classifyProbeResponse({ resp: { status: 500 } as Response, errorKind: null }, "p", 50).status).toBe("vendor_5xx");
  });
  test("404 → other_4xx", () => {
    expect(classifyProbeResponse({ resp: { status: 404 } as Response, errorKind: null }, "p", 50).status).toBe("other_4xx");
  });
  test("errorKind=redirect_forbidden surfaces directly", () => {
    expect(classifyProbeResponse({ errorKind: "redirect_forbidden", errorDetail: "302" }, "p", 5).status).toBe("redirect_forbidden");
  });
  test("errorKind=timeout surfaces", () => {
    expect(classifyProbeResponse({ errorKind: "timeout", errorDetail: "..." }, "p", 30000).status).toBe("timeout");
  });
  test("errorKind=probe_resolve_unsafe_ip → returned status string passes through", () => {
    const r = classifyProbeResponse({ errorKind: "probe_resolve_unsafe_ip", errorDetail: "169.254.169.254" }, "p", 0);
    expect(r.status).toBe("probe_resolve_unsafe_ip" as any);
  });
  test("ack has NO error_message / response_body / url fields (zod whitelist on hub side will reject; we just don't include)", () => {
    const r = classifyProbeResponse({ resp: { status: 200 } as Response, errorKind: null }, "p", 50);
    const keys = Object.keys(r);
    expect(keys.sort()).toEqual(["latency_ms", "probe_id", "raw_status_code", "status"]);
  });
});

describe("safelyFetchProbe — SSRF guards (per 通信龙 spot-check c)", () => {
  // (a) redirect:manual is verified in classifyProbeResponse + tested
  // via mock-server e2e in M3 docker. Pure unit can't easily test
  // undici dispatcher behavior without a real socket.
  //
  // (b) customLookup pin: same — undici end-to-end behavior needs real
  // dispatcher path. Tested in M3 e2e with mock vendor.
  //
  // (c) private-IP CIDR + IPv4-mapped: these test through DNS lookup,
  // which we exercise here by setting base_url to a hostname that
  // resolves to a known private IP. We use a literal IP URL (skips DNS)
  // to test the post-resolve check path.
  test("base_url with private IP literal (169.254.169.254) → probe_resolve_unsafe_ip", async () => {
    // Skip DNS via IP-literal URL — undici dns.lookup of "169.254..." returns the IP itself
    const r = await safelyFetchProbe("anthropic", "https://169.254.169.254/", "claude-x", "fake-key");
    expect(r.errorKind).toBe("probe_resolve_unsafe_ip");
    expect(r.errorDetail).toContain("169.254.169.254");
  });
  test("base_url with private IP literal (10.0.0.1) → probe_resolve_unsafe_ip", async () => {
    const r = await safelyFetchProbe("anthropic", "https://10.0.0.1/", "claude-x", "fake-key");
    expect(r.errorKind).toBe("probe_resolve_unsafe_ip");
    expect(r.errorDetail).toContain("10.0.0.1");
  });
  test("base_url with localhost without ALLOW_LOOPBACK env → probe_resolve_unsafe_ip", async () => {
    const r = await safelyFetchProbe("anthropic", "https://127.0.0.1/", "claude-x", "fake-key", {});
    expect(r.errorKind).toBe("probe_resolve_unsafe_ip");
  });
  test("base_url with localhost WITH ALLOW_LOOPBACK env → permitted to proceed (will fail on real network but not on IP guard)", async () => {
    const r = await safelyFetchProbe(
      "anthropic", "https://127.0.0.1:9999/", "claude-x", "fake-key",
      { ANET_DAEMON_PROBE_ALLOW_LOOPBACK: "1" },
    );
    // Either network_error (port 9999 not listening) or timeout —
    // both prove the IP guard did NOT block (loopback exception
    // honored).
    expect(["network_error", "timeout", "tls_error"]).toContain(r.errorKind as string);
  });
  test("NODE_TLS_REJECT_UNAUTHORIZED=0 → tls_error before any fetch", async () => {
    const r = await safelyFetchProbe(
      "anthropic", "https://api.anthropic.com/", "claude-x", "fake-key",
      { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    );
    expect(r.errorKind).toBe("tls_error");
    expect(r.errorDetail).toContain("probe_tls_insecure_disabled");
  });
});
