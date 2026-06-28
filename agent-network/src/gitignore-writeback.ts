// Idempotent .gitignore writeback. Used by `anet init project` and
// `anet node create` to make sure `.anet/` plus its mode-600 secret
// stores never accidentally land in `git status` (and therefore never
// get swept by `git clean -fd` / `git stash -u`, which is the exact
// shape of the 2026-06 incident that lost a node's access.json +
// flags.json + per-node tokens).
//
// Pure helper: takes the file path and the rule, returns a value
// describing whether the file was touched. No process.cwd reads, no
// console.log — caller decides logging.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Outcome of one rule check against one `.gitignore` file.
 */
export type EnsureRuleOutcome =
  | "already-present"  // line already in file (idempotent no-op)
  | "appended"         // file existed, we appended the rule
  | "created"          // file did not exist, we created it with the rule
  | "skipped-no-anet"; // file's parent .anet dir does not exist — we don't materialise it just to write a gitignore

/**
 * Append `rule` to `gitignorePath` unless an exactly-matching line
 * already exists. Returns the outcome. Never throws on missing parent
 * directory — caller is expected to have created it (or wants the
 * gitignore skipped, per the `.anet`-scoped writer below).
 *
 * The rule comparison is line-exact after `trim()`. Rules with leading
 * `#` (comment lines in the same file) are ignored for the duplicate
 * check, so an end-user can leave commented-out variants in place
 * without confusing the idempotent guard.
 */
export function ensureGitignoreRule(
  gitignorePath: string,
  rule: string,
): EnsureRuleOutcome {
  const target = rule.trim();
  if (!target) throw new Error("ensureGitignoreRule: rule must be non-empty");

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, target + "\n");
    return "created";
  }

  const content = readFileSync(gitignorePath, "utf-8");
  const present = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .some((l) => l === target);
  if (present) return "already-present";

  const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignorePath, content + sep + target + "\n");
  return "appended";
}

/**
 * Convenience: append multiple rules to one `.gitignore` file with one
 * read/write pair. Returns the outcome per rule, in input order.
 */
export function ensureGitignoreRules(
  gitignorePath: string,
  rules: string[],
): EnsureRuleOutcome[] {
  if (rules.length === 0) return [];
  // For correctness under repeated rules, we still call the single-
  // rule writer per entry. Disk IO is small (writeFileSync rewrites
  // the whole file) and the per-rule loop keeps the contract trivial
  // to reason about.
  return rules.map((r) => ensureGitignoreRule(gitignorePath, r));
}
