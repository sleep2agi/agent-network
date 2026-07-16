import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  assertExactOpencodeRuntimeBinding,
  assertOpencodeNodeStateUntracked,
  isOpencodeRuntimeBindingModeSecure,
  opencodeRuntimeBindingPath,
  readOpencodeRuntimeBinding,
  removeOpencodeRuntimeBinding,
  writeOpencodeRuntimeBinding,
} from "./opencode-runtime-binding";

describe("external OpenCode runtime binding", () => {
  let root: string;
  let home: string;
  let project: string;
  let node: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "opencode-runtime-binding-"));
    chmodSync(root, 0o700);
    home = join(root, "home");
    project = join(root, "project");
    node = join(project, ".anet", "nodes", "node-a");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(node, { recursive: true, mode: 0o700 });
    chmodSync(project, 0o700);
    chmodSync(join(project, ".anet"), 0o700);
    chmodSync(join(project, ".anet", "nodes"), 0o700);
    chmodSync(node, 0o700);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("survives regular config runtime downgrade and proves the original exact runtime", () => {
    const configPath = join(node, "config.json");
    writeFileSync(configPath, '{"runtime":"opencode-cli"}\n', { mode: 0o600 });
    const bindingPath = writeOpencodeRuntimeBinding(node, home);

    writeFileSync(configPath, '{"runtime":"claude-code-cli"}\n', { mode: 0o600 });
    const binding = assertExactOpencodeRuntimeBinding(node, home);
    expect(binding.runtime).toBe("opencode-cli");
    expect(binding.projectRoot).toBe(project);
    expect(binding.nodeId).toBe("node-a");
    expect(JSON.parse(readFileSync(configPath, "utf8")).runtime).toBe("claude-code-cli");
    expect(lstatSync(dirname(bindingPath)).mode & 0o777).toBe(0o700);
    expect(lstatSync(bindingPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(bindingPath)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("read returns undefined only for absent state and deterministic keys separate nodes", () => {
    const second = join(project, ".anet", "nodes", "node-b");
    mkdirSync(second, { mode: 0o700 });
    expect(readOpencodeRuntimeBinding(node, home)).toBeUndefined();
    const firstPath = writeOpencodeRuntimeBinding(node, home);
    const secondPath = writeOpencodeRuntimeBinding(second, home);
    expect(firstPath).not.toBe(secondPath);
    expect(opencodeRuntimeBindingPath(node, home)).toBe(firstPath);
  });

  test("an absent exact leaf does not impose POSIX modes on ordinary runtime state", () => {
    const anet = join(home, ".anet");
    const bindingRoot = join(anet, "opencode-runtime-bindings");
    mkdirSync(bindingRoot, { recursive: true, mode: 0o775 });
    chmodSync(home, 0o775);
    chmodSync(anet, 0o775);
    chmodSync(bindingRoot, 0o775);
    writeFileSync(join(bindingRoot, "another-node.json"), "{}\n", { mode: 0o644 });

    expect(readOpencodeRuntimeBinding(node, home)).toBeUndefined();
    expect(removeOpencodeRuntimeBinding(node, home)).toBe(false);
  });

  test("unbound legacy symlink or junction-style node paths remain invisible", () => {
    const legacyProject = join(root, "legacy-project");
    const legacyNode = join(legacyProject, ".anet", "nodes", "legacy");
    mkdirSync(legacyNode, { recursive: true, mode: 0o700 });

    const projectAlias = join(root, "legacy-project-alias");
    symlinkSync(legacyProject, projectAlias);
    const intermediateAliasNode = join(projectAlias, ".anet", "nodes", "legacy");

    const externalNode = join(root, "external-node-state");
    mkdirSync(externalNode, { mode: 0o700 });
    const leafAliasProject = join(root, "leaf-alias-project");
    const leafAliasNodes = join(leafAliasProject, ".anet", "nodes");
    mkdirSync(leafAliasNodes, { recursive: true, mode: 0o700 });
    const leafAliasNode = join(leafAliasNodes, "legacy");
    symlinkSync(externalNode, leafAliasNode);

    // No binding namespace: neither path shape may affect a legacy start.
    expect(readOpencodeRuntimeBinding(intermediateAliasNode, home)).toBeUndefined();
    expect(removeOpencodeRuntimeBinding(intermediateAliasNode, home)).toBe(false);
    expect(readOpencodeRuntimeBinding(leafAliasNode, home)).toBeUndefined();
    expect(removeOpencodeRuntimeBinding(leafAliasNode, home)).toBe(false);

    // An unrelated OpenCode binding creates the namespace, but the two exact
    // leaves remain absent and therefore still cannot gate legacy runtimes.
    writeOpencodeRuntimeBinding(node, home);
    expect(readOpencodeRuntimeBinding(intermediateAliasNode, home)).toBeUndefined();
    expect(removeOpencodeRuntimeBinding(intermediateAliasNode, home)).toBe(false);
    expect(readOpencodeRuntimeBinding(leafAliasNode, home)).toBeUndefined();
    expect(removeOpencodeRuntimeBinding(leafAliasNode, home)).toBe(false);
  });

  test("Windows synthetic permission bits do not disable structural security checks", () => {
    expect(isOpencodeRuntimeBindingModeSecure(0o777, 0o700, "win32")).toBe(true);
    expect(isOpencodeRuntimeBindingModeSecure(0o666, 0o600, "win32")).toBe(true);
    expect(isOpencodeRuntimeBindingModeSecure(0o777, undefined, "win32")).toBe(true);
    expect(isOpencodeRuntimeBindingModeSecure(0o777, 0o700, "linux")).toBe(false);
    expect(isOpencodeRuntimeBindingModeSecure(0o755, undefined, "linux")).toBe(true);
    expect(isOpencodeRuntimeBindingModeSecure(0o775, undefined, "linux")).toBe(false);
  });

  test("secure removal is idempotent and removes the exact binding", () => {
    expect(removeOpencodeRuntimeBinding(node, home)).toBe(false);
    const bindingPath = writeOpencodeRuntimeBinding(node, home);
    expect(existsSync(bindingPath)).toBe(true);
    expect(removeOpencodeRuntimeBinding(node, home)).toBe(true);
    expect(existsSync(bindingPath)).toBe(false);
    expect(removeOpencodeRuntimeBinding(node, home)).toBe(false);
  });

  test("secure removal refuses tampered content without unlinking it", () => {
    const bindingPath = writeOpencodeRuntimeBinding(node, home);
    const tampered = JSON.parse(readFileSync(bindingPath, "utf8"));
    tampered.runtime = "claude-code-cli";
    writeFileSync(bindingPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });

    expect(() => removeOpencodeRuntimeBinding(node, home)).toThrow(/does not exactly match/);
    expect(existsSync(bindingPath)).toBe(true);
  });

  test("rejects binding-directory and leaf symlinks", () => {
    const anet = join(home, ".anet");
    const outside = join(root, "outside");
    mkdirSync(anet, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(anet, "opencode-runtime-bindings"));
    expect(() => writeOpencodeRuntimeBinding(node, home)).toThrow(/symlink|canonical real directory/);

    unlinkSync(join(anet, "opencode-runtime-bindings"));
    const bindingPath = writeOpencodeRuntimeBinding(node, home);
    unlinkSync(bindingPath);
    const outsideFile = join(outside, "binding.json");
    writeFileSync(outsideFile, "{}\n", { mode: 0o600 });
    symlinkSync(outsideFile, bindingPath);
    expect(() => readOpencodeRuntimeBinding(node, home)).toThrow(/single-link regular file|symlink/);
    expect(readFileSync(outsideFile, "utf8")).toBe("{}\n");
  });

  test("rejects dangling binding-root and exact-leaf symlinks", () => {
    const anet = join(home, ".anet");
    const bindingRoot = join(anet, "opencode-runtime-bindings");
    mkdirSync(anet, { mode: 0o700 });
    symlinkSync(join(root, "missing-root-target"), bindingRoot);
    expect(() => readOpencodeRuntimeBinding(node, home)).toThrow(/symlink|canonical real directory/);
    expect(() => removeOpencodeRuntimeBinding(node, home)).toThrow(/symlink|canonical real directory/);

    unlinkSync(bindingRoot);
    mkdirSync(bindingRoot, { mode: 0o700 });
    const bindingPath = opencodeRuntimeBindingPath(node, home);
    symlinkSync(join(root, "missing-leaf-target"), bindingPath);
    expect(() => readOpencodeRuntimeBinding(node, home)).toThrow(/single-link regular file|symlink/);
    expect(() => removeOpencodeRuntimeBinding(node, home)).toThrow(/single-link regular file|symlink/);
  });

  test("rejects permissive modes, hard links, and foreign ownership", () => {
    const bindingPath = writeOpencodeRuntimeBinding(node, home);
    const bindingRoot = dirname(bindingPath);
    chmodSync(bindingRoot, 0o755);
    expect(() => readOpencodeRuntimeBinding(node, home)).toThrow(/mode 0700/);
    chmodSync(bindingRoot, 0o700);

    chmodSync(bindingPath, 0o644);
    expect(() => readOpencodeRuntimeBinding(node, home)).toThrow(/0600/);
    chmodSync(bindingPath, 0o600);

    const secondLink = join(bindingRoot, "second-link.json");
    linkSync(bindingPath, secondLink);
    expect(() => readOpencodeRuntimeBinding(node, home)).toThrow(/single-link regular file/);
    unlinkSync(secondLink);

    if (process.getuid?.() === 0) {
      chownSync(bindingPath, 65534, 65534);
      expect(() => readOpencodeRuntimeBinding(node, home)).toThrow(/foreign file owner/);
      chownSync(bindingPath, 0, 0);
    }
  });

  test("rejects private but tampered runtime, identity, and extra fields", () => {
    const bindingPath = writeOpencodeRuntimeBinding(node, home);
    const valid = JSON.parse(readFileSync(bindingPath, "utf8"));
    for (const body of [
      { ...valid, runtime: "claude-code-cli" },
      { ...valid, projectRoot: join(root, "other-project") },
      { ...valid, nodeId: "node-b" },
      { ...valid, attackerField: true },
    ]) {
      writeFileSync(bindingPath, `${JSON.stringify(body)}\n`, { mode: 0o600 });
      expect(() => assertExactOpencodeRuntimeBinding(node, home)).toThrow(/does not exactly match/);
    }
  });

  test("rejects binding roots that overlap the canonical project in either direction", () => {
    expect(() => writeOpencodeRuntimeBinding(node, project)).toThrow(/must not overlap/);
    // Missing exact state must remain invisible to ordinary runtimes even when
    // cwd === HOME. If an exact leaf is present, read/remove detect and reject
    // the overlap before trusting or unlinking it.
    expect(readOpencodeRuntimeBinding(node, project)).toBeUndefined();
    expect(removeOpencodeRuntimeBinding(node, project)).toBe(false);
    const sameRootPath = opencodeRuntimeBindingPath(node, project);
    mkdirSync(dirname(sameRootPath), { mode: 0o700 });
    writeFileSync(sameRootPath, "{}\n", { mode: 0o600 });
    expect(() => readOpencodeRuntimeBinding(node, project)).toThrow(/must not overlap/);
    expect(() => removeOpencodeRuntimeBinding(node, project)).toThrow(/must not overlap/);

    const nestedHome = join(root, "nested-home");
    const bindingRoot = join(nestedHome, ".anet", "opencode-runtime-bindings");
    const nestedProject = join(bindingRoot, "project");
    const nestedNode = join(nestedProject, ".anet", "nodes", "node-b");
    mkdirSync(nestedNode, { recursive: true, mode: 0o700 });
    for (const directory of [
      nestedHome,
      join(nestedHome, ".anet"),
      bindingRoot,
      nestedProject,
      join(nestedProject, ".anet"),
      join(nestedProject, ".anet", "nodes"),
      nestedNode,
    ]) chmodSync(directory, 0o700);

    expect(() => writeOpencodeRuntimeBinding(nestedNode, nestedHome)).toThrow(/must not overlap/);
    expect(readOpencodeRuntimeBinding(nestedNode, nestedHome)).toBeUndefined();
    expect(removeOpencodeRuntimeBinding(nestedNode, nestedHome)).toBe(false);
    const nestedPath = opencodeRuntimeBindingPath(nestedNode, nestedHome);
    writeFileSync(nestedPath, "{}\n", { mode: 0o600 });
    expect(() => readOpencodeRuntimeBinding(nestedNode, nestedHome)).toThrow(/must not overlap/);
    expect(() => removeOpencodeRuntimeBinding(nestedNode, nestedHome)).toThrow(/must not overlap/);
  });

  test("a symlinked node workDir cannot remove another project's binding", () => {
    const victimProject = join(root, "victim-project");
    const victimNode = join(victimProject, ".anet", "nodes", "victim");
    mkdirSync(victimNode, { recursive: true, mode: 0o700 });
    chmodSync(victimProject, 0o700);
    chmodSync(join(victimProject, ".anet"), 0o700);
    chmodSync(join(victimProject, ".anet", "nodes"), 0o700);
    chmodSync(victimNode, 0o700);
    const victimBinding = writeOpencodeRuntimeBinding(victimNode, home);

    const aliasProject = join(root, "alias-project");
    const aliasNodes = join(aliasProject, ".anet", "nodes");
    const aliasNode = join(aliasNodes, "alias");
    mkdirSync(aliasNodes, { recursive: true, mode: 0o700 });
    symlinkSync(victimNode, aliasNode);

    expect(() => readOpencodeRuntimeBinding(aliasNode, home)).toThrow(/symlink/);
    expect(() => writeOpencodeRuntimeBinding(aliasNode, home)).toThrow(/symlink/);
    expect(() => removeOpencodeRuntimeBinding(aliasNode, home)).toThrow(/symlink/);
    expect(existsSync(victimBinding)).toBe(true);
    expect(assertExactOpencodeRuntimeBinding(victimNode, home).nodeId).toBe("victim");

    const intermediateAlias = join(root, "intermediate-alias");
    symlinkSync(victimProject, intermediateAlias);
    const intermediateNode = join(intermediateAlias, ".anet", "nodes", "victim");
    expect(() => readOpencodeRuntimeBinding(intermediateNode, home)).toThrow(/non-canonical/);
    expect(() => writeOpencodeRuntimeBinding(intermediateNode, home)).toThrow(/non-canonical/);
    expect(() => removeOpencodeRuntimeBinding(intermediateNode, home)).toThrow(/non-canonical/);
    expect(existsSync(victimBinding)).toBe(true);
  });
});

describe("assertOpencodeNodeStateUntracked", () => {
  let root: string;
  let project: string;
  let node: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "opencode-git-state-"));
    chmodSync(root, 0o700);
    project = join(root, "project");
    node = join(project, ".anet", "nodes", "node-a");
    mkdirSync(node, { recursive: true, mode: 0o700 });
    writeFileSync(join(node, "config.json"), "{}\n", { mode: 0o600 });
    writeFileSync(join(node, ".env"), "ANET_TOKEN=test\n", { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("allows ordinary non-Git projects", () => {
    expect(() => assertOpencodeNodeStateUntracked(node)).not.toThrow();
  });

  test("allows ignored/untracked state but rejects git add -f tracked state", () => {
    execFileSync("git", ["init", "--quiet", project], { stdio: "pipe", shell: false });
    writeFileSync(join(project, ".gitignore"), ".anet/\n", { mode: 0o600 });
    expect(() => assertOpencodeNodeStateUntracked(node)).not.toThrow();

    execFileSync("git", ["-C", project, "add", "-f", ".anet/nodes/node-a/config.json"], {
      stdio: "pipe",
      shell: false,
    });
    expect(() => assertOpencodeNodeStateUntracked(node)).toThrow(/tracked by Git/);
  });

  test("rejects a force-added dotenv or any tracked file below the node directory", () => {
    execFileSync("git", ["init", "--quiet", project], { stdio: "pipe", shell: false });
    execFileSync("git", ["-C", project, "add", "-f", ".anet/nodes/node-a/.env"], {
      stdio: "pipe",
      shell: false,
    });
    expect(() => assertOpencodeNodeStateUntracked(node)).toThrow(/tracked by Git/);

    execFileSync("git", ["-C", project, "rm", "--cached", ".anet/nodes/node-a/.env"], {
      stdio: "pipe",
      shell: false,
    });
    mkdirSync(join(node, "nested"), { mode: 0o700 });
    writeFileSync(join(node, "nested", "state.json"), "{}\n", { mode: 0o600 });
    execFileSync("git", ["-C", project, "add", "-f", ".anet/nodes/node-a/nested/state.json"], {
      stdio: "pipe",
      shell: false,
    });
    expect(() => assertOpencodeNodeStateUntracked(node)).toThrow(/tracked by Git/);
  });
});
