// RFC-028 P1 §4.4 probe-validate tests — pure unit, no I/O.

import { describe, expect, test } from "bun:test";
import {
  validateBaseUrl, isForbiddenIp, isLoopbackHost, assertSecureTlsEnv,
  ProbeAckPayloadSchema, deriveErrorLabel, rejectIfSecretLeaked,
  VENDOR_HOST_ALLOWLIST, SUPPORTED_VENDORS, ProbeValidationError,
} from "./probe-validate.js";

describe("validateBaseUrl (§4.4.1 vendor host allowlist)", () => {
  test("anthropic + api.anthropic.com → ok", () => {
    expect(() => validateBaseUrl("anthropic", "https://api.anthropic.com/v1")).not.toThrow();
  });
  test("anthropic + api.openai.com → probe_target_forbidden", () => {
    expect(() => validateBaseUrl("anthropic", "https://api.openai.com/v1")).toThrow(/probe_target_forbidden/);
  });
  test("anthropic + 169.254.169.254 (metadata) → probe_target_forbidden (host不在 allowlist)", () => {
    expect(() => validateBaseUrl("anthropic", "https://169.254.169.254/v1")).toThrow(/probe_target_forbidden/);
  });
  test("unsupported vendor → vendor_not_supported", () => {
    expect(() => validateBaseUrl("openai", "https://api.openai.com/v1")).toThrow(/vendor_not_supported/);
  });
  test("non-https → probe_base_url_invalid", () => {
    expect(() => validateBaseUrl("anthropic", "http://api.anthropic.com/v1")).toThrow(/probe_base_url_invalid/);
  });
  test("http+loopback OK with allowLoopback opt-in", () => {
    expect(() => validateBaseUrl("anthropic", "http://localhost:8080/v1", { allowLoopback: true }))
      .toThrow(/probe_target_forbidden/);   // 但 host 还是不在 allowlist, allowLoopback 只放过 protocol
  });
  test("malformed URL → probe_base_url_invalid", () => {
    expect(() => validateBaseUrl("anthropic", "not a url")).toThrow(/probe_base_url_invalid/);
  });
  test("P1 SUPPORTED_VENDORS only contains anthropic", () => {
    expect(SUPPORTED_VENDORS).toEqual(["anthropic"]);
  });

  // ── RFC-028 P1.5+ — Anthropic-compatible 3rd-party hosts on `anthropic` vendor.
  // Whitelist semantics preserved; new entries require PR + security review.
  // Host allowlist passes here; IP-level guard still fires at fetch time
  // (covered by safelyFetchProbe + docker scenarios qa-rfc028 F + M.ssrf).
  test("anthropic + api.deepseek.com → ok (Anthropic-compatible /v1/messages)", () => {
    expect(() => validateBaseUrl("anthropic", "https://api.deepseek.com/v1")).not.toThrow();
  });
  test("anthropic + api.minimax.chat → ok (MiniMax legacy domain)", () => {
    expect(() => validateBaseUrl("anthropic", "https://api.minimax.chat/v1")).not.toThrow();
  });
  test("anthropic + api.minimax.io → ok (MiniMax new domain, Vincent live)", () => {
    expect(() => validateBaseUrl("anthropic", "https://api.minimax.io/v1")).not.toThrow();
  });
  test("subdomain of allowed host NOT accepted (regex anchored)", () => {
    expect(() => validateBaseUrl("anthropic", "https://attacker.api.deepseek.com/v1")).toThrow(/probe_target_forbidden/);
    expect(() => validateBaseUrl("anthropic", "https://api.minimax.io.attacker.example/v1")).toThrow(/probe_target_forbidden/);
  });
  test("homograph / look-alike host rejected (regex anchored)", () => {
    expect(() => validateBaseUrl("anthropic", "https://api.deepseek.com.attacker/v1")).toThrow(/probe_target_forbidden/);
    expect(() => validateBaseUrl("anthropic", "https://api-deepseek.com/v1")).toThrow(/probe_target_forbidden/);
  });
  test("VENDOR_HOST_ALLOWLIST.anthropic curated list = exactly 4 entries", () => {
    // Lock the curated set — adding a 5th host MUST go through a PR
    // bump this assertion (forces conscious security review).
    expect(VENDOR_HOST_ALLOWLIST.anthropic.length).toBe(4);
    const sources = VENDOR_HOST_ALLOWLIST.anthropic.map(r => r.source).sort();
    expect(sources).toEqual([
      "^api\\.anthropic\\.com$",
      "^api\\.deepseek\\.com$",
      "^api\\.minimax\\.chat$",
      "^api\\.minimax\\.io$",
    ]);
  });
});

describe("isForbiddenIp (§4.4.2 private/reserved IP block — anti SSRF)", () => {
  test("blocks IPv4 private + metadata + CGNAT", () => {
    for (const ip of [
      "10.0.0.1", "10.255.255.255",
      "172.16.0.1", "172.31.255.255",
      "192.168.1.1",
      "127.0.0.1", "127.255.255.255",
      "169.254.169.254",      // cloud metadata
      "169.254.0.0",
      "100.64.0.1", "100.127.255.254",   // CGNAT
      "0.0.0.0",
      "224.0.0.1",            // multicast
      "240.0.0.1", "255.255.255.255",   // experimental/broadcast
    ]) {
      expect(isForbiddenIp(ip)).toBe(true);
    }
  });
  test("allows public IPv4", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "104.16.0.1", "172.32.0.1", "172.15.255.254"]) {
      expect(isForbiddenIp(ip)).toBe(false);
    }
  });
  test("blocks IPv6 loopback + link-local + ULA", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd00::1"]) {
      expect(isForbiddenIp(ip)).toBe(true);
    }
  });
  test("blocks IPv4-mapped IPv6 (anti绕)", () => {
    expect(isForbiddenIp("::ffff:10.0.0.1")).toBe(true);
    expect(isForbiddenIp("::ffff:169.254.169.254")).toBe(true);
    expect(isForbiddenIp("::FFFF:127.0.0.1")).toBe(true);
  });
  test("allows public IPv6", () => {
    expect(isForbiddenIp("2606:4700:4700::1111")).toBe(false);
    expect(isForbiddenIp("2001:4860:4860::8888")).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  test("recognizes localhost/127.0.0.1/::1", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("api.example.com")).toBe(false);
  });
});

describe("assertSecureTlsEnv (§4.4 boot guard)", () => {
  test("clean env passes", () => {
    expect(() => assertSecureTlsEnv({})).not.toThrow();
  });
  test("NODE_TLS_REJECT_UNAUTHORIZED=0 throws probe_tls_insecure_disabled", () => {
    expect(() => assertSecureTlsEnv({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }))
      .toThrow(/probe_tls_insecure_disabled/);
  });
  test("NODE_TLS_REJECT_UNAUTHORIZED=1 passes (default safe)", () => {
    expect(() => assertSecureTlsEnv({ NODE_TLS_REJECT_UNAUTHORIZED: "1" })).not.toThrow();
  });
});

describe("ProbeAckPayloadSchema (§4.4.4 v3 R3 strict whitelist)", () => {
  test("minimal valid payload parses", () => {
    const ok = { probe_id: "p_1", status: "ok", latency_ms: 180 };
    expect(ProbeAckPayloadSchema.parse(ok)).toEqual(ok);
  });
  test("with raw_status_code parses", () => {
    const r = ProbeAckPayloadSchema.parse({ probe_id: "p_2", status: "auth_fail", raw_status_code: 401, latency_ms: 50 });
    expect(r.raw_status_code).toBe(401);
  });
  test("REJECTS extra error_message field (zod .strict, v3 R3 attacker daemon catch)", () => {
    expect(() => ProbeAckPayloadSchema.parse({
      probe_id: "p_3", status: "auth_fail", latency_ms: 50,
      error_message: "Invalid API key: sk-ant-abc",   // ← attacker smuggling
    })).toThrow();
  });
  test("REJECTS extra response_body / response_headers / url / vendor_text", () => {
    for (const extra of [
      { response_body: "..." },
      { response_headers: { foo: "bar" } },
      { url: "https://leak" },
      { vendor_text: "leak" },
      { error: "leak" },
      { detail: "leak" },
    ]) {
      expect(() => ProbeAckPayloadSchema.parse({
        probe_id: "p", status: "ok", latency_ms: 1,
        ...extra,
      })).toThrow();
    }
  });
  test("REJECTS bad enum status", () => {
    expect(() => ProbeAckPayloadSchema.parse({ probe_id: "p", status: "bogus", latency_ms: 1 })).toThrow();
  });
  test("REJECTS latency_ms > 60_000 or negative", () => {
    expect(() => ProbeAckPayloadSchema.parse({ probe_id: "p", status: "ok", latency_ms: 60_001 })).toThrow();
    expect(() => ProbeAckPayloadSchema.parse({ probe_id: "p", status: "ok", latency_ms: -1 })).toThrow();
  });
});

describe("deriveErrorLabel (hub-only, daemon CANNOT submit)", () => {
  test("ok → null", () => {
    expect(deriveErrorLabel({ probe_id: "p", status: "ok", latency_ms: 10 })).toBeNull();
  });
  test("auth_fail with code → label includes HTTP code", () => {
    expect(deriveErrorLabel({ probe_id: "p", status: "auth_fail", raw_status_code: 401, latency_ms: 10 }))
      .toContain("401");
  });
  test("every enum has a label or null", () => {
    for (const status of ["ok", "auth_fail", "quota", "rate_limit", "network_error", "timeout", "redirect_forbidden", "vendor_5xx", "other_4xx", "tls_error"] as const) {
      const r = deriveErrorLabel({ probe_id: "p", status, latency_ms: 1 });
      expect(typeof r === "string" || r === null).toBe(true);
    }
  });
});

describe("rejectIfSecretLeaked (§4.4.4 belt-and-suspenders)", () => {
  test("clean ack passes", () => {
    expect(() => rejectIfSecretLeaked(
      JSON.stringify({ probe_id: "p", status: "ok" }),
      ["sk-very-long-secret-1234567890"],
    )).not.toThrow();
  });
  test("ack containing raw secret → ack_secret_leak (plain)", () => {
    expect(() => rejectIfSecretLeaked(
      JSON.stringify({ probe_id: "p", status: "fail", x: "sk-very-long-secret-1234567890" }),
      ["sk-very-long-secret-1234567890"],
    )).toThrow(/ack_secret_leak/);
  });
  test("ack containing URL-encoded secret → ack_secret_leak (url_encoded)", () => {
    const secret = "sk/with+special=chars/here-long-enough";
    const enc = encodeURIComponent(secret);
    expect(() => rejectIfSecretLeaked(
      JSON.stringify({ probe_id: "p", url: `https://x/?key=${enc}` }),
      [secret],
    )).toThrow(/ack_secret_leak/);
  });
  test("ack containing 12-char substring of long secret → ack_secret_leak (substring_12)", () => {
    const secret = "sk-ant-api03-very-long-key-1234567890-abcdef";
    expect(() => rejectIfSecretLeaked(
      JSON.stringify({ probe_id: "p", x: "leak prefix sk-ant-api03 here" }),
      [secret],
    )).toThrow(/ack_secret_leak/);
  });
  test("short secret (<8) not checked (avoid false positive on tiny tokens)", () => {
    expect(() => rejectIfSecretLeaked(
      JSON.stringify({ probe_id: "p", x: "test" }),
      ["test"],
    )).not.toThrow();
  });
});
