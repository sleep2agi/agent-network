// RFC-029 release pairing. agent-network must never hand `opencode-cli` to
// an older agent-node that treats an unknown runtime as its legacy default.
// Keep this exact pair in lockstep with the two preview package versions; the
// unit test intentionally fails when either package is bumped independently.

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "fs";
import type { Stats } from "fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "path";
import { opencodeOwnedPathModeIsSafe } from "./opencode-owner-mode";
import { describeUnsafeDirectory, describeUnsafePath } from "./unsafe-package-path-reason";

export const PAIRED_AGENT_NETWORK_VERSION = "2.3.0-preview.256";
export const PAIRED_AGENT_NODE_VERSION = "2.5.0-preview.222";
export const PAIRED_AGENT_NODE_SPEC = `@sleep2agi/agent-node@${PAIRED_AGENT_NODE_VERSION}`;
// Backward-compatible names for the first consumer of the shared pair.
export const OPENCODE_AGENT_NETWORK_VERSION = PAIRED_AGENT_NETWORK_VERSION;
export const OPENCODE_AGENT_NODE_VERSION = PAIRED_AGENT_NODE_VERSION;
export const OPENCODE_AGENT_NODE_SPEC = PAIRED_AGENT_NODE_SPEC;

export type PairedAgentNodeResolution = {
  spec: string;
  args: string[];
  allowPathGlobal: false;
};

/** The codex bridge must resolve the immutable release pair, independent of PATH. */
export function pairedAgentNodeResolution(): PairedAgentNodeResolution {
  return {
    spec: PAIRED_AGENT_NODE_SPEC,
    args: ["-y", PAIRED_AGENT_NODE_SPEC, "--print-entrypoint"],
    allowPathGlobal: false,
  };
}

/** Cold npm downloads get their own budget, separate from bridge attachment. */
export function pairedAgentNodeResolveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ANET_AGENT_NODE_RESOLVE_TIMEOUT_MS;
  if (!raw?.trim()) return 300_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error("ANET_AGENT_NODE_RESOLVE_TIMEOUT_MS must be an integer from 1 to 2147483647 (milliseconds)");
  }
  return value;
}

export function pairedAgentNodeResolveError(error: any, timeoutMs: number): string {
  const detail = error?.stderr || error?.message || String(error);
  if (error?.code !== "ETIMEDOUT") return `could not resolve exact paired package: ${detail}`;
  return `could not resolve exact paired package: npx timed out after ${timeoutMs}ms` +
    `\nIncrease ANET_AGENT_NODE_RESOLVE_TIMEOUT_MS for a slow network.` +
    `\nPre-fetch the exact package, then retry node start:\n  npx -y ${PAIRED_AGENT_NODE_SPEC} --print-entrypoint`;
}

export function agentNodeHelpSupportsCodexAppServer(help: string): boolean {
  return help.includes("codex-app-server");
}

export function opencodeExactPairInstallCommand(): string {
  return `npm install -g @sleep2agi/agent-network@${OPENCODE_AGENT_NETWORK_VERSION} ${OPENCODE_AGENT_NODE_SPEC}`;
}

/** Runtime capability advertised by agent-node's operator-facing help. */
export function agentNodeHelpSupportsOpencode(help: string): boolean {
  return help.includes("opencode-cli");
}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertSafePackagePath(path: string, kind: "file" | "directory", ancestorOf?: string): Stats {
  const stat = lstatSync(path) as Stats;
  if (
    (kind === "file" ? !stat.isFile() : !stat.isDirectory())
    || stat.isSymbolicLink()
    // Windows exposes synthetic POSIX uid/mode values; package identity,
    // canonical paths, and the project-root exclusion remain enforceable,
    // while ACL review is left to the OS/npm install boundary.
    || (process.platform !== "win32" && !opencodeOwnedPathModeIsSafe(stat))
  ) {
    // Same reasoning as the grok resolver: on a stock Debian/Ubuntu box the
    // condition that fires is the group-write bit npm inherits from umask
    // 0002, and a message that leads with "ownership" sends the reader to the
    // wrong place. Shape/symlink failures keep their own wording.
    if (kind === "file" && stat.isFile() && !stat.isSymbolicLink() && process.platform !== "win32") {
      throw new Error(
        `resolved agent-node package has unsafe ownership or mode — ` +
        describeUnsafePath(path, { uid: stat.uid, mode: stat.mode, processUid: process.getuid?.() ?? stat.uid }),
      );
    }
    // #535 — this branch used to name nothing; the audit's offender was an ANCESTOR (/tmp, 1777).
    if (kind === "directory" && stat.isDirectory() && !stat.isSymbolicLink() && process.platform !== "win32") {
      throw new Error(
        `resolved agent-node package has unsafe ownership or mode — ` +
        describeUnsafeDirectory(path, { uid: stat.uid, mode: stat.mode, processUid: process.getuid?.() ?? stat.uid, ancestorOf }),
      );
    }
    throw new Error(`resolved agent-node package has unsafe ownership or mode — ${path} is not a plain ${kind} (symlink or wrong type)`);
  }
  return stat;
}

function readPackageJsonNoFollow(path: string): any {
  const before = assertSafePackagePath(path, "file");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd) as Stats;
    const current = lstatSync(path) as Stats;
    if (!sameIdentity(before, opened) || !sameIdentity(opened, current)
      || opened.size <= 0 || opened.size > 1024 * 1024) {
      throw new Error("resolved agent-node package.json identity is unsafe");
    }
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertSafeAncestors(packageRoot: string): void {
  let current = packageRoot;
  while (true) {
    assertSafePackagePath(current, "directory", current === packageRoot ? undefined : packageRoot);
    if (realpathSync(current) !== current) {
      throw new Error(`resolved agent-node package has a symlinked ancestor: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/**
 * 预览版本号比较：`2.5.0-preview.221` 这类字符串。
 *
 * 只认严格格式；别的形态（`-not-the-paired-one`、缺 `-preview.N` 段）一律判为
 * **不可比**（调用方按「不匹配」处理，绝不因为解析失败而放行）。
 */
export function parsePreviewVersion(value: string): { major: number; minor: number; patch: number; preview: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)-preview\.(\d+)$/.exec(String(value ?? "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), preview: Number(m[4]) };
}

/** a - b；不可比的版本返回 0（调用方必须先确认两者都可解析）。 */
export function comparePreviewVersions(
  a: { major: number; minor: number; patch: number; preview: number },
  b: { major: number; minor: number; patch: number; preview: number },
): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  if (a.preview !== b.preview) return a.preview > b.preview ? 1 : -1;
  return 0;
}

/**
 * 装了**更新的** agent-node、但 CLI 钉的是旧版本时的提示。
 *
 * 生产事故（2026-11-23，macmini）：只把 agent-node 从 2.5.0-preview.211 换成
 * 2.5.0-preview.221，CLI 还停在 2.3.0-preview.248（它的配对版本就是 .211），
 * 于是 `anet node start` 直接拒启，只抛一句
 * `No exact trusted global @sleep2agi/agent-node@2.5.0-preview.211 is available`
 * —— 看不出「你装的其实更新」，更看不出该装哪个 CLI。
 *
 * 这里不改变闸门本身（精确配对仍然是硬要求），只把这句话说清楚。
 */
export function newerAgentNodeVersionHint(candidate: string, expected: string): string | null {
  const c = parsePreviewVersion(candidate);
  const e = parsePreviewVersion(expected);
  if (!c || !e) return null;
  if (comparePreviewVersions(c, e) <= 0) return null;
  return `installed @sleep2agi/agent-node@${candidate} is newer than the pinned ${expected}; `
    + `this CLI trusts only the exact pinned version — either install @sleep2agi/agent-node@${expected} `
    + `or upgrade agent-network to the release paired with ${candidate}`;
}

/**
 * 版本判据：精确配对（传了 expectedVersion）或 preview 通道（没传）。
 * 抽成纯函数是为了能脱离「Linux uid 语义」那套文件身份检查单独测。
 */
export function agentNodeVersionAccepted(packageVersion: unknown, expectedVersion?: string): boolean {
  if (typeof packageVersion !== "string") return false;
  return expectedVersion
    ? packageVersion === expectedVersion
    : packageVersion.includes("-preview.");
}

/**
 * 版本被拒时的文案。
 * 闸门本身不变（精确配对仍是硬要求），但要让运维一眼看出
 * 「你装的其实更新」以及「该装哪个 CLI」——见 newerAgentNodeVersionHint。
 */
export function agentNodeVersionRejectionMessage(packageVersion: unknown, expectedVersion?: string): string {
  const newerHint = expectedVersion && typeof packageVersion === "string"
    ? newerAgentNodeVersionHint(packageVersion, expectedVersion)
    : null;
  return (expectedVersion
    ? `resolved agent-node package is not exact version ${expectedVersion}`
    : "resolved agent-node package is not a preview-channel candidate")
    + (newerHint ? `; ${newerHint}` : "");
}

/**
 * Resolve a package-owned agent-node entrypoint and verify its immutable
 * release identity before it can receive `opencode-cli`. Capability text is
 * not a security boundary: an older preview already advertised the runtime.
 */
export function validateAgentNodePackageEntrypoint(
  rawEntrypoint: string,
  packageSpec: string,
  expectedVersion?: string,
  forbiddenRoots: readonly string[] = [],
): string {
  if (!isAbsolute(rawEntrypoint)) {
    throw new Error(`${packageSpec} returned a non-absolute entrypoint`);
  }
  const entrypoint = realpathSync(rawEntrypoint);
  const packageRoot = dirname(dirname(entrypoint));
  if (
    basename(packageRoot) !== "agent-node"
    || basename(dirname(packageRoot)) !== "@sleep2agi"
    || basename(dirname(dirname(packageRoot))) !== "node_modules"
  ) {
    throw new Error(`${packageSpec} entrypoint is outside node_modules/@sleep2agi/agent-node`);
  }
  const expectedEntrypoint = join(packageRoot, "dist", "cli.js");
  if (entrypoint !== expectedEntrypoint || realpathSync(expectedEntrypoint) !== expectedEntrypoint) {
    throw new Error(`${packageSpec} entrypoint is outside its package payload`);
  }

  assertSafeAncestors(dirname(entrypoint));
  const entryStat = assertSafePackagePath(entrypoint, "file");
  if (process.platform !== "win32" && (entryStat.mode & 0o111) === 0) {
    throw new Error("resolved agent-node package entrypoint is not executable");
  }
  for (const rawRoot of forbiddenRoots) {
    if (!isAbsolute(rawRoot)) throw new Error("agent-node forbidden root must be absolute");
    const root = realpathSync(resolve(rawRoot));
    if (isWithin(root, packageRoot) || isWithin(packageRoot, root)) {
      throw new Error("project/node-local agent-node package payload is not trusted");
    }
  }

  const packageJsonPath = join(packageRoot, "package.json");
  const pkg = readPackageJsonNoFollow(packageJsonPath);
  const versionAccepted = agentNodeVersionAccepted(pkg?.version, expectedVersion);
  if (
    pkg?.name !== "@sleep2agi/agent-node"
    || typeof pkg?.version !== "string"
    || !versionAccepted
    || pkg?.publishConfig?.tag !== "preview"
    || pkg?.bin?.["agent-node"] !== "dist/cli.js"
  ) {
    throw new Error(agentNodeVersionRejectionMessage(pkg?.version, expectedVersion));
  }

  return entrypoint;
}

/** Skip invalid/local PATH shims and return the first exact trusted package. */
export function resolveAgentNodePackageEntrypointFromPath(
  searchPath: string,
  packageSpec: string,
  expectedVersion: string,
  forbiddenRoots: readonly string[] = [],
): string {
  const errors: string[] = [];
  for (const rawDir of searchPath.split(delimiter)) {
    if (!rawDir || !isAbsolute(rawDir) || rawDir.includes("\0")) continue;
    const candidate = join(rawDir, "agent-node");
    if (!existsSync(candidate)) continue;
    try {
      return validateAgentNodePackageEntrypoint(
        candidate,
        packageSpec,
        expectedVersion,
        forbiddenRoots,
      );
    } catch (error: any) {
      errors.push(String(error?.message ?? error).replace(/[\r\n]+/g, " ").slice(0, 200));
    }
  }
  throw new Error(
    `no exact trusted ${packageSpec} package entrypoint found on PATH` +
    (errors[0] ? `; first rejected candidate: ${errors[0]}` : ""),
  );
}

/**
 * `anet pair` 的内容。为什么要有这个命令：
 *
 * 客户端/文档过去写的是 `npm i -g @sleep2agi/agent-node@preview` 这种**单边**提示。
 * 但 opencode-cli 这条路径**禁用了自动 npx**（见 resolveOpencodeAgentNodeLaunchPlan：
 * "automatic npx execution is disabled for opencode-cli"），所以目标机上必须有一份
 * **精确版本**的全局 agent-node；单边装一个 @preview 很容易装成**半对**，
 * CLI 随即 `Incompatible agent-node for opencode-cli` 拒绝启动，节点掉线。
 *
 * 更糟的是两个包的 preview tag 会**先后**移动（node 先发、声明它的 CLI 后发），
 * 所以「两边都用 @preview」本身也有窗口期不自洽 —— tag 不是配对判据，
 * **本包里的常量才是**。把常量打印出来，是唯一不用猜的答案。
 */
/** `engines` 要求的 Node 版本（与 agent-network/package.json 同源）。 */
export const REQUIRED_NODE_VERSION = "22.13.0";

/**
 * `anet pair` 的 Node 版本提示（不阻断）。
 *
 * 2026-11-22 —— 负责人：npm 的 EBADENGINE 只是裸警告，用户看不懂「会怎样」。
 * 这里用一句话说清：当前版本 X、建议 ≥ required、否则可能有不明确的行为差异。
 * 纯函数，方便单测；返回 null 表示无需提示。
 */
export function nodeEngineWarning(
  current: string = process.versions.node,
  required: string = REQUIRED_NODE_VERSION,
): string | null {
  const parse = (v: string) => v.split(".").map(n => parseInt(n, 10) || 0);
  const [maj, min, patch] = parse(current);
  const [rMaj, rMin, rPatch] = parse(required);
  const ok = maj > rMaj || (maj === rMaj && min > rMin) || (maj === rMaj && min === rMin && patch >= rPatch);
  if (ok) return null;
  return `[anet] ⚠️  当前 Node v${current} 低于本包 engines 要求的 ${required} —— 建议升级到 ≥${required}，否则可能有不明确的行为差异（本次不阻断）。`;
}

export function pairInfo(includeOpenCodeConstraints = true): string {
  const lines = [
    `CLI:        @sleep2agi/agent-network@${PAIRED_AGENT_NETWORK_VERSION}`,
    `agent-node: ${PAIRED_AGENT_NODE_SPEC}   (精确配对，不接受其它版本)`,
    ``,
    `安装这对精确版本:`,
    `  ${opencodeExactPairInstallCommand()}`,
  ];
  if (includeOpenCodeConstraints) {
    lines.push(
      ``,
      `opencode-cli / OpenCode V2 的额外约束:`,
      `  · 自动 npx 已被禁用 —— 目标机上必须有上面那个**精确版本**的全局 agent-node`,
      `  · 用别的版本会直接拒启: Incompatible agent-node for opencode-cli`,
      `  · 别用 @preview 猜: 两个包的 preview tag 会先后移动，tag 不是配对判据`,
    );
  }
  return lines.join("\n");
}
