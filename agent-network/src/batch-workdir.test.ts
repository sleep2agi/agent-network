import { describe, expect, test } from "bun:test";
import { join } from "path";
import { normalizeBatchWorkdir } from "./batch-workdir";

describe("normalizeBatchWorkdir", () => {
  test("expands current-user tilde before a batch changes cwd", () => {
    const root = normalizeBatchWorkdir("~/design", "/workspace/current", "/home/tester");
    expect(root).toBe("/home/tester/design");
    expect(join(root, "node1")).toBe("/home/tester/design/node1");
    expect(join(root, "node2")).toBe("/home/tester/design/node2");
    expect(root).not.toContain("~");
  });

  test("anchors a relative workdir once to the caller cwd", () => {
    const root = normalizeBatchWorkdir("teams/research", "/workspace/current", "/home/tester");
    expect(root).toBe("/workspace/current/teams/research");
    expect(join(root, "node3")).toBe("/workspace/current/teams/research/node3");
  });

  test("keeps an absolute workdir absolute", () => {
    expect(normalizeBatchWorkdir("/srv/agents", "/elsewhere", "/home/tester"))
      .toBe("/srv/agents");
  });

  test("rejects empty and unsupported named-user shorthands", () => {
    expect(() => normalizeBatchWorkdir("  ", "/work", "/home/tester")).toThrow("empty");
    expect(() => normalizeBatchWorkdir("~other/team", "/work", "/home/tester"))
      .toThrow("unsupported home shorthand");
  });
});
