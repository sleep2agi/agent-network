import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  applyNodeServerPayload,
  decideNodeServerWrite,
  ensureNodeServerVersionMarker,
  NODE_SERVER_VERSION_MARKER_PREFIX,
  nodeServerKeptNewerWarning,
  readNodeServerVersion,
  stampNodeServerVersion,
} from "./node-server-version";

const marked = (v: string, body = "console.log('server');\n") => `${NODE_SERVER_VERSION_MARKER_PREFIX}${v}\n${body}`;
const LEGACY = "#!/usr/bin/env bun\nconsole.log('legacy server, no marker');\n";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ns-version-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function apply(existing: string | null, incoming: string) {
  const target = join(root, "node-server.js");
  if (existing !== null) writeFileSync(target, existing);
  const warnings: string[] = [];
  const result = applyNodeServerPayload(target, incoming, join(root, "nowhere", "node-server.js"), (l) => warnings.push(l));
  return { result, after: readFileSync(target, "utf-8"), warnings };
}

describe("#549 node-server version marker", () => {
  test("reads the marker from the head, after a shebang too", () => {
    expect(readNodeServerVersion(marked("2.3.0-preview.136"))).toBe("2.3.0-preview.136");
    expect(readNodeServerVersion(stampNodeServerVersion(LEGACY, "2.3.0"))).toBe("2.3.0");
    expect(stampNodeServerVersion(LEGACY, "2.3.0").startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(readNodeServerVersion(LEGACY)).toBeNull();
    expect(readNodeServerVersion(`${NODE_SERVER_VERSION_MARKER_PREFIX}not-a-version\nx`)).toBeNull();
  });

  test("stamping is idempotent", () => {
    const once = stampNodeServerVersion("x\n", "1.2.3");
    expect(stampNodeServerVersion(once, "9.9.9")).toBe(once);
  });

  test("🔴 an existing NEWER file is kept, and the warning is printed", () => {
    const existing = marked("2.3.0-preview.140", "NEW SERVER\n");
    const { result, after, warnings } = apply(existing, marked("2.3.0-preview.135", "OLD SERVER\n"));
    expect(result).toBe("kept-newer");
    expect(after).toBe(existing);
    expect(warnings).toEqual([nodeServerKeptNewerWarning("2.3.0-preview.140", "2.3.0-preview.135")]);
    expect(warnings[0]).toContain("kept .anet/node-server.js v2.3.0-preview.140");
    expect(warnings[0]).toContain("npm install -g @sleep2agi/agent-network@2.3.0-preview.140");
    expect(warnings[0]).not.toContain("\n");
  });

  test("a stable release outranks its own previews (2.3.0 > 2.3.0-preview.999)", () => {
    expect(decideNodeServerWrite(marked("2.3.0"), marked("2.3.0-preview.999")).action).toBe("keep-newer");
  });

  test("an existing OLDER file is replaced", () => {
    const incoming = marked("2.3.0-preview.140", "NEW SERVER\n");
    const { result, after, warnings } = apply(marked("2.3.0-preview.9", "OLD\n"), incoming);
    expect(result).toBe("wrote");
    expect(after).toBe(incoming);
    expect(warnings).toEqual([]);
  });

  test("an equal-version file with different bytes is replaced (as today)", () => {
    const incoming = marked("2.3.0", "B\n");
    expect(apply(marked("2.3.0", "A\n"), incoming)).toEqual({ result: "wrote", after: incoming, warnings: [] });
  });

  test("identical bytes are left alone", () => {
    const same = marked("2.3.0", "A\n");
    expect(apply(same, same).result).toBe("unchanged");
  });

  test("a legacy file without a marker is replaced", () => {
    const incoming = marked("2.3.0-preview.135", "NEW\n");
    const { result, after, warnings } = apply(LEGACY, incoming);
    expect(result).toBe("wrote");
    expect(after).toBe(incoming);
    expect(warnings).toEqual([]);
  });

  test("a missing file is written", () => {
    const incoming = marked("1.0.0");
    expect(apply(null, incoming)).toEqual({ result: "wrote", after: incoming, warnings: [] });
  });

  test("an unmarked incoming payload never blocks the write (no version to compare)", () => {
    expect(decideNodeServerWrite(marked("9.9.9"), "unmarked\n").action).toBe("write");
  });

  test("an unmarked payload is stamped from the owning agent-network package.json", () => {
    const pkgRoot = join(root, "pkg");
    mkdirSync(join(pkgRoot, "dist", "src"), { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "@sleep2agi/agent-network", version: "2.4.0-preview.1" }));
    const out = ensureNodeServerVersionMarker("x\n", join(pkgRoot, "dist", "src", "node-server.js"));
    expect(readNodeServerVersion(out)).toBe("2.4.0-preview.1");
    // A foreign package.json is not trusted.
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "other", version: "9.9.9" }));
    expect(readNodeServerVersion(ensureNodeServerVersionMarker("x\n", join(pkgRoot, "dist", "src", "node-server.js")))).toBeNull();
  });

  test("the build-time stamp script writes the marker the reader understands", () => {
    const pkgVersion = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")).version;
    const target = join(root, "built.js");
    writeFileSync(target, "#!/usr/bin/env bun\nvar a=1;\n");
    const script = join(import.meta.dir, "..", "scripts", "stamp-node-server-version.mjs");
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, [script, target], { encoding: "utf-8" });
      expect(r.status).toBe(0);
    }
    const out = readFileSync(target, "utf-8");
    expect(readNodeServerVersion(out)).toBe(pkgVersion);
    expect(out.split(NODE_SERVER_VERSION_MARKER_PREFIX).length).toBe(2); // not stacked on re-run
    expect(out.startsWith("#!/usr/bin/env bun\n")).toBe(true);
  });

  test("the package build runs the stamp after the node-server obfuscation step", () => {
    const build: string = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")).scripts.build;
    const obf = build.indexOf("javascript-obfuscator dist/src/node-server.js");
    const stamp = build.indexOf("scripts/stamp-node-server-version.mjs");
    expect(obf).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(obf);
  });
});

describe("#549 cli.ts writers go through the no-downgrade path", () => {
  // Both writers of `.anet/node-server.js` (ensureMcpJson for claude-code-cli /
  // codex-sdk / grok-build-cli, and refreshNodeServerJsAt for grok-build-acp)
  // used to writeFileSync the bundled payload unconditionally.
  const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");

  test("refreshNodeServerJsAt writes via applyNodeServerPayload, not writeFileSync", () => {
    const start = cli.indexOf("function refreshNodeServerJsAt(");
    const body = cli.slice(start, cli.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("applyNodeServerPayload(targetPath, payload, src)");
    expect(body).not.toMatch(/writeFileSync\(targetPath/);
  });

  test("ensureMcpJson writes via applyNodeServerPayload, not writeFileSync", () => {
    const start = cli.indexOf("function ensureMcpJson(");
    const body = cli.slice(start, cli.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("applyNodeServerPayload(serverTs, src, p)");
    expect(body).not.toMatch(/writeFileSync\(serverTs/);
  });
});
