import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { retireStoppedGrokCopresenceRuntime } from "./runtime-retirement";

function fixture(input: { running: boolean; phase: string; closeError?: Error }) {
  let closeCalls = 0;
  return {
    runtime: {
      isRunning: input.running,
      state: { phase: input.phase },
      async close() {
        closeCalls += 1;
        if (input.closeError) throw input.closeError;
      },
    },
    closeCalls: () => closeCalls,
  };
}

describe("Grok co-presence terminal-runtime retirement", () => {
  test("retains live and recovering runtimes", async () => {
    for (const state of [
      { running: true, phase: "idle" },
      { running: false, phase: "recovering" },
    ]) {
      const probe = fixture(state);
      let retired = false;
      expect(await retireStoppedGrokCopresenceRuntime(probe.runtime, {
        retire: () => { retired = true; },
      })).toBe(false);
      expect(probe.closeCalls()).toBe(0);
      expect(retired).toBe(false);
    }
  });

  test("closes and retires a terminal runtime even when teardown reports an error", async () => {
    for (const closeError of [undefined, new Error("already contained")]) {
      const probe = fixture({ running: false, phase: "network_turn", closeError });
      const warnings: string[] = [];
      let retiredRuntime: unknown;
      expect(await retireStoppedGrokCopresenceRuntime(probe.runtime, {
        retire: (runtime) => { retiredRuntime = runtime; },
        warn: (message) => warnings.push(message),
      })).toBe(true);
      expect(probe.closeCalls()).toBe(1);
      expect(retiredRuntime).toBe(probe.runtime);
      expect(warnings).toHaveLength(closeError ? 1 : 0);
    }
  });

  test("wires retirement before returning the cached product runtime", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "..", "cli.ts"), "utf8");
    const ensureStart = cli.indexOf("async function ensureGrokCopresenceRuntime()");
    const ensureEnd = cli.indexOf("\nconst GROK_COPRESENCE_FAILURE_CODE_SET", ensureStart);
    const ensure = cli.slice(ensureStart, ensureEnd);
    const retireAt = ensure.indexOf("await retireCachedGrokCopresenceRuntime()");
    const returnCachedAt = ensure.indexOf("if (grokCopresenceRuntimeSession) return grokCopresenceRuntimeSession");
    expect(retireAt).toBeGreaterThanOrEqual(0);
    expect(returnCachedAt).toBeGreaterThan(retireAt);
  });
});
