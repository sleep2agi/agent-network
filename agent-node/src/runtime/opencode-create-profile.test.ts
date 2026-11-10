import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCreatedOpencodeProfile } from "./opencode-create-profile.js";
import { prepareOpencodeNodeForProfileWrite } from "../shared/opencode-preset.js";
import { opencodeRuntimeBindingPath, readOpencodeRuntimeBinding } from "../shared/opencode-runtime-binding.js";

let root: string, home: string, project: string, node: string;
const cfg = { runtime: "opencode-cli", node_id: "node_request1", alias: "oc", token: "ntok_test_only", opencodeGeneration: "v2", opencodeMode: "copresence" };
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "test829-binding-")));
  home = join(root, "home"); project = join(root, "project");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(project, { mode: 0o700 });
  node = join(project, ".anet", "nodes", "oc");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const create = () => writeCreatedOpencodeProfile(node, cfg, home);

test("fresh daemon profile has CLI-readable external binding and private files", () => {
  create();
  expect(readOpencodeRuntimeBinding(node, home)).toEqual({ schemaVersion: 1, runtime: "opencode-cli", projectRoot: project, nodeId: "oc" });
  expect(JSON.parse(readFileSync(join(node, "config.json"), "utf8"))).toEqual(cfg);
  expect(statSync(node).mode & 0o777).toBe(0o700);
  expect(statSync(join(node, "config.json")).mode & 0o777).toBe(0o600);
  expect(statSync(opencodeRuntimeBindingPath(node, home)).mode & 0o777).toBe(0o600);
});
test("exact request retry preserves the binding inode", () => {
  create();
  const path = opencodeRuntimeBindingPath(node, home), before = statSync(path);
  create();
  expect(statSync(path).ino).toBe(before.ino);
});
test("another request cannot overwrite an existing node token", () => {
  create();
  expect(() => writeCreatedOpencodeProfile(node, { ...cfg, node_id: "node_other", token: "other" }, home)).toThrow(/different node identity/);
  expect(JSON.parse(readFileSync(join(node, "config.json"), "utf8")).token).toBe(cfg.token);
});
test("legacy unbound config is not silently adopted", () => {
  prepareOpencodeNodeForProfileWrite(node);
  const body = JSON.stringify(cfg);
  writeFileSync(join(node, "config.json"), body, { mode: 0o600 });
  expect(create).toThrow(/unbound/);
  expect(readFileSync(join(node, "config.json"), "utf8")).toBe(body);
  expect(readOpencodeRuntimeBinding(node, home)).toBeUndefined();
});
test("tampered binding is never repaired by creation", () => {
  create();
  const path = opencodeRuntimeBindingPath(node, home);
  writeFileSync(path, "{}\n");
  expect(create).toThrow(/does not exactly match/);
  expect(readFileSync(path, "utf8")).toBe("{}\n");
});
for (const kind of ["symlink", "hardlink"] as const) {
  test(`${kind} config refuses before token write and leaves victim unchanged`, () => {
    prepareOpencodeNodeForProfileWrite(node);
    const victim = join(root, "victim");
    writeFileSync(victim, "untouched", { mode: 0o600 });
    (kind === "symlink" ? symlinkSync : linkSync)(victim, join(node, "config.json"));
    expect(create).toThrow(/single-link regular file/);
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(readOpencodeRuntimeBinding(node, home)).toBeUndefined();
  });
}
test("symlinked ancestor cannot create secret paths outside the project", () => {
  const victim = join(root, "victim"); mkdirSync(victim, { mode: 0o700 });
  symlinkSync(victim, join(project, ".anet"));
  expect(create).toThrow(/canonical real directory/);
  expect(existsSync(join(victim, "nodes"))).toBe(false);
});
test("tracked node state refuses before binding or profile write", () => {
  prepareOpencodeNodeForProfileWrite(node);
  execFileSync("git", ["init", "-q", project]);
  writeFileSync(join(node, "tracked"), "fixture");
  execFileSync("git", ["-C", project, "add", "--", ".anet/nodes/oc/tracked"]);
  expect(create).toThrow(/tracked by Git/);
  expect(existsSync(join(node, "config.json"))).toBe(false);
  expect(readOpencodeRuntimeBinding(node, home)).toBeUndefined();
});
test("unsafe HOME refuses before token write", () => {
  chmodSync(home, 0o777);
  expect(create).toThrow(/group\/world writable/);
  expect(existsSync(join(node, "config.json"))).toBe(false);
});
test("missing HOME refuses before token write", () => {
  expect(() => writeCreatedOpencodeProfile(node, cfg, join(root, "missing"))).toThrow();
  expect(existsSync(join(node, "config.json"))).toBe(false);
});
test("project-overlapping binding root refuses before token write", () => {
  expect(() => writeCreatedOpencodeProfile(node, cfg, project)).toThrow(/must not overlap/);
  expect(existsSync(join(node, "config.json"))).toBe(false);
});
