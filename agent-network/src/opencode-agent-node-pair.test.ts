import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  OPENCODE_AGENT_NETWORK_VERSION,
  OPENCODE_AGENT_NODE_SPEC,
  OPENCODE_AGENT_NODE_VERSION,
  agentNodeHelpSupportsOpencode,
  opencodeExactPairInstallCommand,
  resolveAgentNodePackageEntrypointFromPath,
  validateAgentNodePackageEntrypoint,
} from "./opencode-agent-node-pair";
import { discoverOpencodeForbiddenRoots } from "./opencode-package-binary";

const networkPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const nodePackage = JSON.parse(
  readFileSync(new URL("../../agent-node/package.json", import.meta.url), "utf8"),
);

describe("OpenCode agent-node release pairing", () => {
  test("pins the exact versions being released together", () => {
    expect(OPENCODE_AGENT_NETWORK_VERSION).toBe(networkPackage.version);
    expect(OPENCODE_AGENT_NODE_VERSION).toBe(nodePackage.version);
    expect(OPENCODE_AGENT_NODE_SPEC).toBe(
      `@sleep2agi/agent-node@${nodePackage.version}`,
    );
    expect(opencodeExactPairInstallCommand()).toBe(
      `npm install -g @sleep2agi/agent-network@${networkPackage.version} @sleep2agi/agent-node@${nodePackage.version}`,
    );
  });

  test("rejects latest 2.4.x-style help and accepts the RFC-029 capability", () => {
    const staleHelp = "--runtime claude-agent-sdk | codex-sdk | grok-build-acp";
    const currentHelp = `${staleHelp} | opencode-cli`;

    expect(agentNodeHelpSupportsOpencode(staleHelp)).toBe(false);
    expect(agentNodeHelpSupportsOpencode(currentHelp)).toBe(true);
  });

  test("admits only the exact preview package identity with safe file modes", () => {
    if (process.platform !== "linux" || process.getuid === undefined) {
      throw new Error("agent-node package identity tests require Linux uid semantics");
    }
    const userRoot = `/run/user/${process.getuid()}`;
    mkdirSync(userRoot, { recursive: true, mode: 0o700 });
    chmodSync(userRoot, 0o700);
    const base = mkdtempSync(join(userRoot, "opencode-agent-node-package-"));
    const root = join(base, "node_modules", "@sleep2agi", "agent-node");
    const dist = join(root, "dist");
    const entrypoint = join(dist, "cli.js");
    const packageJson = join(root, "package.json");
    const writePackage = (overrides: Record<string, unknown> = {}) => {
      writeFileSync(packageJson, JSON.stringify({
        name: "@sleep2agi/agent-node",
        version: OPENCODE_AGENT_NODE_VERSION,
        publishConfig: { tag: "preview" },
        bin: { "agent-node": "dist/cli.js" },
        ...overrides,
      }), { mode: 0o644 });
      chmodSync(packageJson, 0o644);
    };

    try {
      mkdirSync(dist, { recursive: true });
      writeFileSync(entrypoint, "#!/usr/bin/env node\n", { mode: 0o755 });
      writePackage();
      expect(validateAgentNodePackageEntrypoint(
        entrypoint,
        OPENCODE_AGENT_NODE_SPEC,
        OPENCODE_AGENT_NODE_VERSION,
      )).toBe(entrypoint);

      writePackage({ name: "attacker/agent-node" });
      expect(() => validateAgentNodePackageEntrypoint(
        entrypoint,
        OPENCODE_AGENT_NODE_SPEC,
        OPENCODE_AGENT_NODE_VERSION,
      )).toThrow("not exact version");

      writePackage({ publishConfig: { tag: "latest" } });
      expect(() => validateAgentNodePackageEntrypoint(
        entrypoint,
        OPENCODE_AGENT_NODE_SPEC,
        OPENCODE_AGENT_NODE_VERSION,
      )).toThrow("not exact version");

      writePackage();
      chmodSync(entrypoint, 0o777);
      expect(() => validateAgentNodePackageEntrypoint(
        entrypoint,
        OPENCODE_AGENT_NODE_SPEC,
        OPENCODE_AGENT_NODE_VERSION,
      )).toThrow("unsafe ownership or mode");

      chmodSync(entrypoint, 0o755);
      chmodSync(dist, 0o777);
      expect(() => validateAgentNodePackageEntrypoint(
        entrypoint,
        OPENCODE_AGENT_NODE_SPEC,
        OPENCODE_AGENT_NODE_VERSION,
      )).toThrow("unsafe ownership or mode");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("skips an exact project-local impersonator and selects the later global package", () => {
    if (process.platform !== "linux" || process.getuid === undefined) {
      throw new Error("agent-node package identity tests require Linux uid semantics");
    }
    const userRoot = `/run/user/${process.getuid()}`;
    mkdirSync(userRoot, { recursive: true, mode: 0o700 });
    chmodSync(userRoot, 0o700);
    const base = mkdtempSync(join(userRoot, "opencode-agent-node-path-"));
    const makePackage = (parent: string) => {
      const root = join(parent, "node_modules", "@sleep2agi", "agent-node");
      const dist = join(root, "dist");
      mkdirSync(dist, { recursive: true, mode: 0o755 });
      const entrypoint = join(dist, "cli.js");
      writeFileSync(entrypoint, "#!/usr/bin/env node\n", { mode: 0o755 });
      writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "@sleep2agi/agent-node",
        version: OPENCODE_AGENT_NODE_VERSION,
        publishConfig: { tag: "preview" },
        bin: { "agent-node": "dist/cli.js" },
      }), { mode: 0o644 });
      return entrypoint;
    };
    try {
      const project = join(base, "repo");
      const nestedApp = join(project, "packages", "app");
      const localBin = join(project, "node_modules", ".bin");
      mkdirSync(project, { recursive: true, mode: 0o700 });
      writeFileSync(join(project, "package.json"), JSON.stringify({
        private: true,
        workspaces: { packages: ["packages/*"] },
      }), { mode: 0o664 });
      chmodSync(join(project, "package.json"), 0o664);
      mkdirSync(nestedApp, { recursive: true, mode: 0o700 });
      mkdirSync(localBin, { recursive: true, mode: 0o700 });
      const localEntrypoint = makePackage(project);
      symlinkSync(localEntrypoint, join(localBin, "agent-node"));

      const globalRoot = join(base, "global");
      const globalEntrypoint = makePackage(globalRoot);
      const globalBin = join(globalRoot, "bin");
      mkdirSync(globalBin, { recursive: true, mode: 0o755 });
      symlinkSync(globalEntrypoint, join(globalBin, "agent-node"));

      const forbiddenRoots = discoverOpencodeForbiddenRoots(nestedApp);
      expect(forbiddenRoots).toContain(project);
      expect(resolveAgentNodePackageEntrypointFromPath(
        `${localBin}:${globalBin}`,
        OPENCODE_AGENT_NODE_SPEC,
        OPENCODE_AGENT_NODE_VERSION,
        forbiddenRoots,
      )).toBe(globalEntrypoint);
      expect(() => validateAgentNodePackageEntrypoint(
        localEntrypoint,
        OPENCODE_AGENT_NODE_SPEC,
        OPENCODE_AGENT_NODE_VERSION,
        forbiddenRoots,
      )).toThrow("project/node-local");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
