import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RESERVED_ENV_KEYS_EXACT as HUB_EXACT,
  RESERVED_ENV_PREFIXES as HUB_PREFIXES,
} from "./reserved-env.js";

// RFC-026 v4 §4.4.7 G9 drift guard — denylist MUST be hub-and-daemon
// identical, or attacker walks the looser layer. Two enforcement modes:
//
//   1. byte-identical source files (this test)
//   2. runtime set-equality of the imported constants
//
// We assert both. If a future contributor edits one side without the
// other, this test breaks the merge.

const HUB_PATH = join(import.meta.dir, "reserved-env.ts");
const DAEMON_PATH = join(import.meta.dir, "..", "..", "..", "agent-node", "src", "shared", "reserved-env.ts");

describe("RFC-026 v4 §4.4.7 G9 — hub/daemon reserved-env drift guard", () => {
  test("byte-identical source files", () => {
    const hub = readFileSync(HUB_PATH, "utf-8");
    const daemon = readFileSync(DAEMON_PATH, "utf-8");
    expect(daemon).toBe(hub);
  });

  test("imported constants are set-equal at runtime", async () => {
    // Use a dynamic file import path so this test breaks if the file
    // moves but still references the daemon copy.
    const daemonMod = await import(DAEMON_PATH);
    const daemonExact = daemonMod.RESERVED_ENV_KEYS_EXACT as Set<string>;
    const daemonPrefixes = daemonMod.RESERVED_ENV_PREFIXES as ReadonlyArray<string>;

    // EXACT set equality
    expect(daemonExact.size).toBe(HUB_EXACT.size);
    for (const k of HUB_EXACT) expect(daemonExact.has(k)).toBe(true);
    for (const k of daemonExact) expect(HUB_EXACT.has(k)).toBe(true);

    // PREFIX array order-independent equality
    expect(new Set(daemonPrefixes)).toEqual(new Set(HUB_PREFIXES));
  });
});
