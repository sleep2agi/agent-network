import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NODE_FOLDER_RE, NODE_NAME_CASES, LEGACY_NODE_NAME_RE,
  checkNodeName, nodeDirNameFor, nodeFolderSlug, fnv1aHex,
} from "./node-name.js";

// Board #652 — one name rule for hub + daemon (+ the app's pinned copy).

describe("#652 checkNodeName — shared vectors", () => {
  for (const c of NODE_NAME_CASES) {
    test(`${JSON.stringify(c.input).slice(0, 24)} → ${c.ok ? "ok" : c.error}`, () => {
      const r = checkNodeName(c.input);
      expect(r.ok).toBe(c.ok);
      if (!r.ok) {
        expect(r.error).toBe(c.error!);
        expect(r.message.length).toBeGreaterThan(0);
      }
      if (c.slug !== undefined) expect(nodeFolderSlug(c.input)).toBe(c.slug);
    });
  }

  test("the vector table really contains Chinese names that pass (old rule would refuse them)", () => {
    const cjkOk = NODE_NAME_CASES.filter(c => c.ok && /\p{Script=Han}/u.test(c.input));
    expect(cjkOk.length).toBeGreaterThan(0);
    for (const c of cjkOk) expect(LEGACY_NODE_NAME_RE.test(c.input)).toBe(false);
  });
});

describe("#652 folder slug", () => {
  test("every slug — incl. every accepted vector — matches the ASCII folder rule", () => {
    for (const c of NODE_NAME_CASES.filter(x => x.ok)) {
      const s = nodeFolderSlug(c.input);
      expect(NODE_FOLDER_RE.test(s)).toBe(true);
      expect(/^[\x21-\x7e]+$/.test(s)).toBe(true);
    }
  });
  test("non-ASCII → node-<6 hex>, deterministic", () => {
    expect(nodeFolderSlug("测试")).toMatch(/^node-[0-9a-f]{6}$/);
    expect(nodeFolderSlug("测试")).toBe(nodeFolderSlug(" 测试 "));
    expect(nodeFolderSlug("测试")).not.toBe(nodeFolderSlug("测验"));
  });
  test("fnv1a known answers (pins the app reimplementation)", () => {
    expect(fnv1aHex("")).toBe("811c9dc5");
    expect(fnv1aHex("a")).toBe("e40c292c");
    expect(fnv1aHex("foobar")).toBe("bf9cf968");
  });
  test("nodeDirNameFor keeps legacy names as-is (existing nodes never move)", () => {
    for (const n of ["a", "demo-bot", "node_1", "my_agent"]) expect(nodeDirNameFor(n)).toBe(n);
    expect(nodeDirNameFor("测试")).toBe(nodeFolderSlug("测试"));
    expect(nodeDirNameFor("MyBot")).toBe("mybot");
  });
});

describe("#652 hub/daemon node-name drift guard", () => {
  test("byte-identical source files", () => {
    const hub = readFileSync(join(import.meta.dir, "node-name.ts"), "utf-8");
    const daemon = readFileSync(join(import.meta.dir, "..", "..", "..", "agent-node", "src", "shared", "node-name.ts"), "utf-8");
    expect(daemon).toBe(hub);
  });
});
