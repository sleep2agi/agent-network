import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VENDOR_HOST_ALLOWLIST as HUB_ALLOW,
  FORBIDDEN_IPV4_RE as HUB_V4,
  FORBIDDEN_IPV6_RE as HUB_V6,
} from "./probe-host-allowlist.js";

// RFC-028 P1 fold-in #1 — hub-and-daemon probe-host-allowlist drift
// guard. Mirrors the G9 reserved-env drift test (RFC-026 §4.4.7).
// Two enforcement modes:
//   1. byte-identical source files
//   2. runtime set-equality of the imported constants (vendor regex
//      source strings + private-IP regex source strings)
// If a future contributor edits one side without the other, this test
// breaks the merge — the daemon-side compromised-hub defense depends
// on the two lists being identical.

const HUB_PATH = join(import.meta.dir, "probe-host-allowlist.ts");
const DAEMON_PATH = join(
  import.meta.dir,
  "..", "..", "..", "agent-node", "src", "shared", "probe-host-allowlist.ts",
);

describe("RFC-028 P1 — hub/daemon probe-host-allowlist drift guard", () => {
  test("byte-identical source files", () => {
    const hub = readFileSync(HUB_PATH, "utf-8");
    const daemon = readFileSync(DAEMON_PATH, "utf-8");
    expect(daemon).toBe(hub);
  });

  test("VENDOR_HOST_ALLOWLIST regex sources equal at runtime", async () => {
    const daemonMod = await import(DAEMON_PATH);
    const daemonAllow = daemonMod.VENDOR_HOST_ALLOWLIST as Record<string, ReadonlyArray<RegExp>>;
    // vendor set equality
    expect(new Set(Object.keys(daemonAllow))).toEqual(new Set(Object.keys(HUB_ALLOW)));
    // per-vendor regex source array equality (order matters — both should
    // be authored in identical order to keep diffs minimal)
    for (const vendor of Object.keys(HUB_ALLOW)) {
      const hubSources = HUB_ALLOW[vendor].map(r => r.source);
      const daemonSources = daemonAllow[vendor].map(r => r.source);
      expect(daemonSources).toEqual(hubSources);
    }
  });

  test("FORBIDDEN_IPV4_RE + FORBIDDEN_IPV6_RE sources equal at runtime", async () => {
    const daemonMod = await import(DAEMON_PATH);
    const daemonV4 = (daemonMod.FORBIDDEN_IPV4_RE as ReadonlyArray<RegExp>).map(r => r.source);
    const daemonV6 = (daemonMod.FORBIDDEN_IPV6_RE as ReadonlyArray<RegExp>).map(r => r.source);
    expect(daemonV4).toEqual(HUB_V4.map(r => r.source));
    expect(daemonV6).toEqual(HUB_V6.map(r => r.source));
  });
});
