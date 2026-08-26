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
  PAIRED_AGENT_NODE_SPEC,
  PAIRED_AGENT_NODE_VERSION,
  agentNodeHelpSupportsCodexAppServer,
  agentNodeHelpSupportsOpencode,
  opencodeExactPairInstallCommand,
  pairedAgentNodeResolution,
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

  test("codex bridge ignores stale PATH globals and resolves only the immutable pair", () => {
    const staleGlobal = "@sleep2agi/agent-node@2.5.0-preview.32";
    const resolution = pairedAgentNodeResolution();
    expect(staleGlobal).not.toBe(PAIRED_AGENT_NODE_SPEC);
    // 🔴 不要把版本号抄进断言。
    // 这个常量每次发 agent-node 都会被 sync-pinned-versions.sh 改，
    // 而抄数值的断言会让**改它的那个 PR 自己红** ——
    // sync 脚本只改源码不改测试，于是每次发版都要人记得手补一处。
    // 今晚 test735 就是同一个形状：min_uptime 20_000 抄进断言，
    // #1231 改它之后 main 红了近 6 小时。
    //
    // 真正要守的不变式是**形状**：它必须是一个 preview 版本号，
    // 且与 PAIRED_AGENT_NODE_SPEC 拼出来的一致 —— 两条都不随版本变。
    expect(PAIRED_AGENT_NODE_VERSION).toMatch(/^\d+\.\d+\.\d+-preview\.\d+$/);
    expect(PAIRED_AGENT_NODE_SPEC).toBe(`@sleep2agi/agent-node@${PAIRED_AGENT_NODE_VERSION}`);
    expect(resolution).toEqual({
      spec: PAIRED_AGENT_NODE_SPEC,
      args: ["-y", PAIRED_AGENT_NODE_SPEC, "--print-entrypoint"],
      allowPathGlobal: false,
    });
    expect(resolution.spec).not.toEndWith("@preview");
  });

  test("codex capability is explicit and fails closed when absent", () => {
    expect(agentNodeHelpSupportsCodexAppServer("--runtime codex-sdk | opencode-cli")).toBe(false);
    expect(agentNodeHelpSupportsCodexAppServer("--runtime codex-sdk | codex-app-server")).toBe(true);
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

      // 🔴 版本这条分支此前从未被任何用例执行过。上面两个 throw 用例改的是 name
      // 和 publishConfig.tag —— 而产品代码里五个身份条件**共用同一句错误文案**
      // (`resolved agent-node package is not exact version X`),所以断言那句话
      // 对 name/tag/bin 任何一项失败都成立,唯独不证明版本被比较过。
      // 下面这个用例只改 version,其余字段全部合法,是唯一能让版本比较独自变红的形状。
      writePackage({ version: `${OPENCODE_AGENT_NODE_VERSION}-not-the-paired-one` });
      expect(() => validateAgentNodePackageEntrypoint(
        entrypoint,
        OPENCODE_AGENT_NODE_SPEC,
        OPENCODE_AGENT_NODE_VERSION,
      )).toThrow(`not exact version ${OPENCODE_AGENT_NODE_VERSION}`);

      // 不传 expectedVersion 时判据换成「是不是 preview 通道」,这条同样没被覆盖过。
      writePackage({ version: "2.5.0" });
      expect(() => validateAgentNodePackageEntrypoint(
        entrypoint,
        OPENCODE_AGENT_NODE_SPEC,
      )).toThrow("not a preview-channel candidate");

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
