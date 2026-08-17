import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

function fn(name: string): string {
  const a = source.indexOf(`async function ${name}(`);
  expect(a).toBeGreaterThan(-1);
  const b = source.indexOf("\nasync function ", a + 10);
  expect(b).toBeGreaterThan(a);
  return source.slice(a, b);
}

// `project up` and `project restart` measure every node (verifySpawnedNodes)
// and print every failure, so their OUTPUT was already honest. Their exit code
// was not: both returned normally, so a run that brought up 60 of 74 nodes
// exited 0. That is what forces every scripted caller — a boot sweep, CI, a
// watchdog — to re-derive the outcome instead of reading `$?`.
test("project up exits non-zero when nodes failed to come up", () => {
  const body = fn("projectUp");
  const summary = body.indexOf("printProjectSummary(");
  const gate = body.indexOf("exitFromProjectOutcome(");
  expect(summary).toBeGreaterThan(-1);
  expect(gate).toBeGreaterThan(summary);   // report first, then set the code
});

test("project restart carries the same gate", () => {
  const body = fn("projectRestart");
  expect(body).toContain("exitFromProjectOutcome(");
});

test("the gate counts unstartable configs too, not only crashes", () => {
  const a = source.indexOf("function exitFromProjectOutcome(");
  expect(a).toBeGreaterThan(-1);
  const body = source.slice(a, source.indexOf("\nfunction printProjectSummary(", a));
  // A node whose config cannot start was never attempted; calling that success
  // hides it exactly as well as a crash does.
  expect(body).toContain("invalid.length");
  expect(body).toContain("failed.length === 0");
  expect(body).toContain("process.exit(1)");
});

test("a fully successful run still returns normally", () => {
  const a = source.indexOf("function exitFromProjectOutcome(");
  const body = source.slice(a, source.indexOf("\nfunction printProjectSummary(", a));
  // The early return is what keeps the happy path at exit 0; without it every
  // successful project up would start failing.
  expect(body).toMatch(/if \(failed\.length === 0 && invalid\.length === 0\) return;/);
});

test("the failure line points at the list the operator just saw", () => {
  const a = source.indexOf("function exitFromProjectOutcome(");
  const body = source.slice(a, source.indexOf("\nfunction printProjectSummary(", a));
  expect(body).toContain("exiting non-zero");
  expect(body).toContain("see the list above");
});
