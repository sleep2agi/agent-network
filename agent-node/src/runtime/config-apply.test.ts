// Coverage for the node-side config-apply runtime — pure helpers that
// don't need a real hub, real fs in tmp dirs for atomic-write / boot
// self-heal / .prev backup paths.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateLocalPatch,
  computeApplyMode,
  atomicWriteJson,
  backupConfigPrev,
  loadConfigWithSelfHeal,
  mergePatch,
  buildConfigSnapshot,
  RESTART_SENTINEL,
} from "./config-apply";

let scratch = "";
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "rfc024-"));
});
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("RESTART_SENTINEL — exact value pin", () => {
  test("equals 75 (BSD EX_TEMPFAIL semantics, parent supervisor checks this exact code)", () => {
    expect(RESTART_SENTINEL).toBe(75);
  });
});

describe("validateLocalPatch — defense-in-depth", () => {
  test("undefined model + empty flags passes (no-op patch)", () => {
    expect(validateLocalPatch({})).toBeNull();
  });
  test("valid full patch passes", () => {
    expect(validateLocalPatch({ model: "claude-opus-4", flags: { maxTurns: 50, budget: 100 } })).toBeNull();
  });
  test("unknown flag rejected (even if hub validator drifts loose)", () => {
    const r = validateLocalPatch({ flags: { godmode: true } as any });
    expect(r?.field).toBe("flags.godmode");
  });
  test("permissionMode invalid enum rejected", () => {
    const r = validateLocalPatch({ flags: { permissionMode: "leetmode" } as any });
    expect(r?.field).toBe("flags.permissionMode");
  });
  test("dangerouslySkipPermissions non-boolean rejected", () => {
    const r = validateLocalPatch({ flags: { dangerouslySkipPermissions: 1 } as any });
    expect(r?.field).toBe("flags.dangerouslySkipPermissions");
  });
  test("maxTurns out of range rejected", () => {
    expect(validateLocalPatch({ flags: { maxTurns: -1 } })?.field).toBe("flags.maxTurns");
    expect(validateLocalPatch({ flags: { maxTurns: 10001 } })?.field).toBe("flags.maxTurns");
  });
  test("timeout invalid rejected", () => {
    expect(validateLocalPatch({ flags: { timeout: 5_000_000 } })?.field).toBe("flags.timeout");
    expect(validateLocalPatch({ flags: { timeout: -1 } })?.field).toBe("flags.timeout");
  });
  test("empty-string model rejected", () => {
    expect(validateLocalPatch({ model: "" })?.field).toBe("model");
  });
});

describe("computeApplyMode — tier classifier", () => {
  test("empty patch → restart_only (restart_node)", () => {
    expect(computeApplyMode({})).toBe("restart_only");
  });
  test("model only → restart", () => {
    expect(computeApplyMode({ model: "claude-opus-4" })).toBe("restart");
  });
  test("permissionMode → restart", () => {
    expect(computeApplyMode({ flags: { permissionMode: "auto" } })).toBe("restart");
  });
  test("dangerouslySkipPermissions → restart", () => {
    expect(computeApplyMode({ flags: { dangerouslySkipPermissions: true } })).toBe("restart");
  });
  test("teammateMode → restart", () => {
    expect(computeApplyMode({ flags: { teammateMode: false } })).toBe("restart");
  });
  test("timeout → restart", () => {
    expect(computeApplyMode({ flags: { timeout: 60000 } })).toBe("restart");
  });
  test("maxTurns only → hot", () => {
    expect(computeApplyMode({ flags: { maxTurns: 50 } })).toBe("hot");
  });
  test("budget only → hot", () => {
    expect(computeApplyMode({ flags: { budget: 100 } })).toBe("hot");
  });
  test("mixed (model + maxTurns) → restart (strictest wins)", () => {
    expect(computeApplyMode({ model: "x", flags: { maxTurns: 50 } })).toBe("restart");
  });
});

describe("atomicWriteJson — temp + rename", () => {
  test("creates file with JSON content + trailing newline", () => {
    const path = join(scratch, "config.json");
    atomicWriteJson(path, { foo: 1, nested: { bar: "baz" } });
    const txt = readFileSync(path, "utf-8");
    expect(JSON.parse(txt)).toEqual({ foo: 1, nested: { bar: "baz" } });
    expect(txt.endsWith("\n")).toBe(true);
  });

  test("overwrites existing file atomically (no .tmp left behind)", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, '{"old": true}');
    atomicWriteJson(path, { new: true });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ new: true });
    // No .tmp file should remain after the rename.
    const tmpFiles = require("node:fs").readdirSync(scratch).filter((f: string) => f.includes(".tmp."));
    expect(tmpFiles.length).toBe(0);
  });
});

describe("backupConfigPrev — pre-write snapshot", () => {
  test("copies existing config to .prev", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, '{"v": 1}');
    const r = backupConfigPrev(path);
    expect(r.backedUp).toBe(true);
    expect(readFileSync(`${path}.prev`, "utf-8")).toBe('{"v": 1}');
  });

  test("returns backedUp=false when no config exists yet (first-write case)", () => {
    const path = join(scratch, "config.json");
    expect(backupConfigPrev(path).backedUp).toBe(false);
    expect(existsSync(`${path}.prev`)).toBe(false);
  });

  test("overwrites previous .prev (single-generation rotation)", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, '{"v": 1}');
    backupConfigPrev(path);
    writeFileSync(path, '{"v": 2}');
    backupConfigPrev(path);
    expect(JSON.parse(readFileSync(`${path}.prev`, "utf-8"))).toEqual({ v: 2 });
  });
});

describe("loadConfigWithSelfHeal — boot recovery", () => {
  test("primary parses → returns primary", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, '{"model": "claude-opus-4"}');
    const r = loadConfigWithSelfHeal(path);
    expect(r.source).toBe("primary");
    expect(r.config).toEqual({ model: "claude-opus-4" });
  });

  test("primary corrupted + .prev valid → restores .prev + reports source=prev", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, "{this is not json");
    writeFileSync(`${path}.prev`, '{"recovered": true}');
    const r = loadConfigWithSelfHeal(path);
    expect(r.source).toBe("prev");
    expect(r.config).toEqual({ recovered: true });
    expect(r.primaryError).toBeDefined();
    // Recovery side effect: primary now mirrors .prev.
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ recovered: true });
  });

  test("primary corrupted + no .prev → throws (truly bricked, caller surfaces)", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, "broken");
    expect(() => loadConfigWithSelfHeal(path)).toThrow(/no .prev/);
  });

  test("primary AND .prev corrupted → throws with both errors", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, "broken1");
    writeFileSync(`${path}.prev`, "broken2");
    expect(() => loadConfigWithSelfHeal(path)).toThrow(/parse also failed/);
  });

  test("primary missing entirely → throws (caller will skip / first-boot path)", () => {
    const path = join(scratch, "no-such.json");
    expect(() => loadConfigWithSelfHeal(path)).toThrow();
  });
});

describe("mergePatch — patch + existing → new config (no mutation)", () => {
  test("model replace", () => {
    const existing = { model: "old", flags: { maxTurns: 1 } };
    const next = mergePatch(existing, { model: "new" });
    expect(next.model).toBe("new");
    expect(next.flags.maxTurns).toBe(1);
    // Source not mutated.
    expect(existing.model).toBe("old");
  });

  test("flags merge (does not replace whole flags obj)", () => {
    const existing = { flags: { maxTurns: 1, budget: 5 } };
    const next = mergePatch(existing, { flags: { maxTurns: 99 } });
    expect(next.flags).toEqual({ maxTurns: 99, budget: 5 });
  });

  test("empty existing + patch → patch only", () => {
    expect(mergePatch({}, { model: "x", flags: { budget: 5 } })).toEqual({ model: "x", flags: { budget: 5 } });
  });

  test("empty patch → existing unchanged (deep clone)", () => {
    const existing = { model: "y", flags: { maxTurns: 10 } };
    const next = mergePatch(existing, {});
    expect(next).toEqual(existing);
    expect(next).not.toBe(existing);  // deep clone, not alias
  });
});

describe("buildConfigSnapshot — masked report (no secrets)", () => {
  test("includes model + ALLOWED_FLAGS only", () => {
    const file = {
      model: "claude-opus-4",
      flags: { maxTurns: 50, dangerouslySkipPermissions: true, mysteryFlag: "x" },
      env: { SECRET: "should-not-leak" },
      token: "ntok_leak",
    };
    const snap = buildConfigSnapshot(file, true, 3);
    expect(snap.model).toBe("claude-opus-4");
    expect(snap.flags.maxTurns).toBe(50);
    expect(snap.flags.dangerouslySkipPermissions).toBe(true);
    expect("mysteryFlag" in snap.flags).toBe(false);
    expect(snap.config_update_capable).toBe(true);
    expect(snap.config_revision).toBe(3);
    // Critical: no env / token leak.
    expect("env" in snap).toBe(false);
    expect("token" in snap).toBe(false);
  });

  test("missing model → null (not undefined, dashboard renders explicitly)", () => {
    const snap = buildConfigSnapshot({ flags: {} }, false, 0);
    expect(snap.model).toBeNull();
  });

  test("config_update_capable=false signals bare node (no supervisor wrapper)", () => {
    const snap = buildConfigSnapshot({}, false, 0);
    expect(snap.config_update_capable).toBe(false);
  });
});
