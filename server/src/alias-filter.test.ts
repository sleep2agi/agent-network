import { expect, test } from "bun:test";
import { parseAliasFilter } from "./alias-filter";

test("no filter given means no filtering, not an empty match", () => {
  for (const raw of [undefined, null, "", "   ", ",", " , , "]) {
    const f = parseAliasFilter(raw as any);
    expect(f.aliases).toEqual([]);
    expect(f.sql).toBe("");
  }
});

test("a single alias produces one placeholder", () => {
  const f = parseAliasFilter("TM门户马");
  expect(f.aliases).toEqual(["TM门户马"]);
  expect(f.sql).toBe(" AND alias IN (?)");
});

test("several aliases keep their order and count", () => {
  const f = parseAliasFilter("A站内容,A站内容牛,hub");
  expect(f.aliases).toEqual(["A站内容", "A站内容牛", "hub"]);
  expect(f.sql).toBe(" AND alias IN (?,?,?)");
});

test("surrounding whitespace is trimmed", () => {
  expect(parseAliasFilter(" a , b ").aliases).toEqual(["a", "b"]);
});

// The point of the module. A trailing comma must not become `alias = ''`,
// which matches nothing and reads exactly like "those nodes do not exist".
test("blank entries are dropped, never turned into a match-nothing term", () => {
  const f = parseAliasFilter("a,,b,");
  expect(f.aliases).toEqual(["a", "b"]);
  expect(f.sql).toBe(" AND alias IN (?,?)");
  expect(f.aliases).not.toContain("");
});

test("a filter of only commas is the same as no filter — it must not silently match zero rows", () => {
  const f = parseAliasFilter(",,,");
  expect(f.sql).toBe("");
});

test("placeholder count always equals alias count, so params can never misalign", () => {
  for (const raw of ["a", "a,b", "a,,b", " a , b , c ", ",x,"]) {
    const f = parseAliasFilter(raw);
    expect((f.sql.match(/\?/g) ?? []).length).toBe(f.aliases.length);
  }
});

test("aliases are passed through verbatim — no globbing, no case folding", () => {
  const f = parseAliasFilter("A站内容,a站内容");
  expect(f.aliases).toEqual(["A站内容", "a站内容"]);
  expect(f.sql).not.toContain("LIKE");
});

// Wiring: the tool must actually use this module, and must say what its
// `summary` counted — a caller who asked about three aliases and gets back
// "idle: 96" can easily read the 96 as being about their three.
import { readFileSync } from "fs";
import { join } from "path";

test("get_all_status uses parseAliasFilter and declares what summary counted", () => {
  const source = readFileSync(join(import.meta.dir, "tools.ts"), "utf8");
  const a = source.indexOf('"get_all_status"');
  expect(a).toBeGreaterThan(-1);
  const body = source.slice(a, source.indexOf('server.tool(', a + 10));
  expect(body).toContain("filter_alias");
  expect(body).toContain("parseAliasFilter(filter_alias)");
  expect(body).toContain("summary_scope");
  expect(body).toContain("sessions_returned");
  // The alias list must go through parameters, never be interpolated.
  expect(body).not.toMatch(/alias IN \(\$\{/);
});
