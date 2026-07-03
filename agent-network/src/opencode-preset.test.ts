// RFC-029 PR③ — vendor preset registry + auth.json writer tests.

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  OPENCODE_PRESETS,
  findOpencodePreset,
  readPresetKeyFromEnv,
  buildAuthJsonBody,
  writeOpencodeAuthJson,
  writeOpencodeConfigJson,
} from "./opencode-preset";

describe("OPENCODE_PRESETS registry", () => {
  test("exports the two blessed presets (anthropic + openai)", () => {
    expect(OPENCODE_PRESETS).toHaveLength(2);
    expect(OPENCODE_PRESETS.map(p => p.id).sort()).toEqual(["anthropic", "openai"]);
  });

  test("findOpencodePreset('anthropic') returns the record; unknown returns null", () => {
    expect(findOpencodePreset("anthropic")?.envKey).toBe("ANTHROPIC_API_KEY");
    expect(findOpencodePreset("openai")?.envKey).toBe("OPENAI_API_KEY");
    expect(findOpencodePreset("kimi")).toBeNull();
  });
});

describe("readPresetKeyFromEnv — env-only, no interactive prompt", () => {
  test("returns the trimmed key when the env var is set", () => {
    const p = findOpencodePreset("anthropic")!;
    expect(readPresetKeyFromEnv(p, { ANTHROPIC_API_KEY: "  sk-example-abc  " })).toBe("sk-example-abc");
  });

  test("returns null when the env var is missing / empty", () => {
    const p = findOpencodePreset("openai")!;
    expect(readPresetKeyFromEnv(p, {})).toBeNull();
    expect(readPresetKeyFromEnv(p, { OPENAI_API_KEY: "" })).toBeNull();
    expect(readPresetKeyFromEnv(p, { OPENAI_API_KEY: "   " })).toBeNull();
  });
});

describe("buildAuthJsonBody + writeOpencodeAuthJson", () => {
  let workdir: string;
  beforeEach(() => { workdir = mkdtempSync(join(tmpdir(), "opencode-preset-")); });

  test("body shape matches opencode auth.json convention", () => {
    const p = findOpencodePreset("anthropic")!;
    const body = buildAuthJsonBody(p, "sk-example-abc");
    const parsed = JSON.parse(body);
    expect(parsed.anthropic.type).toBe("api");
    expect(parsed.anthropic.key).toBe("sk-example-abc");
  });

  test("writes to <workdir>/.local/share/opencode/auth.json with mode 0o600", () => {
    const p = findOpencodePreset("anthropic")!;
    const path = writeOpencodeAuthJson(workdir, p, "sk-example-abc");
    expect(path.endsWith(".local/share/opencode/auth.json")).toBe(true);
    const st = statSync(path);
    // mask off the type bits — only interested in the permission bits.
    expect(st.mode & 0o777).toBe(0o600);
    const raw = readFileSync(path, "utf-8");
    expect(JSON.parse(raw).anthropic.key).toBe("sk-example-abc");
  });

  test("writeOpencodeConfigJson lands under .config/opencode with 0o600", () => {
    const p = findOpencodePreset("openai")!;
    const path = writeOpencodeConfigJson(workdir, p);
    expect(path.endsWith(".config/opencode/opencode.json")).toBe(true);
    const st = statSync(path);
    expect(st.mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.provider.openai).toBeDefined();
  });
});
