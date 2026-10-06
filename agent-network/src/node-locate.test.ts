import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childWorkdirsPath,
  codexIndexNodeDirs,
  decideDeleteTarget,
  formatDeleteAmbiguous,
  formatDeleteElsewhere,
  matchNodesInRoot,
  otherNodeRoots,
  readChildWorkdirs,
  recordChildWorkdir,
  rootOfNodeDir,
  type NodeMatch,
} from "./node-locate";

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "node-locate-")));
const mkRoot = (base: string, name: string) => { const r = join(base, name); mkdirSync(join(r, ".anet", "nodes"), { recursive: true }); return r; };

describe("decideDeleteTarget", () => {
  const here = tmp();
  const there = tmp();
  const m = (root: string, id: string, how: NodeMatch["how"], nodeId?: string): NodeMatch => ({ root, id, how, nodeId });

  test("a directory with that name here wins outright", () => {
    const d = decideDeleteTarget(here, [m(there, "x", "dir", "n_2"), m(here, "x", "dir", "n_1")]);
    expect(d).toEqual({ kind: "here", match: m(here, "x", "dir", "n_1") });
  });
  test("one match elsewhere ⇒ elsewhere (never acted on here)", () => {
    expect(decideDeleteTarget(here, [m(there, "x", "dir", "n_2")]).kind).toBe("elsewhere");
  });
  test("two name matches ⇒ ambiguous, whichever roots", () => {
    expect(decideDeleteTarget(here, [m(here, "y", "name"), m(there, "x", "dir")]).kind).toBe("ambiguous");
    expect(decideDeleteTarget(here, [m(here, "y", "name"), m(here, "z", "name")]).kind).toBe("ambiguous");
  });
  test("a unique node_id match resolves; a duplicated one does not", () => {
    expect(decideDeleteTarget(here, [m(there, "x", "node_id", "n_9"), m(here, "y", "name")])).toEqual({ kind: "elsewhere", match: m(there, "x", "node_id", "n_9") });
    expect(decideDeleteTarget(here, [m(there, "x", "node_id", "n_9"), m(here, "y", "node_id", "n_9")]).kind).toBe("ambiguous");
  });
  test("the same node reached twice counts once", () => {
    expect(decideDeleteTarget(here, [m(there, "x", "dir"), m(there, "x", "dir")]).kind).toBe("elsewhere");
  });
  test("nothing ⇒ none", () => {
    expect(decideDeleteTarget(here, []).kind).toBe("none");
  });
});

describe("matchNodesInRoot", () => {
  test("strongest match per node; unrelated nodes ignored", () => {
    const r = matchNodesInRoot("/r", "x", [
      { id: "x", profile: { node_id: "n_1", alias: "x" } },
      { id: "y", profile: { node_id: "n_2", node_name: "x" } },
      { id: "z", profile: { node_id: "x" } },
      { id: "w", profile: { node_id: "n_4", alias: "w" } },
      { id: "v", profile: null },
    ]);
    expect(r.map(x => `${x.id}:${x.how}`)).toEqual(["x:dir", "y:name", "z:node_id"]);
  });
});

describe("registry", () => {
  test("clone index preserves adopted objects and cannot replace their alias", () => {
    const root = mkRoot(tmp(), "daemon");
    const adopted = { adopted: true, node_id: "n_fixture", request_id: "adopt_fixture", workdir: "/fixture/manual", launch_mode: "bare" };
    writeFileSync(childWorkdirsPath(root), JSON.stringify({ manual: adopted, old: "/fixture/old" }));
    expect(recordChildWorkdir(root, "copy", "/fixture/copy", false)).toBe(true);
    expect(JSON.parse(readFileSync(childWorkdirsPath(root), "utf8"))).toEqual({ manual: adopted, old: "/fixture/old", copy: "/fixture/copy" });
    expect(recordChildWorkdir(root, "manual", "/fixture/replacement", false)).toBe(false);
    expect(JSON.parse(readFileSync(childWorkdirsPath(root), "utf8")).manual).toEqual(adopted);
  });
  test("records only a different workdir for a name not taken here; 0600; agent-node format", () => {
    const base = tmp();
    const root = mkRoot(base, "src");
    expect(recordChildWorkdir(root, "a", root, false)).toBe(false);
    expect(recordChildWorkdir(root, "a", join(base, "w"), true)).toBe(false);
    expect(recordChildWorkdir(root, "a", join(base, "w"), false)).toBe(true);
    expect(readChildWorkdirs(root)).toEqual({ a: join(base, "w") });
    expect(statSync(childWorkdirsPath(root)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(childWorkdirsPath(root), "utf-8"))).toEqual({ a: join(base, "w") });
  });
  test("otherNodeRoots: registry + codex index, existing roots only, not the current one", () => {
    const base = tmp();
    const root = mkRoot(base, "src");
    const a = mkRoot(base, "a");
    const b = mkRoot(base, "b");
    recordChildWorkdir(root, "x", a, false);
    recordChildWorkdir(root, "gone", join(base, "missing"), false);
    const idx = join(base, "idx");
    mkdirSync(idx);
    writeFileSync(join(idx, "1.json"), JSON.stringify({ node_dir: join(b, ".anet", "nodes", "y") }));
    writeFileSync(join(idx, "2.json"), JSON.stringify({ node_dir: join(root, ".anet", "nodes", "z") }));
    writeFileSync(join(idx, "3.json"), "{not json");
    expect(codexIndexNodeDirs(idx).length).toBe(2);
    expect(otherNodeRoots(root, idx)).toEqual([a, b]);
  });
  test("rootOfNodeDir only accepts <root>/.anet/nodes/<id>", () => {
    expect(rootOfNodeDir("/w/.anet/nodes/x")).toBe("/w");
    expect(rootOfNodeDir("/w/nodes/x")).toBeNull();
  });
});

describe("messages", () => {
  test("elsewhere prints one runnable cd && delete command", () => {
    const lines = formatDeleteElsewhere("x", { root: "/w d", id: "x", how: "dir", nodeId: "n_1" }, true, q);
    expect(lines.at(-1)).toBe(`  cd '/w d' && anet node delete 'x' --force`);
  });
  test("ambiguous lists every candidate by node_id", () => {
    const lines = formatDeleteAmbiguous("x", [
      { root: "/a", id: "x", how: "dir", nodeId: "n_1" },
      { root: "/b", id: "x", how: "dir", nodeId: "n_2" },
    ], q).join("\n");
    expect(lines).toContain("refusing to delete");
    expect(lines).toContain(`cd '/a' && anet node delete 'n_1'`);
    expect(lines).toContain(`cd '/b' && anet node delete 'n_2'`);
  });
});
