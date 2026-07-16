import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  discoverOpencodeForbiddenRoots,
  resolveOpencodePackageBinaryFromPath,
  validateOpencodePackageBinary,
} from "./opencode-package-binary";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function safeTestBase(): string {
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new Error("OpenCode package identity tests require Linux uid semantics");
  }
  const userRoot = `/run/user/${process.getuid()}`;
  mkdirSync(userRoot, { recursive: true, mode: 0o700 });
  chmodSync(userRoot, 0o700);
  const base = mkdtempSync(join(userRoot, "anet-opencode-package-test-"));
  cleanup.push(base);
  return base;
}

function makePackage(parent: string, overrides: Record<string, unknown> = {}): {
  root: string;
  binary: string;
  packageJson: string;
} {
  const root = join(parent, "node_modules", "opencode-ai");
  const bin = join(root, "bin");
  const binary = join(bin, "opencode.exe");
  const packageJson = join(root, "package.json");
  mkdirSync(bin, { recursive: true, mode: 0o755 });
  writeFileSync(binary, "#!/bin/sh\nprintf '%s\\n' 1.18.1\n", { mode: 0o755 });
  writeFileSync(packageJson, JSON.stringify({
    name: "opencode-ai",
    version: "1.18.1",
    // The 1.18.1 tarball spells this with `./`; registry metadata may display
    // the normalized form. The verifier accepts only these equivalent bytes.
    bin: { opencode: "./bin/opencode.exe" },
    ...overrides,
  }), { mode: 0o644 });
  return { root, binary, packageJson };
}

describe("validateOpencodePackageBinary", () => {
  test("accepts only the canonical exact npm package entrypoint", () => {
    const base = safeTestBase();
    const fixture = makePackage(base);
    expect(validateOpencodePackageBinary(fixture.binary, {
      expectedVersion: "1.18.1",
    })).toBe(fixture.binary);
  });

  test("rejects a same-version package impersonator inside the project", () => {
    const project = join(safeTestBase(), "project");
    mkdirSync(project, { mode: 0o700 });
    const fixture = makePackage(project);
    expect(() => validateOpencodePackageBinary(fixture.binary, {
      expectedVersion: "1.18.1",
      forbiddenRoots: [project],
    })).toThrow("project/node-local");
  });

  test("skips a same-version project shim and selects a later trusted package", () => {
    const base = safeTestBase();
    const project = join(base, "project");
    const localBin = join(project, "node_modules", ".bin");
    mkdirSync(localBin, { recursive: true, mode: 0o700 });
    const local = makePackage(join(project, "local-payload"));
    symlinkSync(local.binary, join(localBin, "opencode"));

    const global = makePackage(join(base, "global"));
    const globalBin = join(base, "global", "bin");
    mkdirSync(globalBin, { recursive: true, mode: 0o755 });
    symlinkSync(global.binary, join(globalBin, "opencode"));

    expect(resolveOpencodePackageBinaryFromPath(
      `${localBin}:${globalBin}`,
      { expectedVersion: "1.18.1", forbiddenRoots: [project] },
    )).toBe(global.binary);
  });

  test("rejects a monorepo-root package when invoked from a nested app", () => {
    const base = safeTestBase();
    const repo = join(base, "repo");
    const app = join(repo, "packages", "app");
    const localBin = join(repo, "node_modules", ".bin");
    mkdirSync(repo, { recursive: true, mode: 0o700 });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      private: true,
      workspaces: ["packages/*"],
    }), { mode: 0o664 });
    mkdirSync(app, { recursive: true, mode: 0o700 });
    mkdirSync(localBin, { recursive: true, mode: 0o700 });
    const local = makePackage(repo);
    symlinkSync(local.binary, join(localBin, "opencode"));

    const global = makePackage(join(base, "global"));
    const globalBin = join(base, "global", "bin");
    mkdirSync(globalBin, { recursive: true, mode: 0o755 });
    symlinkSync(global.binary, join(globalBin, "opencode"));

    const forbiddenRoots = discoverOpencodeForbiddenRoots(app);
    expect(forbiddenRoots).toContain(repo);
    expect(resolveOpencodePackageBinaryFromPath(
      `${localBin}:${globalBin}`,
      { expectedVersion: "1.18.1", forbiddenRoots },
    )).toBe(global.binary);
  });

  test("ordinary 0664 checkout package.json does not abort boundary discovery", () => {
    const project = join(safeTestBase(), "plain-project");
    mkdirSync(project, { mode: 0o700 });
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "plain-project",
      private: true,
    }), { mode: 0o664 });
    chmodSync(join(project, "package.json"), 0o664);
    expect(discoverOpencodeForbiddenRoots(project)).toEqual([project]);
  });

  test("accepts both exact registry spellings of bin.opencode", () => {
    const dotted = makePackage(safeTestBase());
    expect(validateOpencodePackageBinary(dotted.binary, {
      expectedVersion: "1.18.1",
    })).toBe(dotted.binary);

    const plain = makePackage(safeTestBase(), { bin: { opencode: "bin/opencode.exe" } });
    expect(validateOpencodePackageBinary(plain.binary, {
      expectedVersion: "1.18.1",
    })).toBe(plain.binary);
  });

  test("rejects forged name, version, and bin metadata", () => {
    for (const override of [
      { name: "attacker-opencode" },
      { version: "1.18.0" },
      { bin: { opencode: "bin/other" } },
    ]) {
      const parent = safeTestBase();
      const fixture = makePackage(parent, override);
      expect(() => validateOpencodePackageBinary(fixture.binary, {
        expectedVersion: "1.18.1",
      })).toThrow("package identity");
    }
  });

  test("rejects world-writable files and package ancestors", () => {
    const first = makePackage(safeTestBase());
    chmodSync(first.binary, 0o777);
    expect(() => validateOpencodePackageBinary(first.binary, {
      expectedVersion: "1.18.1",
    })).toThrow("unsafe file ownership or mode");

    const writableBin = makePackage(safeTestBase());
    chmodSync(join(writableBin.root, "bin"), 0o777);
    expect(() => validateOpencodePackageBinary(writableBin.binary, {
      expectedVersion: "1.18.1",
    })).toThrow("unsafe directory ownership or mode");

    const writableParent = join(safeTestBase(), "writable-parent");
    mkdirSync(writableParent, { mode: 0o777 });
    chmodSync(writableParent, 0o777);
    const second = makePackage(writableParent);
    expect(() => validateOpencodePackageBinary(second.binary, {
      expectedVersion: "1.18.1",
    })).toThrow("unsafe directory ownership or mode");
  });

  test("rejects a symlinked package.json even when its contents are exact", () => {
    const fixture = makePackage(safeTestBase());
    const target = `${fixture.packageJson}.target`;
    renameSync(fixture.packageJson, target);
    symlinkSync(target, fixture.packageJson);
    expect(() => validateOpencodePackageBinary(fixture.binary, {
      expectedVersion: "1.18.1",
    })).toThrow("unsafe file ownership or mode");
  });
});
