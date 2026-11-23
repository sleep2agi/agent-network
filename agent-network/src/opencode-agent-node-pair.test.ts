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
  agentNodeVersionAccepted,
  agentNodeVersionRejectionMessage,
  comparePreviewVersions,
  newerAgentNodeVersionHint,
  opencodeExactPairInstallCommand,
  pairInfo,
  parsePreviewVersion,
  PAIRED_AGENT_NETWORK_VERSION,
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

/**
 * 把 preview 版本号的最后一段 +1 / -1。
 * 不抄具体版本号：sync-pinned-versions.sh 每次发版都会改常量，
 * 抄数字的断言会让「改它的那个 PR 自己红」（仓库里已有两条血泪注释）。
 */
function bumpPreviewNumber(version: string, delta = 1): string {
  const m = /^(\d+)\.(\d+)\.(\d+)-preview\.(\d+)$/.exec(version);
  if (!m) throw new Error(`not a preview version: ${version}`);
  return `${m[1]}.${m[2]}.${m[3]}-preview.${Math.max(0, Number(m[4]) + delta)}`;
}

/** 取出函数抛出的错误文案；没抛就返回空串。 */
function messageOf(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error: any) {
    return String(error?.message ?? error);
  }
}

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

      // 生产事故形状（2026-11-23，macmini）：只把 agent-node 升到**更新**的
      // preview、CLI 还停在旧的配对版本 → `anet node start` 拒启，只抛一句
      // "No exact trusted global @sleep2agi/agent-node@<旧> is available"，
      // 看不出「你装的其实更新、该装哪个 CLI」。闸门不变（仍然拒），
      // 但错误文案必须把「装的是更新的」和「该装哪个」说清楚。
      const newerVersion = bumpPreviewNumber(OPENCODE_AGENT_NODE_VERSION);
      writePackage({ version: newerVersion });
      expect(() => validateAgentNodePackageEntrypoint(
        entrypoint,
        OPENCODE_AGENT_NODE_SPEC,
        OPENCODE_AGENT_NODE_VERSION,
      )).toThrow(`not exact version ${OPENCODE_AGENT_NODE_VERSION}`);
      expect(() => validateAgentNodePackageEntrypoint(
        entrypoint,
        OPENCODE_AGENT_NODE_SPEC,
        OPENCODE_AGENT_NODE_VERSION,
      )).toThrow(newerVersion);
      expect(() => validateAgentNodePackageEntrypoint(
        entrypoint,
        OPENCODE_AGENT_NODE_SPEC,
        OPENCODE_AGENT_NODE_VERSION,
      )).toThrow("newer than the pinned");
      // 旧版本**不给**这条提示（那是另一回事：装的是旧的，只该说版本不对）。
      writePackage({ version: bumpPreviewNumber(OPENCODE_AGENT_NODE_VERSION, -1) });
      expect(messageOf(() => validateAgentNodePackageEntrypoint(
        entrypoint,
        OPENCODE_AGENT_NODE_SPEC,
        OPENCODE_AGENT_NODE_VERSION,
      ))).not.toContain("newer than the pinned");

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


// `anet pair` 印出来的必须是**这对常量本身**，且必须点明「tag 不是配对判据」——
// 这条测试存在的理由：客户端/文档的单边 @preview 提示已经真实造成过半对节点。
describe("pairInfo (anet pair)", () => {
  test("prints the exact pair constants and the exact install command", () => {
    const text = pairInfo();
    expect(text).toContain(`@sleep2agi/agent-network@${PAIRED_AGENT_NETWORK_VERSION}`);
    expect(text).toContain(PAIRED_AGENT_NODE_SPEC);
    expect(text).toContain(opencodeExactPairInstallCommand());
  });
  test("tells opencode-cli operators that npx is disabled and tags are not the pair judgement", () => {
    const text = pairInfo();
    expect(text).toContain("自动 npx 已被禁用");
    expect(text).toContain("tag 不是配对判据");
    // 非 opencode 场景不塞这一段：说多说少都要有理由
    expect(pairInfo(false)).not.toContain("自动 npx 已被禁用");
  });
});

// 2026-11-22（负责人）：`anet pair` 要有一行说人话的 Node 版本提示，不阻断。
import { nodeEngineWarning, REQUIRED_NODE_VERSION } from "./opencode-agent-node-pair";
test("nodeEngineWarning: 低于 engines 才提示，且说清「当前/建议/后果」", () => {
  expect(REQUIRED_NODE_VERSION).toBe("22.13.0");
  expect(nodeEngineWarning("22.13.0")).toBeNull();
  expect(nodeEngineWarning("23.0.0")).toBeNull();
  const warn = nodeEngineWarning("20.20.0");
  expect(warn).not.toBeNull();
  expect(warn!).toContain("v20.20.0");
  expect(warn!).toContain("22.13.0");
  expect(warn!).toContain("不阻断");
  expect(nodeEngineWarning("22.12.9")).not.toBeNull();
});

// 2026-11-23：只升 agent-node、CLI 还停在旧配对版本时的版本比较与提示。
// 生产事故形状（macmini）：`npm i -g @sleep2agi/agent-node@2.5.0-preview.221`
// 之后 `anet node start` 直接拒启，只抛一句
// 「No exact trusted global @sleep2agi/agent-node@2.5.0-preview.211 is available」——
// 看不出「你装的其实更新」，更看不出该装哪个 CLI。
// 这组用例锁两件事：**闸门不变**（更新的版本仍然被拒），但**文案要说清楚**。
describe("preview version comparison and the newer-agent-node hint", () => {
  test("parses only the strict preview version shape", () => {
    expect(parsePreviewVersion("2.5.0-preview.221")).toEqual({
      major: 2,
      minor: 5,
      patch: 0,
      preview: 221,
    });
    expect(parsePreviewVersion("2.5.0")).toBeNull();
    expect(parsePreviewVersion("2.5.0-preview.221-not-the-paired-one")).toBeNull();
    expect(parsePreviewVersion("")).toBeNull();
  });

  test("orders by major, minor, patch, then preview", () => {
    const v = (s: string) => parsePreviewVersion(s)!;
    expect(comparePreviewVersions(v("2.6.0-preview.1"), v("2.5.0-preview.999"))).toBe(1);
    expect(comparePreviewVersions(v("2.5.1-preview.1"), v("2.5.0-preview.999"))).toBe(1);
    expect(comparePreviewVersions(v("2.5.0-preview.222"), v("2.5.0-preview.221"))).toBe(1);
    expect(comparePreviewVersions(v("2.5.0-preview.221"), v("2.5.0-preview.221"))).toBe(0);
    expect(comparePreviewVersions(v("2.5.0-preview.220"), v("2.5.0-preview.221"))).toBe(-1);
  });

  test("hints only when the installed agent-node is newer than the pinned one", () => {
    const pinned = OPENCODE_AGENT_NODE_VERSION;
    const newer = bumpPreviewNumber(pinned, 1);
    const older = bumpPreviewNumber(pinned, -1);

    const hint = newerAgentNodeVersionHint(newer, pinned);
    expect(hint).toContain(newer);
    expect(hint).toContain(pinned);
    expect(hint).toContain("newer than the pinned");

    // 同版本、旧版本、格式不认识 —— 一律不给这条提示。
    expect(newerAgentNodeVersionHint(pinned, pinned)).toBeNull();
    expect(newerAgentNodeVersionHint(older, pinned)).toBeNull();
    expect(newerAgentNodeVersionHint(`${pinned}-not-the-paired-one`, pinned)).toBeNull();
  });

  test("version acceptance stays exact: newer is still refused", () => {
    const pinned = OPENCODE_AGENT_NODE_VERSION;
    expect(agentNodeVersionAccepted(pinned, pinned)).toBe(true);
    expect(agentNodeVersionAccepted(bumpPreviewNumber(pinned, 1), pinned)).toBe(false);
    expect(agentNodeVersionAccepted(bumpPreviewNumber(pinned, -1), pinned)).toBe(false);
    expect(agentNodeVersionAccepted(`${pinned}-not-the-paired-one`, pinned)).toBe(false);
    expect(agentNodeVersionAccepted(undefined, pinned)).toBe(false);
    // 不传 expectedVersion 时只看 preview 通道
    expect(agentNodeVersionAccepted("2.5.0-preview.221")).toBe(true);
    expect(agentNodeVersionAccepted("2.5.0")).toBe(false);
    expect(agentNodeVersionAccepted(undefined)).toBe(false);
  });

  test("rejection message names the installed newer version and stays compatible", () => {
    const pinned = OPENCODE_AGENT_NODE_VERSION;
    const newer = bumpPreviewNumber(pinned, 1);
    const message = agentNodeVersionRejectionMessage(newer, pinned);
    expect(message).toContain(`not exact version ${pinned}`);
    expect(message).toContain(newer);
    expect(message).toContain("newer than the pinned");

    // 旧文案不许变（外部脚本/文档在匹配它）
    expect(agentNodeVersionRejectionMessage(`${pinned}-not-the-paired-one`, pinned))
      .toBe(`resolved agent-node package is not exact version ${pinned}`);
    expect(agentNodeVersionRejectionMessage("2.5.0"))
      .toBe("resolved agent-node package is not a preview-channel candidate");
  });
});
