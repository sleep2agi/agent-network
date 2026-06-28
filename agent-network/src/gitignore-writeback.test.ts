// Coverage for the idempotent .gitignore writeback helper.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureGitignoreRule, ensureGitignoreRules } from "./gitignore-writeback";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "anet-gi-"));
});

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("ensureGitignoreRule — file does not exist", () => {
  test("creates file with the rule + trailing newline", () => {
    const path = join(scratch, ".gitignore");
    const out = ensureGitignoreRule(path, ".anet/");
    expect(out).toBe("created");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(".anet/\n");
  });

  test("trims surrounding whitespace from the rule before writing", () => {
    const path = join(scratch, ".gitignore");
    ensureGitignoreRule(path, "   .anet/   ");
    expect(readFileSync(path, "utf-8")).toBe(".anet/\n");
  });
});

describe("ensureGitignoreRule — file exists, rule absent", () => {
  test("appends rule and reports 'appended'", () => {
    const path = join(scratch, ".gitignore");
    Bun.write(path, "node_modules/\n.env\n");
    // Force sync read after async Bun.write
    Bun.file(path);
    const out = ensureGitignoreRule(path, ".anet/");
    expect(out).toBe("appended");
    expect(readFileSync(path, "utf-8")).toBe("node_modules/\n.env\n.anet/\n");
  });

  test("adds missing trailing newline before appending", () => {
    const path = join(scratch, ".gitignore");
    writeFileSyncRaw(path, "node_modules"); // no trailing newline
    const out = ensureGitignoreRule(path, ".anet/");
    expect(out).toBe("appended");
    expect(readFileSync(path, "utf-8")).toBe("node_modules\n.anet/\n");
  });

  test("empty file → appended, not created", () => {
    const path = join(scratch, ".gitignore");
    writeFileSyncRaw(path, "");
    const out = ensureGitignoreRule(path, ".anet/");
    expect(out).toBe("appended");
    expect(readFileSync(path, "utf-8")).toBe(".anet/\n");
  });
});

describe("ensureGitignoreRule — rule already present (idempotent)", () => {
  test("exact match returns already-present + does not modify file", () => {
    const path = join(scratch, ".gitignore");
    writeFileSyncRaw(path, "node_modules/\n.anet/\n.env\n");
    const before = readFileSync(path, "utf-8");
    const out = ensureGitignoreRule(path, ".anet/");
    expect(out).toBe("already-present");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  test("trimmed match (rule with surrounding whitespace) treats as present", () => {
    const path = join(scratch, ".gitignore");
    writeFileSyncRaw(path, "  .anet/  \n");
    const out = ensureGitignoreRule(path, ".anet/");
    expect(out).toBe("already-present");
  });

  test("commented-out rule does NOT count as present", () => {
    // `# .anet/` is a comment, not an active rule. We must still
    // append the actual rule below it.
    const path = join(scratch, ".gitignore");
    writeFileSyncRaw(path, "# .anet/\nnode_modules/\n");
    const out = ensureGitignoreRule(path, ".anet/");
    expect(out).toBe("appended");
    expect(readFileSync(path, "utf-8")).toBe("# .anet/\nnode_modules/\n.anet/\n");
  });

  test("multiple invocations are idempotent (call 3 times)", () => {
    const path = join(scratch, ".gitignore");
    ensureGitignoreRule(path, ".anet/");
    const after1 = readFileSync(path, "utf-8");
    expect(ensureGitignoreRule(path, ".anet/")).toBe("already-present");
    expect(ensureGitignoreRule(path, ".anet/")).toBe("already-present");
    expect(readFileSync(path, "utf-8")).toBe(after1);
  });
});

describe("ensureGitignoreRule — multiple distinct rules don't collide", () => {
  test("two different rules go to two different lines", () => {
    const path = join(scratch, ".gitignore");
    ensureGitignoreRule(path, ".anet/");
    ensureGitignoreRule(path, "nodes/*/.env");
    const body = readFileSync(path, "utf-8");
    expect(body).toContain(".anet/\n");
    expect(body).toContain("nodes/*/.env\n");
  });

  test("similar-but-different rules don't false-match (`.anet/` vs `.anet/foo`)", () => {
    const path = join(scratch, ".gitignore");
    ensureGitignoreRule(path, ".anet/");
    const out = ensureGitignoreRule(path, ".anet/foo");
    expect(out).toBe("appended");
    expect(readFileSync(path, "utf-8")).toBe(".anet/\n.anet/foo\n");
  });
});

describe("ensureGitignoreRules — batch", () => {
  test("empty rules list is a no-op", () => {
    const path = join(scratch, ".gitignore");
    const result = ensureGitignoreRules(path, []);
    expect(result).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  test("creates file with all rules on first call", () => {
    const path = join(scratch, ".gitignore");
    const result = ensureGitignoreRules(path, [".anet/", "nodes/*/.env"]);
    expect(result).toEqual(["created", "appended"]);
    expect(readFileSync(path, "utf-8")).toBe(".anet/\nnodes/*/.env\n");
  });

  test("second batch call is fully idempotent", () => {
    const path = join(scratch, ".gitignore");
    ensureGitignoreRules(path, [".anet/", "nodes/*/.env"]);
    const result = ensureGitignoreRules(path, [".anet/", "nodes/*/.env"]);
    expect(result).toEqual(["already-present", "already-present"]);
  });

  test("partial overlap — only new rules appended", () => {
    const path = join(scratch, ".gitignore");
    writeFileSyncRaw(path, ".env\n.anet/\n");
    const result = ensureGitignoreRules(path, [".anet/", "nodes/*/.env"]);
    expect(result).toEqual(["already-present", "appended"]);
    expect(readFileSync(path, "utf-8")).toBe(".env\n.anet/\nnodes/*/.env\n");
  });
});

describe("ensureGitignoreRule — defensive", () => {
  test("empty rule throws", () => {
    const path = join(scratch, ".gitignore");
    expect(() => ensureGitignoreRule(path, "")).toThrow(/non-empty/);
  });

  test("whitespace-only rule throws", () => {
    const path = join(scratch, ".gitignore");
    expect(() => ensureGitignoreRule(path, "   ")).toThrow(/non-empty/);
  });
});

// Helper for sync raw write so tests don't fight Bun.write's async.
function writeFileSyncRaw(path: string, content: string) {
  const { writeFileSync } = require("node:fs");
  writeFileSync(path, content);
}
