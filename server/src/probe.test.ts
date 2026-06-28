import { describe, expect, test, beforeEach } from "bun:test";
import {
  putPendingProbeSecret,
  takePendingProbeSecret,
  peekPendingProbeSecret,
  evictExpiredProbeSecrets,
  stopBackgroundProbeTimersForTest,
  type PendingProbeSecret,
} from "./probe.js";

// RFC-028 P1 fold-in #4 — takePendingProbeSecret 4-case unit. Mirrors
// RFC-026 §4.4 takePendingEnvBlob unit pattern. This is the C2 cross-
// daemon guard for probes: a daemon-X that intercepts a probe_id minted
// for daemon-Y must NOT be able to consume it. Wrong-caller branch must
// NOT evict (so the right daemon can still consume in TTL).

function mkSecret(over: Partial<PendingProbeSecret> = {}): Omit<PendingProbeSecret, "expires_at"> {
  return {
    probe_id: over.probe_id ?? "pr_test_1",
    daemon_node_id: over.daemon_node_id ?? "node_daemon_alpha",
    provider_id: over.provider_id ?? "prov_1",
    vendor: over.vendor ?? "anthropic",
    base_url: over.base_url ?? "https://api.anthropic.com",
    model_name: over.model_name ?? "claude-opus-test",
    api_key: over.api_key ?? "sk-secret-not-leaked",
    network_id: over.network_id ?? "net_1",
  };
}

describe("RFC-028 P1 — takePendingProbeSecret 4-case", () => {
  beforeEach(() => stopBackgroundProbeTimersForTest());

  test("case 1: happy path — right daemon, within TTL → returns + evicts", () => {
    putPendingProbeSecret(mkSecret({ probe_id: "pr_happy" }));
    expect(peekPendingProbeSecret("pr_happy")).not.toBeNull();
    const out = takePendingProbeSecret("pr_happy", "node_daemon_alpha");
    expect(out).not.toBeNull();
    expect(out!.api_key).toBe("sk-secret-not-leaked");
    // Evicted on success → second take returns null
    expect(takePendingProbeSecret("pr_happy", "node_daemon_alpha")).toBeNull();
    expect(peekPendingProbeSecret("pr_happy")).toBeNull();
  });

  test("case 2: wrong daemon → returns null AND does NOT evict (right daemon can still consume)", () => {
    putPendingProbeSecret(mkSecret({ probe_id: "pr_wrongcaller", daemon_node_id: "node_daemon_alpha" }));
    // attacker daemon tries to consume
    const wrong = takePendingProbeSecret("pr_wrongcaller", "node_daemon_attacker");
    expect(wrong).toBeNull();
    // entry MUST still be there — peek confirms (this is the C2 invariant:
    // a wrong-caller probe cannot DoS the legitimate one by triggering eviction)
    const peeked = peekPendingProbeSecret("pr_wrongcaller");
    expect(peeked).not.toBeNull();
    expect(peeked!.daemon_node_id).toBe("node_daemon_alpha");
    // right daemon STILL gets it
    const right = takePendingProbeSecret("pr_wrongcaller", "node_daemon_alpha");
    expect(right).not.toBeNull();
    expect(right!.api_key).toBe("sk-secret-not-leaked");
  });

  test("case 3: not found → returns null (no side-effect)", () => {
    const out = takePendingProbeSecret("pr_nonexistent", "node_daemon_alpha");
    expect(out).toBeNull();
    // also confirm peek is null
    expect(peekPendingProbeSecret("pr_nonexistent")).toBeNull();
  });

  test("case 4: expired → returns null + evicts (so memory doesn't accumulate)", async () => {
    // Use evictExpiredProbeSecrets's now-arg surrogate: put a fresh entry then
    // ask take with a time-shifted view by mutating the map. Since the public
    // API doesn't expose expires_at directly, we use the sweeper to verify
    // expired entries get cleaned, then assert take returns null.
    putPendingProbeSecret(mkSecret({ probe_id: "pr_expired" }));
    // Sweep with a forced "now" 120s in the future → past TTL_MS (60s)
    const n = evictExpiredProbeSecrets(Date.now() + 120_000);
    expect(n).toBeGreaterThanOrEqual(1);
    // Now any take must return null + the entry is gone
    expect(takePendingProbeSecret("pr_expired", "node_daemon_alpha")).toBeNull();
    expect(peekPendingProbeSecret("pr_expired")).toBeNull();
  });
});
