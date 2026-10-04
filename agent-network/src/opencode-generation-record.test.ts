// Board #542 — node records carry `opencodeGeneration`; old ones read as v1.
import { describe, expect, test } from "bun:test";
import {
  backfillOpencodeGeneration,
  recordOpencodeGenerationInConfigText,
  stampOpencodeGeneration,
} from "./opencode-generation-record";
import { serializeProfileForConfigJson } from "./profile-serialize";
import { opencodeGenerationOfConfig } from "./opencode-versions";

const canonical = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const LEGACY = {
  anet_version: "2.3.0-preview.130",
  node_id: "n_1",
  node_name: "oc",
  runtime: "opencode-cli",
  token: "ntok_x",
  model: "anthropic/claude",
  channels: [],
  env: { A: "1" },
  flags: { opencodeUnsafeTools: false },
  opencodeMode: "copresence",
};

describe("stampOpencodeGeneration (create / saveProfile)", () => {
  test("adds v1 when absent and touches nothing else", () => {
    const stamped = stampOpencodeGeneration(LEGACY);
    expect(stamped).toEqual({ ...LEGACY, opencodeGeneration: "v1" });
    expect(LEGACY).not.toHaveProperty("opencodeGeneration");
  });

  test("never overwrites a present value (returns the same object)", () => {
    const v2 = { ...LEGACY, opencodeGeneration: "v2" };
    expect(stampOpencodeGeneration(v2)).toBe(v2);
    const odd = { ...LEGACY, opencodeGeneration: "something-else" };
    expect(stampOpencodeGeneration(odd)).toBe(odd);
  });

  test("the config.json whitelist persists it (else every save would drop it)", () => {
    const stamped = stampOpencodeGeneration(LEGACY);
    expect(serializeProfileForConfigJson(stamped, stamped).opencodeGeneration).toBe("v1");
    expect("opencodeGeneration" in serializeProfileForConfigJson(LEGACY, LEGACY)).toBe(false);
    const v2 = { ...LEGACY, opencodeGeneration: "v2" };
    expect(serializeProfileForConfigJson(v2, v2).opencodeGeneration).toBe("v2");
  });
});

describe("recordOpencodeGenerationInConfigText (start-time backfill)", () => {
  test("canonical legacy config → same bytes plus one appended key", () => {
    const raw = canonical(LEGACY);
    const next = recordOpencodeGenerationInConfigText(raw)!;
    expect(next).toBe(canonical({ ...LEGACY, opencodeGeneration: "v1" }));
    // Every original line survives byte-for-byte, in order.
    const before = raw.trimEnd().split("\n").slice(0, -1); // drop closing brace
    const after = next.split("\n");
    before.forEach((line, i) => expect(after[i]).toBe(i === before.length - 1 ? line + "," : line));
  });

  test("already recorded (any value) → no write", () => {
    expect(recordOpencodeGenerationInConfigText(canonical({ ...LEGACY, opencodeGeneration: "v1" }))).toBeNull();
    expect(recordOpencodeGenerationInConfigText(canonical({ ...LEGACY, opencodeGeneration: "v2" }))).toBeNull();
    expect(recordOpencodeGenerationInConfigText(canonical({ ...LEGACY, opencodeGeneration: null }))).toBeNull();
  });

  test("hand-edited / non-canonical / invalid → no write (absent already means v1)", () => {
    expect(recordOpencodeGenerationInConfigText(JSON.stringify(LEGACY))).toBeNull();
    expect(recordOpencodeGenerationInConfigText(canonical(LEGACY).replace('"A": "1"', '"A":   "1"'))).toBeNull();
    expect(recordOpencodeGenerationInConfigText("{ not json")).toBeNull();
    expect(recordOpencodeGenerationInConfigText("[]\n")).toBeNull();
    expect(recordOpencodeGenerationInConfigText("null\n")).toBeNull();
    expect(opencodeGenerationOfConfig(LEGACY)).toBe("v1");
  });

  test("backfill writes once, then is a no-op; IO failures never throw", () => {
    let file = canonical(LEGACY);
    const writes: string[] = [];
    const io = { read: () => file, write: (body: string) => { writes.push(body); file = body; } };
    expect(backfillOpencodeGeneration(io)).toBe(true);
    expect(backfillOpencodeGeneration(io)).toBe(false);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(file).opencodeGeneration).toBe("v1");
    expect(backfillOpencodeGeneration({ read: () => undefined, write: () => { throw new Error("no"); } })).toBe(false);
    expect(backfillOpencodeGeneration({ read: () => { throw new Error("EACCES"); }, write: () => {} })).toBe(false);
    expect(backfillOpencodeGeneration({ read: () => canonical(LEGACY), write: () => { throw new Error("EROFS"); } })).toBe(false);
  });
});

describe("CLI wiring (#542)", () => {
  const cli = require("fs").readFileSync(require("path").join(import.meta.dir, "..", "bin", "cli.ts"), "utf8") as string;
  const slice = (start: string, end: string) => {
    const a = cli.indexOf(start);
    expect(a).toBeGreaterThan(-1);
    const b = cli.indexOf(end, a);
    expect(b).toBeGreaterThan(a);
    return cli.slice(a, b);
  };

  test("saveProfile stamps the generation only on the OpenCode branch, before serialising", () => {
    const body = slice("function saveProfile(", "function listProfileIds(");
    const stamp = body.indexOf("normalizeStoredProfile(id, isOpencode ? stampOpencodeGeneration(profile) : profile)");
    expect(stamp).toBeGreaterThan(-1);
    expect(body.indexOf("serializeProfileForConfigJson(")).toBeGreaterThan(stamp);
  });

  test("node start backfills a pre-#542 OpenCode config before agent-node is spawned", () => {
    const body = slice("async function launchAgent(", "// spawn agent-node");
    const backfill = body.indexOf("backfillOpencodeGeneration(");
    expect(backfill).toBeGreaterThan(-1);
    expect(body.lastIndexOf('if (runtime === "opencode-cli") {', backfill)).toBeGreaterThan(-1);
    expect(body.slice(backfill)).toContain('readOpencodePrivateProfileFile(dir, "config.json")');
    expect(body.slice(backfill)).toContain('writeOpencodePrivateProfileFile(dir, "config.json", body)');
  });
});
