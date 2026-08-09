import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

describe("batch workdir wiring", () => {
  test("normalizes create workdir before mkdir or chdir", () => {
    expect(cli).toContain('import { normalizeBatchWorkdir } from "../src/batch-workdir"');
    const createStart = cli.indexOf("async function createBatch(opts: BatchOptions)");
    const mkdir = cli.indexOf("mkdirSync(opts.workdir", createStart);
    const normalize = cli.indexOf("opts = { ...opts, workdir: normalizeBatchWorkdir", createStart);
    expect(createStart).toBeGreaterThan(-1);
    expect(normalize).toBeGreaterThan(createStart);
    expect(mkdir).toBeGreaterThan(normalize);
  });

  test("normalizes cleanup workdir before filesystem mutation", () => {
    const lifecycleStart = cli.indexOf("function batchLifecycle(");
    const cleanupStart = cli.indexOf('if (verb === "cleanup")', lifecycleStart);
    const normalize = cli.indexOf("normalizeBatchWorkdir(workdir)", cleanupStart);
    const exists = cli.indexOf("existsSync(dir)", cleanupStart);
    const remove = cli.indexOf("rmSync(join(dir, sub)", cleanupStart);
    expect(normalize).toBeGreaterThan(cleanupStart);
    expect(exists).toBeGreaterThan(normalize);
    expect(remove).toBeGreaterThan(exists);
  });
});
