import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  discoverOpencodeForbiddenRoots,
  opencodeOwnedPathModeIsSafe,
  resolvePinnedOpencodeBinary,
} from "./binary";

function makeTrustedRoot(label: string): string {
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new Error("OpenCode package identity tests require Linux uid semantics");
  }
  const userRuntime = `/run/user/${process.getuid()}`;
  mkdirSync(userRuntime, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(userRuntime, `.anet-${label}-`));
}

interface PackageStubOptions {
  name?: string;
  manifestVersion?: string;
  declaredBin?: string;
  reportedVersion?: string;
  executableName?: string;
  executableMode?: number;
  packageJsonMode?: number;
  binDirMode?: number;
  packageDirMode?: number;
  probeMarker?: string;
  npmLayout?: boolean;
}

function packageStub(base: string, label: string, opts: PackageStubOptions = {}) {
  const fixtureRoot = join(base, label);
  const nodeModules = join(fixtureRoot, "node_modules");
  const packageRoot = opts.npmLayout === false
    ? join(fixtureRoot, "opencode-ai")
    : join(nodeModules, "opencode-ai");
  const binDir = join(packageRoot, "bin");
  const executableName = opts.executableName ?? "opencode.exe";
  const binary = join(binDir, executableName);
  const packageJson = join(packageRoot, "package.json");
  const manifestVersion = opts.manifestVersion ?? "1.18.1";
  mkdirSync(fixtureRoot, { mode: 0o700 });
  if (opts.npmLayout !== false) mkdirSync(nodeModules, { mode: 0o700 });
  mkdirSync(packageRoot, { mode: opts.packageDirMode ?? 0o700 });
  mkdirSync(binDir, { mode: opts.binDirMode ?? 0o700 });
  writeFileSync(packageJson, JSON.stringify({
    name: opts.name ?? "opencode-ai",
    version: manifestVersion,
    bin: { opencode: opts.declaredBin ?? "./bin/opencode.exe" },
  }), { mode: opts.packageJsonMode ?? 0o600 });
  writeFileSync(binary, `#!/usr/bin/env bun
import { writeFileSync } from "fs";
if (process.argv[2] === "--version") {
  ${opts.probeMarker ? `writeFileSync(${JSON.stringify(opts.probeMarker)}, process.cwd());` : ""}
  console.log(${JSON.stringify(opts.reportedVersion ?? manifestVersion)});
  process.exit(0);
}
process.stdin.resume();
`, { mode: opts.executableMode ?? 0o700 });
  // Test exact modes independently of the container's umask.
  chmodSync(packageRoot, opts.packageDirMode ?? 0o700);
  chmodSync(fixtureRoot, 0o700);
  if (opts.npmLayout !== false) chmodSync(nodeModules, 0o700);
  chmodSync(binDir, opts.binDirMode ?? 0o700);
  chmodSync(packageJson, opts.packageJsonMode ?? 0o600);
  chmodSync(binary, opts.executableMode ?? 0o700);
  return { packageRoot, binDir, binary, packageJson };
}

function pathShim(base: string, binary: string): string {
  const shimDir = join(base, "shim");
  mkdirSync(shimDir, { mode: 0o700 });
  symlinkSync(binary, join(shimDir, "opencode"));
  return shimDir;
}

describe("resolvePinnedOpencodeBinary", () => {
  test("locks the non-root uid=gid umask-0002 compatibility policy", () => {
    expect(opencodeOwnedPathModeIsSafe(
      { uid: 1000, gid: 1000, mode: 0o775 }, 1000, 1000,
    )).toBe(true);
    expect(opencodeOwnedPathModeIsSafe(
      { uid: 1000, gid: 1000, mode: 0o664 }, 1000, 1000,
    )).toBe(true);
    expect(opencodeOwnedPathModeIsSafe(
      { uid: 1000, gid: 1001, mode: 0o775 }, 1000, 1000,
    )).toBe(false);
    expect(opencodeOwnedPathModeIsSafe(
      { uid: 1000, gid: 1000, mode: 0o777 }, 1000, 1000,
    )).toBe(false);
    expect(opencodeOwnedPathModeIsSafe(
      { uid: 0, gid: 0, mode: 0o770 }, 0, 0,
    )).toBe(false);
  });

  test("accepts the canonical package entrypoint and probes it from the external cwd", () => {
    const root = makeTrustedRoot("opencode-bin-exact");
    const probeCwd = join(root, "probe-cwd");
    const marker = join(root, "probe-cwd.txt");
    try {
      mkdirSync(probeCwd, { mode: 0o700 });
      const fixture = packageStub(root, "opencode-ai", { probeMarker: marker });
      expect(resolvePinnedOpencodeBinary({
        requestedBinary: fixture.binary,
        expectedVersion: "1.18.1",
        probeEnv: process.env,
        probeCwd,
      })).toBe(fixture.binary);
      expect(readFileSync(marker, "utf8")).toBe(probeCwd);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts an npm-style PATH shim but returns the canonical package binary", () => {
    const root = makeTrustedRoot("opencode-bin-shim");
    try {
      const fixture = packageStub(root, "opencode-ai");
      const shimDir = pathShim(root, fixture.binary);
      expect(resolvePinnedOpencodeBinary({
        searchPath: shimDir,
        expectedVersion: "1.18.1",
        probeEnv: process.env,
      })).toBe(fixture.binary);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a same-version fake package inside the project before executing it", () => {
    const root = makeTrustedRoot("opencode-bin-project");
    const project = join(root, "project");
    const marker = join(root, "probe-executed");
    try {
      mkdirSync(project, { mode: 0o700 });
      const fixture = packageStub(project, "node_modules-opencode-ai", { probeMarker: marker });
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: fixture.binary,
        expectedVersion: "1.18.1",
        probeEnv: process.env,
        forbiddenRoots: [project],
      })).toThrow("overlaps forbidden root");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects forged package metadata and noncanonical entrypoints", () => {
    const root = makeTrustedRoot("opencode-bin-metadata");
    try {
      const wrongName = packageStub(root, "wrong-name", { name: "forged-opencode-ai" });
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: wrongName.binary,
        expectedVersion: "1.18.1",
        probeEnv: process.env,
      })).toThrow("not opencode-ai@1.18.1");

      const wrongVersion = packageStub(root, "wrong-version", { manifestVersion: "1.17.13" });
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: wrongVersion.binary,
        expectedVersion: "1.18.1",
        probeEnv: process.env,
      })).toThrow("not opencode-ai@1.18.1");

      const wrongBin = packageStub(root, "wrong-bin", { declaredBin: "bin/other.exe" });
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: wrongBin.binary,
        expectedVersion: "1.18.1",
        probeEnv: process.env,
      })).toThrow("bin.opencode=bin/opencode.exe");

      const wrongEntrypoint = packageStub(root, "wrong-entrypoint", {
        executableName: "opencode",
        declaredBin: "bin/opencode",
      });
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: wrongEntrypoint.binary,
        expectedVersion: "1.18.1",
        probeEnv: process.env,
      })).toThrow("canonical opencode-ai bin/opencode.exe");

      const outsideNpmLayout = packageStub(root, "outside-node-modules", {
        npmLayout: false,
      });
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: outsideNpmLayout.binary,
        expectedVersion: "1.18.1",
        probeEnv: process.env,
      })).toThrow("node_modules/opencode-ai");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects unsafe file, package-directory, ancestor, and owner modes", () => {
    const root = makeTrustedRoot("opencode-bin-mode");
    try {
      const writableBinary = packageStub(root, "writable-binary", { executableMode: 0o777 });
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: writableBinary.binary,
        probeEnv: process.env,
      })).toThrow("unsafe ownership or mode");

      const writableManifest = packageStub(root, "writable-manifest", { packageJsonMode: 0o666 });
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: writableManifest.binary,
        probeEnv: process.env,
      })).toThrow("unsafe ownership or mode");

      const writableBinDir = packageStub(root, "writable-bin-dir", { binDirMode: 0o777 });
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: writableBinDir.binary,
        probeEnv: process.env,
      })).toThrow("unsafe ownership or mode");

      const writablePackage = packageStub(root, "writable-package", { packageDirMode: 0o777 });
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: writablePackage.binary,
        probeEnv: process.env,
      })).toThrow("unsafe ownership or mode");

      const writableAncestor = join(root, "writable-ancestor");
      mkdirSync(writableAncestor, { mode: 0o777 });
      chmodSync(writableAncestor, 0o777);
      const belowWritableAncestor = packageStub(writableAncestor, "opencode-ai");
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: belowWritableAncestor.binary,
        probeEnv: process.env,
      })).toThrow("unsafe ownership or mode");

      if (process.getuid?.() === 0) {
        const foreignOwned = packageStub(root, "foreign-owned");
        chownSync(foreignOwned.packageJson, 65534, 65534);
        expect(() => resolvePinnedOpencodeBinary({
          requestedBinary: foreignOwned.binary,
          probeEnv: process.env,
        })).toThrow("unsafe ownership or mode");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still enforces exact --version output after package identity succeeds", () => {
    const root = makeTrustedRoot("opencode-bin-version");
    try {
      const fixture = packageStub(root, "opencode-ai", { reportedVersion: "1.17.13" });
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: fixture.binary,
        expectedVersion: "1.18.1",
        probeEnv: process.env,
      })).toThrow("expected opencode-ai@1.18.1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a caller-selected version other than the vetted release pin", () => {
    const root = makeTrustedRoot("opencode-bin-unvetted-version");
    try {
      const fixture = packageStub(root, "opencode-1.18.2", {
        manifestVersion: "1.18.2",
        reportedVersion: "1.18.2",
      });
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: fixture.binary,
        expectedVersion: "1.18.2",
        probeEnv: process.env,
      })).toThrow("vetted only for opencode-ai@1.18.1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a same-version package in a monorepo ancestor before probing it", () => {
    const root = makeTrustedRoot("opencode-bin-monorepo");
    const marker = join(root, "ancestor-probe-executed");
    try {
      const fixture = packageStub(root, "monorepo", { probeMarker: marker });
      const repo = join(root, "monorepo");
      const app = join(repo, "packages", "app");
      mkdirSync(join(repo, ".git"), { mode: 0o700 });
      mkdirSync(app, { recursive: true, mode: 0o700 });
      expect(() => resolvePinnedOpencodeBinary({
        requestedBinary: fixture.binary,
        expectedVersion: "1.18.1",
        probeEnv: process.env,
        forbiddenRoots: discoverOpencodeForbiddenRoots(app),
      })).toThrow("overlaps forbidden root");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discovers a workspace ancestor when the configured project leaf is absent", () => {
    const root = makeTrustedRoot("opencode-bin-absent-project");
    const repo = join(root, "repo");
    const absentApp = join(repo, "packages", "not-created-yet");
    try {
      mkdirSync(join(repo, ".git"), { recursive: true, mode: 0o700 });
      const roots = discoverOpencodeForbiddenRoots(absentApp);
      expect(roots).toContain(absentApp);
      expect(roots).toContain(repo);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("launcher absolute path wins over a hostile search PATH", () => {
    const root = makeTrustedRoot("opencode-bin-path");
    try {
      const trusted = packageStub(root, "trusted-opencode-ai");
      const hostile = packageStub(root, "stale-opencode-ai", {
        manifestVersion: "1.17.13",
      });
      const hostilePath = pathShim(root, hostile.binary);
      expect(resolvePinnedOpencodeBinary({
        requestedBinary: trusted.binary,
        searchPath: hostilePath,
        expectedVersion: "1.18.1",
        probeEnv: process.env,
      })).toBe(trusted.binary);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects non-absolute overrides", () => {
    expect(() => resolvePinnedOpencodeBinary({
      requestedBinary: "opencode",
      probeEnv: process.env,
    })).toThrow("absolute path");
  });
});
