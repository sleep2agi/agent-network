import { describe, expect, test } from "bun:test";
import {
  assertSecureTlsEnv,
  classifyProbeResponse,
  createPinnedLookup,
  handleProbeDoorbell,
  safelyFetchProbe,
} from "./probe-daemon.js";

function callPinnedLookup(
  lookup: ReturnType<typeof createPinnedLookup>,
  hostname: string,
  options: any,
): Promise<any[]> {
  return new Promise((resolve) => {
    (lookup as any)(hostname, options, (...args: any[]) => resolve(args));
  });
}

describe("createPinnedLookup — Node/Bun lookup callback contract", () => {
  const addresses = [
    { address: "192.0.2.10", family: 4 },
    { address: "2001:db8::10", family: 6 },
  ] as const;

  test("single-address callback honors requested family", async () => {
    const args = await callPinnedLookup(createPinnedLookup("api.example.test", addresses), "api.example.test", { family: 6 });
    expect(args).toEqual([null, "2001:db8::10", 6]);
  });

  test("all-address callback returns only pinned copies", async () => {
    const args = await callPinnedLookup(createPinnedLookup("api.example.test", addresses), "API.EXAMPLE.TEST.", { all: true });
    expect(args).toEqual([null, [
      { address: "192.0.2.10", family: 4 },
      { address: "2001:db8::10", family: 6 },
    ]]);
  });

  test("wrong hostname and unavailable family fail closed without fallback", async () => {
    for (const [hostname, options] of [
      ["rebound.example.test", {}],
      ["api.example.test", { family: 6 }],
    ] as const) {
      const onlyV4 = createPinnedLookup("api.example.test", [addresses[0]]);
      const args = await callPinnedLookup(onlyV4, hostname, options);
      expect(args[0]).toBeInstanceOf(Error);
      expect(args[0].code).toBe("ENOTFOUND");
      expect(args).toHaveLength(1);
    }
  });
});

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

// ── handleProbeDoorbell — daemon-level validateBaseUrl re-check ──
// Fold-in #1 (通信龙 spot-check non-blocking note): even if hub returns
// a fabricated probe spec (compromised hub, hub regression, on-wire
// injection), the daemon re-runs validateBaseUrl(vendor, base_url)
// before doing any fetch. Reject paths:
//   - unknown vendor → daemon_recheck_vendor_not_supported
//   - non-allowlist host for the vendor → daemon_recheck_probe_target_forbidden
//   - bad URL → daemon_recheck_probe_base_url_invalid
// All collapse to ack.status = "probe_target_forbidden" + zero network call.
describe("handleProbeDoorbell — daemon validateBaseUrl re-check (compromised-hub defense)", () => {
  function mkDeps(getProbeReq: any) {
    const calls: any[] = [];
    const warns: string[] = [];
    const logs: string[] = [];
    return {
      deps: {
        callCommHub: async (tool: string, args: any) => {
          calls.push({ tool, args });
          if (tool === "get_probe_request") return getProbeReq;
          if (tool === "ack_probe_request") return { ok: true };
          throw new Error(`unexpected tool ${tool}`);
        },
        log: (m: string) => logs.push(m),
        warn: (m: string) => warns.push(m),
      },
      calls, warns, logs,
    };
  }

  test("non-allowlist host for anthropic → daemon-level reject + ack probe_target_forbidden, no fetch", async () => {
    // Hub claims api.anthropic.com but actually wrote example.com (compromised-hub scenario)
    const { deps, calls, warns } = mkDeps({
      ok: true,
      vendor: "anthropic",
      base_url: "https://example.com/v1",
      model_name: "claude-x",
      api_key: "sk-fake-not-used",
    });
    const t0 = Date.now();
    await handleProbeDoorbell({ probe_id: "pr_attack_1" }, deps);
    const elapsed = Date.now() - t0;
    // No fetch should have happened — elapsed must be tiny (sync validateBaseUrl + ack only)
    expect(elapsed).toBeLessThan(500);
    const ackCall = calls.find(c => c.tool === "ack_probe_request");
    expect(ackCall).toBeTruthy();
    expect(ackCall.args.status).toBe("probe_target_forbidden");
    expect(ackCall.args.probe_id).toBe("pr_attack_1");
    // Warning emitted naming the reason code
    expect(warns.some(w => /daemon re-check.*code=probe_target_forbidden/.test(w))).toBe(true);
  });

  test("unknown vendor → daemon rejects, ack probe_target_forbidden", async () => {
    const { deps, calls } = mkDeps({
      ok: true,
      vendor: "evil-vendor",
      base_url: "https://api.anthropic.com/v1",
      model_name: "claude-x",
      api_key: "sk-fake",
    });
    await handleProbeDoorbell({ probe_id: "pr_attack_2" }, deps);
    const ackCall = calls.find(c => c.tool === "ack_probe_request");
    expect(ackCall.args.status).toBe("probe_target_forbidden");
  });

  test("bad URL (not parseable) → daemon rejects, ack probe_target_forbidden", async () => {
    const { deps, calls } = mkDeps({
      ok: true,
      vendor: "anthropic",
      base_url: "://not-a-url",
      model_name: "claude-x",
      api_key: "sk-fake",
    });
    await handleProbeDoorbell({ probe_id: "pr_attack_3" }, deps);
    const ackCall = calls.find(c => c.tool === "ack_probe_request");
    expect(ackCall.args.status).toBe("probe_target_forbidden");
  });

  test("plain HTTP scheme on non-loopback host → daemon rejects, ack probe_target_forbidden", async () => {
    const { deps, calls } = mkDeps({
      ok: true,
      vendor: "anthropic",
      base_url: "http://api.anthropic.com/v1",   // http, not https — even with allowlist match, must reject
      model_name: "claude-x",
      api_key: "sk-fake",
    });
    await handleProbeDoorbell({ probe_id: "pr_attack_4" }, deps);
    const ackCall = calls.find(c => c.tool === "ack_probe_request");
    expect(ackCall.args.status).toBe("probe_target_forbidden");
  });

  test("get_probe_request returns ok:false → no ack pushed (hub sweeper handles)", async () => {
    const { deps, calls, warns } = mkDeps({ ok: false, error: "probe_not_found" });
    await handleProbeDoorbell({ probe_id: "pr_missing" }, deps);
    const ackCall = calls.find(c => c.tool === "ack_probe_request");
    expect(ackCall).toBeUndefined();
    expect(warns.some(w => /get_probe_request failed/.test(w))).toBe(true);
  });
});
