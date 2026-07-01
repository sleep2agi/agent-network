// Unit tests for #180 environ-based alias matching.
//
// The parseEnvironAlias algorithm handles the exact byte-shape of
// /proc/<pid>/environ (NUL-separated key=val). Locks that shape so a
// future regression (substring match / newline-split / etc.) FAILS at
// unit-test gate — not just docker e2e.
//
// Real e2e (docs/tests/p-180-rename-ghost/run-5-postfix.txt) proves the
// live procfs read + kill flow works. These tests lock the parser.

import { describe, expect, test } from "bun:test";
import { parseEnvironAlias, findEnvironAliasMatches } from "../src/environ-alias";

describe("parseEnvironAlias", () => {
  test("extracts COMMHUB_ALIAS from a normal env blob", () => {
    const blob = "PATH=/usr/bin\0COMMHUB_ALIAS=my-node\0HOME=/root\0";
    expect(parseEnvironAlias(blob)).toBe("my-node");
  });

  test("returns null when COMMHUB_ALIAS is absent", () => {
    const blob = "PATH=/usr/bin\0HOME=/root\0LANG=C.UTF-8\0";
    expect(parseEnvironAlias(blob)).toBeNull();
  });

  test("returns empty string when COMMHUB_ALIAS is set to empty", () => {
    const blob = "PATH=/usr/bin\0COMMHUB_ALIAS=\0HOME=/root\0";
    expect(parseEnvironAlias(blob)).toBe("");
  });

  test("does NOT match a substring like SUBCOMMHUB_ALIAS or COMMHUB_ALIAS_X", () => {
    // The prefix check is `startsWith("COMMHUB_ALIAS=")` — exact key name
    // followed by `=`. Anything else must NOT match.
    const blob = "SUBCOMMHUB_ALIAS=trap\0COMMHUB_ALIAS_X=trap2\0PATH=/usr/bin\0";
    expect(parseEnvironAlias(blob)).toBeNull();
  });

  test("returns FIRST match on duplicate keys (shouldn't happen but be predictable)", () => {
    const blob = "COMMHUB_ALIAS=first\0COMMHUB_ALIAS=second\0";
    expect(parseEnvironAlias(blob)).toBe("first");
  });

  test("handles alias values containing = signs (preserves everything after first =)", () => {
    const blob = "COMMHUB_ALIAS=weird=alias=with=equals\0PATH=/x\0";
    expect(parseEnvironAlias(blob)).toBe("weird=alias=with=equals");
  });

  test("empty blob returns null", () => {
    expect(parseEnvironAlias("")).toBeNull();
  });

  test("handles blob without trailing NUL (defensive — /proc/environ always has NUL-terminated, but be robust)", () => {
    const blob = "PATH=/usr/bin\0COMMHUB_ALIAS=my-node";  // no trailing NUL
    expect(parseEnvironAlias(blob)).toBe("my-node");
  });
});

describe("findEnvironAliasMatches", () => {
  test("empty aliases set → returns empty array (no scan)", () => {
    const result = findEnvironAliasMatches([], process.pid);
    expect(result).toEqual([]);
  });

  test("only filters non-empty aliases (empty string aliases dropped)", () => {
    const result = findEnvironAliasMatches(["", ""], process.pid);
    expect(result).toEqual([]);
  });

  // NOTE: full /proc scan is Linux-only and needs a live process with a
  // matching COMMHUB_ALIAS to test end-to-end. Docker e2e
  // (docs/tests/p-180-rename-ghost/run-5-postfix.txt) provides that
  // coverage against the real kernel procfs + real spawn. Here we only
  // lock the algorithmic surface (parse + empty-input handling).
});
