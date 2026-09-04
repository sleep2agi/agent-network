import { describe, expect, test } from "bun:test";
import { join, sep } from "node:path";
import { binEntryFromPackageJson, nearestNodeModules, siblingAgentNodeEntrypoint, type SiblingFs } from "./sibling-agent-node";

function fakeFs(files: Record<string, unknown>): SiblingFs {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readJson: (p) => { const v = files[p]; if (v === undefined) throw new Error("ENOENT"); return v; },
  };
}
const ROOT = sep === "/" ? "/opt/x" : "C:\\opt\\x";
const NM = join(ROOT, "node_modules");
const CLI = join(NM, "@sleep2agi", "agent-network", "dist", "bin", "cli.js");
const AN_PKG = join(NM, "@sleep2agi", "agent-node", "package.json");
const AN_BIN = join(NM, "@sleep2agi", "agent-node", "dist", "cli.js");

describe("#1808 sibling agent-node", () => {
  test("nearest node_modules from the anet entry file", () => {
    expect(nearestNodeModules(CLI)).toBe(NM);
    expect(nearestNodeModules(join(ROOT, "bin", "anet"))).toBeNull();
    expect(nearestNodeModules("relative/cli.js")).toBeNull();
    expect(nearestNodeModules("")).toBeNull();
  });

  test("bin field: object with agent-node key, plain string, or nothing", () => {
    expect(binEntryFromPackageJson({ bin: { "agent-node": "dist/cli.js" } })).toBe("dist/cli.js");
    expect(binEntryFromPackageJson({ bin: "dist/cli.js" })).toBe("dist/cli.js");
    expect(binEntryFromPackageJson({ bin: { other: "x.js" } })).toBeNull();
    expect(binEntryFromPackageJson({})).toBeNull();
    expect(binEntryFromPackageJson(null)).toBeNull();
  });

  test("isolated prefix / global install: agent-node beside agent-network is found with its version", () => {
    const fs = fakeFs({ [AN_PKG]: { version: "2.5.0-preview.65", bin: { "agent-node": "dist/cli.js" } }, [AN_BIN]: "" });
    const hit = siblingAgentNodeEntrypoint(CLI, fs);
    expect(hit).not.toBeNull();
    expect(hit!.entrypoint).toBe(AN_BIN);
    expect(hit!.version).toBe("2.5.0-preview.65");
  });

  test("no agent-node beside anet → null (fall through to PATH / npx)", () => {
    expect(siblingAgentNodeEntrypoint(CLI, fakeFs({}))).toBeNull();
  });

  test("package.json present but bin file missing (half-installed) → null", () => {
    const fs = fakeFs({ [AN_PKG]: { version: "1", bin: { "agent-node": "dist/cli.js" } } });
    expect(siblingAgentNodeEntrypoint(CLI, fs)).toBeNull();
  });

  test("nested node_modules (pnpm-like): the nearest one wins, not the outer", () => {
    const innerNM = join(NM, ".pnpm", "x", "node_modules");
    const innerCli = join(innerNM, "@sleep2agi", "agent-network", "dist", "bin", "cli.js");
    const innerPkg = join(innerNM, "@sleep2agi", "agent-node", "package.json");
    const innerBin = join(innerNM, "@sleep2agi", "agent-node", "dist", "cli.js");
    const fs = fakeFs({ [AN_PKG]: { version: "old", bin: "dist/cli.js" }, [AN_BIN]: "", [innerPkg]: { version: "inner", bin: "dist/cli.js" }, [innerBin]: "" });
    expect(siblingAgentNodeEntrypoint(innerCli, fs)!.version).toBe("inner");
  });

  test("unreadable package.json → null, never throws", () => {
    const fs: SiblingFs = { exists: () => true, readJson: () => { throw new Error("EACCES"); } };
    expect(siblingAgentNodeEntrypoint(CLI, fs)).toBeNull();
  });
});
