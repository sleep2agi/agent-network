import { describe, expect, test } from "bun:test";
import { hubHealthTimeoutMs, HUB_HEALTH_TIMEOUT_ENV, LOOPBACK_HUB_HEALTH_TIMEOUT_MS, REMOTE_HUB_HEALTH_TIMEOUT_MS } from "./hub-health-timeout";

describe("hubHealthTimeoutMs (TMHR鲸 2026-09-16: WAN hub answered in 2.1–2.7s, 2s gate called it dead)", () => {
  test("loopback keeps the 2s budget", () => {
    expect(hubHealthTimeoutMs("http://127.0.0.1:9200", {})).toBe(LOOPBACK_HUB_HEALTH_TIMEOUT_MS);
    expect(hubHealthTimeoutMs("http://localhost:9200", {})).toBe(LOOPBACK_HUB_HEALTH_TIMEOUT_MS);
  });
  test("a remote hub gets 10s", () => {
    expect(hubHealthTimeoutMs("http://y.example.top:9300", {})).toBe(REMOTE_HUB_HEALTH_TIMEOUT_MS);
    expect(hubHealthTimeoutMs("https://hub.example.com", {})).toBe(REMOTE_HUB_HEALTH_TIMEOUT_MS);
  });
  test("env override wins within 1s–60s", () => {
    expect(hubHealthTimeoutMs("http://127.0.0.1:9200", { [HUB_HEALTH_TIMEOUT_ENV]: "15000" })).toBe(15000);
    expect(hubHealthTimeoutMs("http://y.example.top:9300", { [HUB_HEALTH_TIMEOUT_ENV]: "2500.9" })).toBe(2500);
  });
  test("garbage or out-of-range env falls back to the default", () => {
    for (const bad of ["abc", "", "0", "999", "60001", "-5", "NaN"]) {
      expect(hubHealthTimeoutMs("http://y.example.top:9300", { [HUB_HEALTH_TIMEOUT_ENV]: bad })).toBe(REMOTE_HUB_HEALTH_TIMEOUT_MS);
    }
  });
});
