import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describeSecretsRead,
  formatSecretValue,
  globalSecretsPath,
  listSecretEntries,
  nodeDirForConfig,
  parseSecretsEnv,
  planSecretEnv,
  readSecretsFile,
  secretKeyProblem,
  setSecret,
  unsetSecret,
} from "./node-secrets";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "node-secrets-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const mode = (p: string) => statSync(p).mode & 0o777;

describe("parseSecretsEnv", () => {
  test("comments, blank lines, export prefix, quotes, = in values, CRLF, BOM", () => {
    const raw = [
      "﻿# a comment",
      "",
      "   ",
      "PLAIN=abc",
      "export EXPORTED=exp-value",
      "export   SPACED  =  padded value  ",
      "WITH_EQ=a=b==c",
      "DQ=\"quoted # not a comment\" # trailing comment",
      "ESC=\"line1\\nline2\\t\\\"q\\\"\\\\\"",
      "SQ='literal \\n $HOME'",
      "HASH=abc#def",
      "EMPTY=",
      "  # indented comment",
    ].join("\r\n");
    const { values, problems } = parseSecretsEnv(raw);
    expect(problems).toEqual([]);
    expect({ ...values }).toEqual({
      PLAIN: "abc",
      EXPORTED: "exp-value",
      SPACED: "padded value",
      WITH_EQ: "a=b==c",
      DQ: "quoted # not a comment",
      ESC: "line1\nline2\t\"q\"\\",
      SQ: "literal \\n $HOME",
      HASH: "abc#def",
      EMPTY: "",
    });
  });

  test("bad lines are reported by line number, never with their text", () => {
    const sentinel = "sk-SENTINEL-parse-9f1";
    const { values, problems } = parseSecretsEnv(`GOOD=1\nno equals ${sentinel}\nlower=${sentinel}\nQ="${sentinel}\nAFTER="x" ${sentinel}\n`);
    expect({ ...values }).toEqual({ GOOD: "1" });
    expect(problems.map((p) => p.line)).toEqual([2, 3, 4, 5]);
    expect(JSON.stringify(problems)).not.toContain(sentinel);
  });

  test("last definition wins", () => {
    expect(parseSecretsEnv("A=1\nA=2\n").values.A).toBe("2");
  });

  test("formatSecretValue round-trips awkward values", () => {
    for (const v of ["plain", "a b", " lead", "trail ", "\"q", "'s", "x\ny", "a\\b", "back\\", "#hash", "a=b", "tab\there", "\\n", "é中文"]) {
      const line = `K=${formatSecretValue(v)}`;
      expect(parseSecretsEnv(line).values.K).toBe(v);
    }
  });
});

describe("secretKeyProblem", () => {
  test("shape", () => {
    for (const k of ["OPENAI_API_KEY", "_X", "A1"]) expect(secretKeyProblem(k)).toBeNull();
    for (const k of ["", "lower", "1ABC", "A-B", "A B", "A=B", "É"]) expect(secretKeyProblem(k)).not.toBeNull();
    expect(secretKeyProblem("A".repeat(129))).not.toBeNull();
  });
  test("reserved keys that would break or hijack the node", () => {
    for (const k of ["PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "ANET_NODE_MARKER",
      "COMMHUB_TOKEN", "COMMHUB_ALIAS", "CODEX_HOME", "GROK_BINARY", "BUN_INSTALL", "NPM_CONFIG_PREFIX", "XDG_CONFIG_HOME"]) {
      expect(secretKeyProblem(k)).toContain("reserved");
    }
  });
});

describe("planSecretEnv — process env < global < node < config.json env", () => {
  test("node overrides global; config.json env keys are left alone; reserved skipped", () => {
    const plan = planSecretEnv({
      global: { SHARED: "g", ONLY_GLOBAL: "g1", IN_CONFIG: "g2", PATH: "/evil" },
      node: { SHARED: "n", ONLY_NODE: "n1", IN_CONFIG: "n2", COMMHUB_TOKEN: "x" },
      configEnvKeys: ["IN_CONFIG"],
    });
    expect({ ...plan.set }).toEqual({ SHARED: "n", ONLY_GLOBAL: "g1", ONLY_NODE: "n1" });
    expect({ ...plan.sources }).toEqual({ SHARED: "node", ONLY_GLOBAL: "global", ONLY_NODE: "node" });
    expect(plan.reserved).toEqual(["COMMHUB_TOKEN", "PATH"]);
    expect(plan.shadowedByConfig).toEqual(["IN_CONFIG"]);
  });

  test("applied over a process env, secrets win over the shell", () => {
    const env: Record<string, string> = { SHARED: "shell", SHELL_ONLY: "s" };
    Object.assign(env, planSecretEnv({ global: { SHARED: "g" } }).set);
    expect(env).toEqual({ SHARED: "g", SHELL_ONLY: "s" });
  });

  test("listSecretEntries: lengths only, node marks the global it overrides", () => {
    const e = listSecretEntries({ A: "12345", B: "xx" }, { A: "中文", C: "c" });
    expect(e).toEqual([
      { key: "A", source: "node", length: 2, overridesGlobal: true },
      { key: "B", source: "global", length: 2 },
      { key: "C", source: "node", length: 1 },
    ]);
  });
});

describe("files: permissions and atomic writes", () => {
  test("missing file is not an error", () => {
    expect(readSecretsFile(join(dir, "nope.env")).status).toBe("missing");
  });

  test("set creates 0600 even under umask 0002; parent created 0700", () => {
    const old = process.umask(0o002);
    try {
      const p = globalSecretsPath(join(dir, "home"));
      setSecret(p, "API_KEY", "v1");
      expect(mode(p)).toBe(0o600);
      expect(mode(join(dir, "home", ".anet"))).toBe(0o700);
      setSecret(p, "OTHER", "v2");
      setSecret(p, "API_KEY", "v3");
      expect(mode(p)).toBe(0o600);
      expect({ ...readSecretsFile(p).values }).toEqual({ API_KEY: "v3", OTHER: "v2" });
    } finally { process.umask(old); }
  });

  test("set/unset keep comments and other lines; no temp files left", () => {
    const p = join(dir, "secrets.env");
    writeFileSync(p, "# mine\nA=1\n\nexport B=2\n", { mode: 0o600 });
    setSecret(p, "B", "22");
    setSecret(p, "C", "3");
    expect(readFileSync(p, "utf8")).toBe("# mine\nA=1\n\nB=22\nC=3\n");
    expect(unsetSecret(p, "A").existed).toBe(true);
    expect(unsetSecret(p, "A").existed).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("# mine\n\nB=22\nC=3\n");
    const { readdirSync } = require("node:fs");
    expect(readdirSync(dir)).toEqual(["secrets.env"]);
  });

  test("set refuses reserved/invalid keys and empty values; file untouched", () => {
    const p = join(dir, "secrets.env");
    expect(() => setSecret(p, "PATH", "x")).toThrow(/reserved/);
    expect(() => setSecret(p, "bad", "x")).toThrow(/key/);
    expect(() => setSecret(p, "OK", "")).toThrow(/empty/);
    expect(readSecretsFile(p).status).toBe("missing");
  });

  test("group/world-readable file we own: tightened to 0600 and still loaded", () => {
    const p = join(dir, "secrets.env");
    writeFileSync(p, "A=1\n");
    chmodSync(p, 0o644);
    const r = readSecretsFile(p);
    expect(r.status).toBe("loaded");
    expect(r.repairedFromMode).toBe(0o644);
    expect(r.values.A).toBe("1");
    expect(mode(p)).toBe(0o600);
    expect(describeSecretsRead("global", r).join("\n")).toContain("0644; tightened to 0600");
  });

  test("a file owned by another user is refused, nothing loaded, mode untouched", () => {
    const p = join(dir, "secrets.env");
    writeFileSync(p, "A=sk-SENTINEL-owner\n");
    chmodSync(p, 0o644);
    const uid = process.getuid!();
    const r = readSecretsFile(p, uid + 1);
    expect(r.status).toBe("refused");
    expect(r.reason).toContain(`owned by uid ${uid}`);
    expect(Object.keys(r.values)).toEqual([]);
    expect(mode(p)).toBe(0o644);
    expect(describeSecretsRead("node", r).join("\n")).not.toContain("SENTINEL");
  });

  test("not a regular file is refused; set on a refused file throws", () => {
    const p = join(dir, "secrets.env");
    mkdirSync(p);
    expect(readSecretsFile(p).status).toBe("refused");
    expect(() => setSecret(p, "A", "1")).toThrow(/refusing/);
  });

  test("a symlink is followed and the target checked", () => {
    const target = join(dir, "real.env");
    writeFileSync(target, "A=1\n", { mode: 0o600 });
    const link = join(dir, "secrets.env");
    symlinkSync(target, link);
    expect(readSecretsFile(link).values.A).toBe("1");
  });
});

describe("nodeDirForConfig — same place the node's config.json lives", () => {
  test("node dir only for <…>/config.json; legacy profile paths get none", () => {
    expect(nodeDirForConfig("/w/.anet/nodes/n1/config.json")).toBe("/w/.anet/nodes/n1");
    expect(nodeDirForConfig("/home/user/proj/.anet/nodes/n2/config.json")).toBe("/home/user/proj/.anet/nodes/n2");
    expect(nodeDirForConfig("/w/.anet/profiles/n1.json")).toBeNull();
    expect(nodeDirForConfig("/w/.agent-node.json")).toBeNull();
    expect(nodeDirForConfig(undefined)).toBeNull();
  });
});
