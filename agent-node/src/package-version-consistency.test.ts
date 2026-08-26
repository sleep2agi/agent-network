import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type PackageManifest = { version: string };
type PackageLock = {
  version: string;
  packages: { "": { version: string } };
};

const readJson = <T>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", name), "utf8")) as T;

describe("agent-node package version consistency", () => {
  const manifest = readJson<PackageManifest>("package.json");
  const lock = readJson<PackageLock>("package-lock.json");

  test("package-lock top-level version matches package.json", () => {
    expect(lock.version).toBe(manifest.version);
  });

  test("package-lock root package version matches package.json", () => {
    expect(lock.packages[""].version).toBe(manifest.version);
  });
});
