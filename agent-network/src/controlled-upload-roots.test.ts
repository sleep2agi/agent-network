import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultControlledUploadRoots } from "./controlled-upload";

describe("defaultControlledUploadRoots: a node's project root (has .anet/nodes) is trusted (2026-09-15)", () => {
  test("cwd with .anet/nodes is included; a plain directory is not", () => {
    const home = mkdtempSync(join(tmpdir(), "anet-home-"));
    const project = mkdtempSync(join(tmpdir(), "anet-proj-"));
    mkdirSync(join(project, ".anet", "nodes"), { recursive: true });
    const roots = defaultControlledUploadRoots({ home, alias: "x", cwd: project, env: {} });
    expect(roots).toContain(realpathSync(project));
    const plain = mkdtempSync(join(tmpdir(), "anet-plain-"));
    expect(defaultControlledUploadRoots({ home, alias: "x", cwd: plain, env: {} })).not.toContain(realpathSync(plain));
  });
  test("cwd under ~/.anet is still trusted (old rule kept)", () => {
    const home = mkdtempSync(join(tmpdir(), "anet-home2-"));
    mkdirSync(join(home, ".anet", "nodes", "n1"), { recursive: true });
    const roots = defaultControlledUploadRoots({ home, alias: "n1", cwd: join(home, ".anet", "nodes", "n1"), env: {} });
    expect(roots).toContain(realpathSync(join(home, ".anet", "nodes", "n1")));
  });
});
