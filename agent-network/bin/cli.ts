#!/usr/bin/env node
/**
 * anet — AI Agent Network CLI
 *
 * anet init                    配置 hub（全局）
 * anet init project            配置当前项目
 * anet node create commander   创建 node
 * anet node start commander    启动
 * anet ls                      查看状态
 * anet run                     独立 SSE Agent
 */

import { chmodSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { spawn, execSync } from "child_process";
import { createHash, randomBytes, randomUUID } from "crypto";
import { checkbox, confirm, select } from "@inquirer/prompts";

const args = process.argv.slice(2);
const command = args[0];
const home = process.env.HOME || process.env.USERPROFILE || "~";

// ── Config helpers ──

function globalConfigPath() { return join(home, ".anet", "config.json"); }
function serverConfigPath() { return join(home, ".anet", "server", "config.json"); }
function nodesDir() { return join(process.cwd(), ".anet", "nodes"); }

// Token/hub from: CLI --token > env > global config
function getToken(): string {
  const opts = parseOpts();
  return opts.token || process.env.COMMHUB_TOKEN || loadGlobal().token || "";
}

function getHub(): string {
  const opts = parseOpts();
  return opts.hub || process.env.COMMHUB_URL || loadGlobal().hub || "";
}

function authHeaders(token?: string): Record<string, string> {
  const t = token || getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function loadGlobal(): Record<string, any> {
  const p = globalConfigPath();
  if (existsSync(p)) try { return JSON.parse(readFileSync(p, "utf-8")); } catch {}
  return {};
}

function saveGlobal(data: Record<string, any>) {
  const dir = join(home, ".anet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(data, null, 2) + "\n");
}

function loadServerConfig(): Record<string, any> {
  const p = serverConfigPath();
  if (existsSync(p)) try { return JSON.parse(readFileSync(p, "utf-8")); } catch {}
  return {};
}

function saveServerConfig(data: Record<string, any>) {
  const dir = join(home, ".anet", "server");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(data, null, 2) + "\n");
}

interface Profile {
  anet_version?: string;
  node_id?: string;
  node_name?: string;
  name?: string;
  alias?: string;
  hub?: string;
  token?: string;
  runtime?: string;
  codexRuntime?: string;
  model?: string;
  channels: string[];
  env: Record<string, string>;
  flags: Record<string, any>;
  session?: string;
  resume?: string;
  resumeAlias?: string;
  tools?: string[];
  network_id?: string;
}

type RuntimeName = "claude-code-cli" | "codex-sdk" | "claude-agent-sdk" | "http-api";

function normalizeRuntime(profileOrRuntime?: Profile | string): RuntimeName {
  if (typeof profileOrRuntime === "string") {
    if (profileOrRuntime === "codex" || profileOrRuntime === "codex-sdk") return "codex-sdk";
    if (profileOrRuntime === "claude" || profileOrRuntime === "claude-sdk" || profileOrRuntime === "claude-agent-sdk") return "claude-agent-sdk";
    if (profileOrRuntime === "agent-sdk") return "claude-agent-sdk";
    if (profileOrRuntime === "http-api" || profileOrRuntime === "http" || profileOrRuntime === "openai-api" || profileOrRuntime === "minimax") return "http-api";
    return "claude-code-cli";
  }
  const p = profileOrRuntime;
  if (!p) return "claude-code-cli";
  if (p.runtime === "agent-sdk") {
    return p.codexRuntime === "codex" ? "codex-sdk" : "claude-agent-sdk";
  }
  return normalizeRuntime(p.runtime || "claude-code-cli");
}

function nodeDisplayName(id: string, profile?: Profile | null): string {
  return profile?.node_name || profile?.name || profile?.alias || id;
}

function profileSession(profile: Profile): string {
  return profile.session || "";
}

function generateNodeId(): string {
  return `n_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function legacyNodeId(id: string): string {
  return `n_${createHash("sha1").update(id).digest("hex").slice(0, 8)}`;
}

function normalizeStoredProfile(id: string, project: Record<string, any>, globalConfig?: Record<string, any>): Profile {
  const gc = globalConfig || loadGlobal();
  const nodeName = project.node_name || project.name || project.alias || id;
  return {
    ...project,
    node_id: project.node_id || legacyNodeId(id),
    node_name: nodeName,
    name: nodeName,
    alias: nodeName,
    session: project.session || project.resume || project.sessionId || "",
    hub: project.hub || gc.hub || "",
    // Node tokens are per-node (ntok_). Do not fall back to the global user
    // token; doing so silently corrupts the SSE handshake.
    token: project.token || "",
    channels: Array.isArray(project.channels) ? project.channels : [],
    env: project.env && typeof project.env === "object" ? { ...project.env } : {},
    flags: project.flags && typeof project.flags === "object" ? { ...project.flags } : {},
  };
}

function resolveNodeRef(ref: string): { id: string; profile: Profile } | null {
  const direct = loadProfile(ref);
  if (direct) return { id: ref, profile: direct };

  for (const id of listProfileIds()) {
    const profile = loadProfile(id);
    if (!profile) continue;
    if (profile.node_id === ref || profile.node_name === ref || profile.name === ref || profile.alias === ref) {
      return { id, profile };
    }
  }
  return null;
}

function normalizeNodeName(name: string): string {
  return name.normalize("NFC");
}

function validateNodeName(name: string) {
  if (name !== normalizeNodeName(name)) {
    console.error(`Error: node-name must be Unicode NFC normalized: ${name}`);
    process.exit(1);
  }
  if (!/^[^\s\/\\:*?"<>|.][^\s\/\\:*?"<>|.]*$/.test(name)) {
    console.error(`Error: invalid node-name "${name}"`);
    console.error(`Allowed: Chinese/letters/numbers/-/_ ; forbidden: whitespace, '.', / \\ : * ? " < > |`);
    process.exit(1);
  }
}

function loadProfile(id: string): Profile | null {
  const p = join(nodesDir(), id, "config.json");
  if (!existsSync(p)) return null;
  try {
    const project = JSON.parse(readFileSync(p, "utf-8"));
    return normalizeStoredProfile(id, project);
  } catch { return null; }
}

function loadStoredProfile(id: string): Profile | null {
  const p = join(nodesDir(), id, "config.json");
  if (!existsSync(p)) return null;
  try {
    const project = JSON.parse(readFileSync(p, "utf-8"));
    return normalizeStoredProfile(id, project);
  } catch { return null; }
}

function saveProfile(id: string, profile: Profile) {
  const dir = join(nodesDir(), id);
  mkdirSync(dir, { recursive: true });
  const normalized = normalizeStoredProfile(id, profile);
  const toSave: Record<string, any> = {
    anet_version: normalized.anet_version,
    node_id: normalized.node_id,
    node_name: normalized.node_name,
    runtime: normalized.runtime,
    ...(normalized.hub ? { hub: normalized.hub } : {}),
    ...(normalized.token ? { token: normalized.token } : {}),
    ...(normalized.model ? { model: normalized.model } : {}),
    ...(normalized.tools ? { tools: normalized.tools } : {}),
    channels: normalized.channels || [],
    env: normalized.env || {},
    flags: normalized.flags || {},
    ...(normalized.session ? { session: normalized.session } : {}),
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(toSave, null, 2) + "\n");
}

function listProfileIds(): string[] {
  const dir = nodesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => existsSync(join(dir, name, "config.json")));
}

// ── Parse --key value and repeatable --channel/--env ──

function parseOpts(): Record<string, string> & { _channels: string[]; _envs: string[] } {
  const r: any = { _channels: [], _envs: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--channel" && args[i + 1]) { r._channels.push(args[++i]); continue; }
    if (args[i] === "--env" && args[i + 1]) { r._envs.push(args[++i]); continue; }
    if (args[i].startsWith("--") && args[i + 1] && !args[i + 1].startsWith("--")) {
      r[args[i].slice(2)] = args[++i];
    } else if (args[i].startsWith("--")) {
      r[args[i].slice(2)] = "true";
    }
  }
  return r;
}

function commandExists(name: string): boolean {
  try {
    execSync(`command -v ${JSON.stringify(name)}`, { stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
}

type VersionState = "ok" | "unknown" | "not-installed";

interface DetectedVersion {
  name: string;
  displayName: string;
  version: string | null;
  state: VersionState;
  source?: string;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function packageJsonPath() {
  // Try multiple paths: compiled dist/bin/cli.js → ../../package.json, source bin/cli.ts → ../package.json
  const candidates = [
    join(new URL(".", import.meta.url).pathname, "..", "..", "package.json"),
    join(new URL(".", import.meta.url).pathname, "..", "package.json"),
  ];
  for (const p of candidates) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return candidates[0]; // fallback to first
}

function parseSemver(text: string): Semver | null {
  const match = text.match(/(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

function detectCommandVersion(commandName: string, displayName: string, source?: string): DetectedVersion {
  if (!commandExists(commandName)) {
    return { name: commandName, displayName, version: null, state: "not-installed", source };
  }
  try {
    const output = execSync(`${JSON.stringify(commandName)} --version`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: "/bin/bash",
      timeout: 5000,
    }).trim();
    const parsed = parseSemver(output);
    if (!parsed) {
      return { name: commandName, displayName, version: null, state: "unknown", source };
    }
    return {
      name: commandName,
      displayName,
      version: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
      state: "ok",
      source,
    };
  } catch {
    return { name: commandName, displayName, version: null, state: "unknown", source };
  }
}

function detectGlobalNpmPackage(pkgName: string, displayName: string, source = "global"): DetectedVersion {
  try {
    const output = execSync(`npm ls -g ${JSON.stringify(pkgName)} --depth=0 --json`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: "/bin/bash",
    });
    const data = JSON.parse(output);
    const version = data?.dependencies?.[pkgName]?.version;
    if (!version) {
      return { name: pkgName, displayName, version: null, state: "unknown", source };
    }
    const parsed = parseSemver(version);
    if (!parsed) {
      return { name: pkgName, displayName, version: null, state: "unknown", source };
    }
    return {
      name: pkgName,
      displayName,
      version: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
      state: "ok",
      source,
    };
  } catch {
    return { name: pkgName, displayName, version: null, state: "not-installed", source };
  }
}

function detectInstalledPackages() {
  const pkg = JSON.parse(readFileSync(packageJsonPath(), "utf-8"));
  const versions = {
    anet: {
      name: "anet",
      displayName: "anet",
      version: pkg.version as string,
      state: "ok" as VersionState,
    },
    agentNode: detectCommandVersion("agent-node", "agent-node", "global"),
    commhubServer: detectCommandVersion("commhub-server", "commhub-server", "global"),
    claude: detectCommandVersion("claude", "claude CLI"),
    codex: detectCommandVersion("codex", "codex CLI"),
  };

  if (versions.agentNode.state !== "ok") {
    versions.agentNode = detectGlobalNpmPackage("@sleep2agi/agent-node", "agent-node", "global");
  }
  if (versions.commhubServer.state !== "ok") {
    versions.commhubServer = detectGlobalNpmPackage("@sleep2agi/commhub-server", "commhub-server", "global");
  }

  return versions;
}

function formatDetectedVersion(pkg: DetectedVersion): string {
  const suffix = pkg.source ? ` (${pkg.source})` : "";
  if (pkg.state === "ok" && pkg.version) return `${pkg.displayName} v${pkg.version}${suffix}`;
  if (pkg.state === "unknown") return `${pkg.displayName} installed (version unknown)${suffix}`;
  return `${pkg.displayName} not installed`;
}

function formatLazyComponent(pkg: DetectedVersion): string {
  if (pkg.state === "ok" && pkg.version) return `✓ ${pkg.displayName} v${pkg.version}`;
  if (pkg.state === "unknown") return `✓ ${pkg.displayName} installed`;
  return `○ ${pkg.displayName} — not installed yet (will fetch via npx on first use)`;
}

function formatOptionalRuntime(pkg: DetectedVersion, reason: string): string {
  if (pkg.state === "ok" && pkg.version) return `✓ ${pkg.displayName} v${pkg.version}`;
  if (pkg.state === "unknown") return `✓ ${pkg.displayName} installed`;
  return `○ ${pkg.displayName} — only needed for ${reason}`;
}

function detectAgentNodeSubDeps(): { claudeAgentSdk: string | null; codexSdk: string | null } {
  const globalPrefix = execSync("npm prefix -g", { encoding: "utf-8", timeout: 5000 }).trim();
  const base = join(globalPrefix, "lib", "node_modules", "@sleep2agi", "agent-node", "node_modules");
  let claudeAgentSdk: string | null = null;
  let codexSdk: string | null = null;
  try {
    const pkg = JSON.parse(readFileSync(join(base, "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf-8"));
    claudeAgentSdk = pkg.version;
  } catch {}
  try {
    const pkg = JSON.parse(readFileSync(join(base, "@openai", "codex-sdk", "package.json"), "utf-8"));
    codexSdk = pkg.version;
  } catch {}
  return { claudeAgentSdk, codexSdk };
}

function printVersionReport() {
  const versions = detectInstalledPackages();
  console.log(`anet v${versions.anet.version}\n`);

  console.log("Components (auto-fetched on first use, you don't need to install them manually):");
  console.log(`  ${formatLazyComponent(versions.agentNode)}`);
  if (versions.agentNode.state === "ok") {
    try {
      const sub = detectAgentNodeSubDeps();
      if (sub.claudeAgentSdk) console.log(`    └ @anthropic-ai/claude-agent-sdk v${sub.claudeAgentSdk}`);
      if (sub.codexSdk) console.log(`    └ @openai/codex-sdk v${sub.codexSdk}`);
    } catch {}
  }
  console.log(`  ${formatLazyComponent(versions.commhubServer)}`);

  console.log("\nOptional runtimes (install only what you'll use):");
  console.log(`  ${formatOptionalRuntime(versions.claude, "the claude-code-cli runtime")}`);
  console.log(`  ${formatOptionalRuntime(versions.codex, "the codex-sdk runtime")}`);

  const componentsMissing = versions.agentNode.state !== "ok" || versions.commhubServer.state !== "ok";
  if (componentsMissing) {
    console.log("\nNothing is broken — components are fetched the first time you run:");
    console.log("  anet hub start          # bootstraps commhub-server");
    console.log("  anet node start <name>  # bootstraps agent-node");
    console.log("\nDocs: https://anet.sh/guide/getting-started");
  }
}

function isInstalled(pkg: DetectedVersion): boolean {
  return pkg.state === "ok" || pkg.state === "unknown";
}

function installGlobalPackage(pkgName: string) {
  execSync(`npm install -g ${JSON.stringify(pkgName)}`, { stdio: "inherit", shell: "/bin/bash" });
}

function printDetectedPackagesForSetup() {
  const versions = detectInstalledPackages();
  console.log(`检测已安装的包...`);
  console.log(`  ✅ anet v${versions.anet.version}`);
  console.log(`  ${isInstalled(versions.agentNode) ? "✅" : "❌"} ${formatDetectedVersion(versions.agentNode)}`);
  console.log(`  ${isInstalled(versions.claude) ? "✅" : "❌"} ${formatDetectedVersion(versions.claude)}`);
  console.log(`  ${isInstalled(versions.codex) ? "✅" : "❌"} ${formatDetectedVersion(versions.codex)}`);
  console.log(`  ${isInstalled(versions.commhubServer) ? "✅" : "❌"} ${formatDetectedVersion(versions.commhubServer)}`);
  console.log();
  return versions;
}

async function setupCommand() {
  const versions = printDetectedPackagesForSetup();
  const runtimeSelections = await checkbox<RuntimeName>({
    message: "你需要哪些 runtime？（空格选择，回车确认）",
    choices: [
      {
        name: `claude-code-cli — Claude Code CLI${isInstalled(versions.claude) ? "（已就绪 ✅）" : "（需要安装 claude CLI）"}`,
        value: "claude-code-cli",
        checked: isInstalled(versions.claude),
      },
      {
        name: `codex-sdk — Codex SDK${isInstalled(versions.agentNode) && isInstalled(versions.codex) ? "（已就绪 ✅）" : "（需要安装 agent-node + codex CLI）"}`,
        value: "codex-sdk",
      },
      {
        name: `claude-agent-sdk — Claude Agent SDK${isInstalled(versions.agentNode) ? "（已就绪 ✅）" : "（需要安装 agent-node）"}`,
        value: "claude-agent-sdk",
      },
    ],
  });

  const installCommhubServer = await confirm({
    message: "要安装 CommHub Server 吗？（本地开发/测试用）",
    default: false,
  });

  const packagesToInstall: string[] = [];
  const addPackage = (pkgName: string) => {
    if (!packagesToInstall.includes(pkgName)) packagesToInstall.push(pkgName);
  };

  if (runtimeSelections.includes("claude-code-cli") && !isInstalled(versions.claude)) {
    addPackage("@anthropic-ai/claude-code");
  }
  if (runtimeSelections.includes("codex-sdk")) {
    if (!isInstalled(versions.agentNode)) addPackage("@sleep2agi/agent-node");
    if (!isInstalled(versions.codex)) addPackage("@openai/codex");
  }
  if (runtimeSelections.includes("claude-agent-sdk") && !isInstalled(versions.agentNode)) {
    addPackage("@sleep2agi/agent-node");
  }
  if (installCommhubServer && !isInstalled(versions.commhubServer)) {
    addPackage("@sleep2agi/commhub-server");
  }

  if (packagesToInstall.length === 0) {
    console.log(`所有所选 runtime 依赖都已安装。`);
  } else {
    console.log(`即将安装:`);
    for (const pkgName of packagesToInstall) {
      console.log(`  npm install -g ${pkgName}`);
    }
    const shouldInstall = await confirm({ message: "确认安装？", default: true });
    if (!shouldInstall) {
      console.log(`已取消。`);
      return;
    }

    console.log(`\n安装中...`);
    for (const pkgName of packagesToInstall) {
      try {
        installGlobalPackage(pkgName);
      } catch {
        console.error(`[anet] Failed to install ${pkgName}`);
        process.exit(1);
      }
    }
  }

  console.log(`\n验证:`);
  const verified = detectInstalledPackages();
  if (runtimeSelections.includes("claude-code-cli")) {
    console.log(`  ${isInstalled(verified.claude) ? "✅" : "❌"} ${formatDetectedVersion(verified.claude)}`);
  }
  if (runtimeSelections.includes("codex-sdk") || runtimeSelections.includes("claude-agent-sdk")) {
    console.log(`  ${isInstalled(verified.agentNode) ? "✅" : "❌"} ${formatDetectedVersion(verified.agentNode)}`);
  }
  if (runtimeSelections.includes("codex-sdk")) {
    console.log(`  ${isInstalled(verified.codex) ? "✅" : "❌"} ${formatDetectedVersion(verified.codex)}`);
  }
  if (installCommhubServer) {
    console.log(`  ${isInstalled(verified.commhubServer) ? "✅" : "❌"} ${formatDetectedVersion(verified.commhubServer)}`);
  }

  if (runtimeSelections.includes("codex-sdk")) {
    console.log(`  ⚠ codex 需要登录: codex auth login`);
  }
  if (runtimeSelections.includes("claude-code-cli")) {
    console.log(`  ⚠ claude 需要登录: claude auth login`);
  }

  console.log(`\n完成！下一步: anet node create <node-name>`);
}

function assertStartCompatibility(runtime: RuntimeName) {
  if (runtime !== "codex-sdk" && runtime !== "claude-agent-sdk") return;

  const versions = detectInstalledPackages();
  const requiredAgentNode = parseSemver("1.0.0")!;
  const requiredCommhub = parseSemver("0.4.0")!;

  if (versions.agentNode.state !== "ok" || !versions.agentNode.version) {
    console.error(`[anet] agent-node is not installed or cannot report a version.`);
    console.error(`[anet] Run: anet upgrade`);
    process.exit(1);
  }

  const agentNodeVersion = parseSemver(versions.agentNode.version);
  if (!agentNodeVersion || compareSemver(agentNodeVersion, requiredAgentNode) < 0) {
    console.error(`[anet] Incompatible package versions.`);
    console.error(`[anet] anet v${versions.anet.version} requires agent-node >= 1.0.0, but found agent-node v${versions.agentNode.version}.`);
    console.error(`[anet] Run: anet upgrade`);
    process.exit(1);
  }

  if (versions.commhubServer.state === "ok" && versions.commhubServer.version) {
    const commhubVersion = parseSemver(versions.commhubServer.version);
    if (commhubVersion && compareSemver(commhubVersion, requiredCommhub) < 0) {
      console.warn(`[anet] Warning: local commhub-server v${versions.commhubServer.version} is older than recommended >= 0.4.0.`);
      console.warn(`[anet] If this machine hosts CommHub, run: anet upgrade`);
    }
  }
}

function printClaudeCodeNotice() {
  console.log(`[anet] claude-code-cli requires:`);
  console.log(`  - Claude Pro / Team / Enterprise subscription`);
  console.log(`  - Run "claude auth login" first`);
  console.log(`  - Uses Anthropic Claude only`);
  console.log(`  - For other models, use --runtime codex-sdk or claude-agent-sdk`);
}

function checkRuntimeDependency(runtime: RuntimeName, phase: "create" | "start") {
  if (runtime === "claude-code-cli") {
    if (!commandExists("claude")) {
      console.warn(`[anet] Warning: claude CLI not found in PATH.`);
      console.warn(`[anet] Install: npm install -g @anthropic-ai/claude-code`);
    }
    if (phase === "start") printClaudeCodeNotice();
    return;
  }
  if (!commandExists("agent-node")) {
    console.warn(`[anet] Warning: agent-node not found in PATH.`);
    console.warn(`[anet] Run: anet upgrade`);
  }
}

// ── Help ──

function friendlyError(e: any): string {
  const msg = e?.message || String(e);
  if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
    return "Cannot connect to CommHub server. Is it running?\n  Start: anet hub start\n  Or check: anet doctor";
  }
  if (msg.includes("401") || msg.includes("unauthorized")) {
    return "Authentication failed. Try: anet login";
  }
  if (msg.includes("403")) {
    return "Access denied. You may not have permission for this operation.";
  }
  if (msg.includes("429")) {
    return "Too many requests. Please wait a moment and try again.";
  }
  return msg;
}

function printHelp() {
  console.log(`
anet — AI Agent Network CLI (V2)

Node Management:
  anet node create <name>        Create a new agent node
  anet node start <name>         Start a node
  anet node stop <name>          Stop a running node
  anet node resume <name>        Resume interrupted session
  anet node delete <name>        Delete node and config
  anet node rename <ref> <new>   Rename a node
  anet node ls                   List all nodes
  anet info <name>              Detailed node info + server status
  anet status                   Network overview (agents + tasks)
  anet tasks [status]           Query tasks (replied/failed/delivered)

Session:
  anet node start <name> --new-session   Start with fresh session
  anet node resume <name> --session <id> Resume specific session
  anet session ls               List Claude Code sessions

Channel:
  anet channel add telegram <name> --bot-token <tok> --allow <uid>
  anet channel ls [name]        List channels

Setup:
  anet init                     Configure hub URL (global)
  anet init project             Setup project (channel plugin)
  anet setup                    Install runtime dependencies
  anet hub start                 Start CommHub Server + admin bootstrap
  anet hub dashboard             Start Web Dashboard
  anet hub config                Show/set server config
  anet upgrade                  Check for updates

Other:
  anet import [alias]           Import sessions from CommHub
  anet register                  Create new account
  anet login                    Login (username + password)
  anet login --token <tok>      Login with API token
  anet logout                   Remove saved token
  anet passwd                   Change password
  anet whoami                   Show current user + networks
  anet network ls               List my networks
  anet network create <name>    Create a network
  anet network use <name>       Switch to a network
  anet license                  Show license status + limits
  anet activate <key>           Activate license key
  anet logs <name>              Show recent agent logs
  anet doctor                   System diagnostic check
  anet run                      Standalone SSE agent
  anet -v                       Version + dependency report

Quick start:
  anet hub start                  Start local hub
  anet login                      Log in to the hub
  anet node create my-agent       Create a node
  anet node start my-agent        Start the node
  anet demo                       List demos

Legacy aliases:
  anet create <name>              Alias for anet node create
  anet start <name>               Alias for anet node start
`);
}

// ── init (global) ──

async function initGlobal() {
  const opts = parseOpts();
  let hub = opts.hub;

  if (!hub) {
    hub = await ask("CommHub URL (e.g. http://YOUR_IP:9200)");
  }

  if (!hub) { closeRL(); console.error("Error: hub URL required"); process.exit(1); }
  hub = hub.replace(/\/+$/, ""); // 去掉结尾斜杠

  let token = opts.token || "";
  if (!token) {
    token = await ask("Auth token (empty to skip)");
  }
  closeRL();
  try {
    const res = await fetch(`${hub}/health`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const data = await res.json() as any;
    console.log(`✅ CommHub v${data.version} — ${data.sessions} sessions, ${data.sse_connections} SSE`);
  } catch (e: any) {
    console.error(`❌ Cannot reach ${hub}: ${e.message}`);
    process.exit(1);
  }

  const gc = loadGlobal();
  gc.hub = hub;
  if (token) gc.token = token;
  else if (!gc.token) delete gc.token; // don't overwrite existing token with empty
  saveGlobal(gc);
  console.log(`\nSaved to ${globalConfigPath()}`);
  console.log(`Next: anet init project`);
}

// ── init project ──

async function initProject() {
  const gc = loadGlobal();
  const hub = gc.hub;
  if (!hub) {
    console.error("Run 'anet init' first to configure hub URL");
    process.exit(1);
  }

  const anetDir = join(process.cwd(), ".anet");
  mkdirSync(anetDir, { recursive: true });

  // 1. Write node-server.ts
  const serverTs = join(anetDir, "node-server.js");
  if (!existsSync(serverTs)) {
    // Try multiple paths to find node-server.ts
    const candidates = [
      join(new URL(".", import.meta.url).pathname, "..", "..", "dist", "src", "node-server.js"),
      join(new URL(".", import.meta.url).pathname, "..", "src", "node-server.js"),
      join(new URL(".", import.meta.url).pathname, "..", "..", "src", "node-server.ts"),
      join(process.argv[1], "..", "..", "dist", "src", "node-server.js"),
      join(process.argv[1], "..", "..", "src", "node-server.ts"),
    ];
    let found = false;
    for (const p of candidates) {
      if (existsSync(p)) {
        writeFileSync(serverTs, readFileSync(p, "utf-8"));
        console.log(`  ✅ .anet/node-server.js`);
        found = true;
        break;
      }
    }
    if (!found) {
      console.log(`  ❌ Cannot find node-server.ts`);
      console.log(`  Fix: cp $(npm root -g)/@sleep2agi/agent-network/src/node-server.ts .anet/node-server.js`);
    }
  } else {
    console.log("  Channel plugin: exists");
  }

  // 2. package.json for channel deps
  const pkgJson = join(anetDir, "package.json");
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, JSON.stringify({
      "private": true,
      "dependencies": {
        "@modelcontextprotocol/sdk": "^1.12.0"
      }
    }, null, 2) + "\n");
    try {
      execSync("bun install", { cwd: anetDir, stdio: "pipe" });
      console.log("  ✅ Dependencies installed");
    } catch {
      console.log("  ⚠️  Run: cd .anet && bun install");
    }
  }

  // 3. .env（CommHub URL + Token）
  const envPath = join(anetDir, ".env");
  const token = gc.token || "";
  let envContent = `COMMHUB_URL=${hub}\n`;
  if (token) envContent += `COMMHUB_TOKEN=${token}\n`;
  writeFileSync(envPath, envContent);
  console.log(`CommHub URL: ${hub}${token ? " (with token)" : ""}`);

  // 4. .mcp.json（指向 .anet/node-server.js）
  const mcpJsonPath = join(process.cwd(), ".mcp.json");
  let mcpConfig: any = {};
  if (existsSync(mcpJsonPath)) try { mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf-8")); } catch {}
  if (!mcpConfig.mcpServers?.commhub) {
    mcpConfig.mcpServers = mcpConfig.mcpServers || {};
    mcpConfig.mcpServers.commhub = { type: "stdio", command: "bun", args: [".anet/node-server.js"] };
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    console.log(`.mcp.json: commhub → .anet/node-server.js`);
  } else {
    console.log(`.mcp.json: commhub already set`);
  }

  // 5. CLAUDE.md（让 Claude Code 知道怎么用 CommHub）
  const claudeMdPath = join(process.cwd(), "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, `# Agent Network (CommHub)

## 通信方式

你已接入 CommHub 通信网络。用以下 MCP 工具和其他 Agent/指挥室通信：

### 给别人发消息
\`\`\`
commhub_send_task(alias="指挥室", task="你要说的内容", priority="normal")
\`\`\`

### 回复任务
\`\`\`
commhub_reply(task_id="从消息 meta 里拿", text="回复内容", status="completed")
\`\`\`

### 上报状态
\`\`\`
commhub_report_status(status="working", task="正在做什么")
\`\`\`

### 查看谁在线
\`\`\`
commhub_get_all_status()
\`\`\`

## 收到消息

来自 CommHub 的消息会以 \`<channel source="commhub" sender="..." task_id="...">\` 格式出现在对话中。收到后：
1. 立即用 commhub_send_task 回复发送者确认收到
2. 执行任务
3. 用 commhub_send_task 回复结果

## 规则

- 收到任务必须回应：确认→执行→汇报
- 回复指挥室用 commhub_send_task（不是 commhub_reply，reply 不推送）
- 不要猜 alias，用 get_all_status 查
`);
    console.log(`CLAUDE.md: created`);
  } else {
    console.log(`CLAUDE.md: already exists`);
  }

  console.log(`\n✅ Project ready. Next: anet node create <node-name>`);
}

// ── init profile ──

async function initProfile() {
  console.warn(`[deprecated] anet init profile is now anet node create.`);
  console.warn(`             Run: anet node create <node-name> [--runtime ...]\n`);
  await createCommand(args[2]);
}

function createProfileFromOpts(id: string, opts: ReturnType<typeof parseOpts>): Profile {
  const gc = loadGlobal();
  const hub = opts.hub || gc.hub;
  if (!hub) {
    console.error("Run 'anet init' first to configure hub URL");
    process.exit(1);
  }

  // Build env map
  const envMap: Record<string, string> = {};
  for (const e of opts._envs) {
    const eq = e.indexOf("=");
    if (eq > 0) envMap[e.slice(0, eq)] = e.slice(eq + 1);
  }

  // Default to claude-agent-sdk — works with any Anthropic-compatible API
  // (MiniMax/DeepSeek/GLM/Kimi/Anthropic). claude-code-cli only works for Max/Pro
  // subscribers and was a poor default that left non-subscribers with broken nodes.
  const runtime = normalizeRuntime(opts.runtime || "claude-agent-sdk");
  const defaultModel = runtime === "codex-sdk" ? "gpt-5.4" : undefined;

  const profile: Profile = {
    anet_version: "0.1.0",
    node_id: generateNodeId(),
    node_name: id,
    alias: id,
    runtime,
    ...(gc.network_id ? { network_id: gc.network_id } : {}),
    ...(opts.hub ? { hub } : {}),
    ...(opts.model || defaultModel ? { model: opts.model || defaultModel } : {}),
    ...(opts.tools ? { tools: opts.tools.split(",").map((s: string) => s.trim()) } : {}),
    channels: opts._channels.length > 0 ? opts._channels : ["server:commhub"],
    env: envMap,
    flags: {
      dangerouslySkipPermissions: true,
      ...(runtime === "claude-code-cli" ? { teammateMode: opts["teammate-mode"] || "in-process" } : {}),
      ...(opts["max-turns"] ? { maxTurns: parseInt(opts["max-turns"]) } : {}),
    },
    ...(opts.session ? { session: opts.session } : {}),
  };
  return profile;
}

function saveCreatedNode(id: string, profile: Profile) {
  writeLegacyProjectAlias(profile.node_name || id);
  saveProfile(id, profile);
}

async function requestNodeToken(profile: Profile, id: string): Promise<string> {
  const gc = loadGlobal();
  const hub = profile.hub || gc.hub;
  const networkId = profile.network_id || gc.network_id;
  const userToken = gc.token;
  const nodeName = profile.node_name || profile.name || profile.alias || id;
  if (!hub) throw new Error("missing hub; run: anet init");
  if (!userToken) throw new Error("missing login token; run: anet login");
  if (!networkId) throw new Error("missing network_id; run: anet login");

  const res = await fetch(`${hub}/api/auth/node-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ network_id: networkId, node_name: nodeName }),
  });
  const body = await res.json() as any;
  if (!body?.ok || !body.token) {
    throw new Error(`node-token request failed: ${body?.error || res.status}`);
  }
  return body.token;
}

async function ensureNodeToken(profile: Profile, id: string): Promise<Profile> {
  const token = profile.token || "";
  if (token.startsWith("ntok_")) return profile;
  profile.token = await requestNodeToken(profile, id);
  return profile;
}

function writeLegacyProjectAlias(alias: string) {
  const channelDir = join(home, ".claude", "channels", "commhub");
  const projectKey = process.cwd().replace(/\//g, "-");
  const aliasDir = join(channelDir, projectKey);
  mkdirSync(aliasDir, { recursive: true });
  writeFileSync(join(aliasDir, ".env"), `COMMHUB_ALIAS=${alias}\n`);
}

function attachChannel(profile: Profile, channel: string) {
  profile.channels = profile.channels || [];
  if (!profile.channels.includes(channel)) profile.channels.push(channel);
}

function writeTelegramChannelConfig(nodeId: string, botToken: string, allowId: string): string {
  const channelDir = join(nodesDir(), nodeId, "channels", "telegram");
  mkdirSync(channelDir, { recursive: true });
  mkdirSync(join(channelDir, "inbox"), { recursive: true });

  const envPath = join(channelDir, ".env");
  writeFileSync(envPath, `TELEGRAM_BOT_TOKEN=${botToken}\n`);
  try { chmodSync(envPath, 0o600); } catch {}

  writeFileSync(join(channelDir, "access.json"), JSON.stringify({
    dmPolicy: "allowlist",
    allowFrom: [allowId],
    groups: {},
    pending: {},
  }, null, 2) + "\n");
  return channelDir;
}

async function askChoice<T extends string>(title: string, choices: { label: string; value: T; description?: string }[]): Promise<T> {
  closeRL();
  return await select<T>({
    message: title,
    choices: choices.map((choice) => ({
      name: choice.label,
      value: choice.value,
      description: choice.description,
    })),
  });
}

function maskSecretEnv(env: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const isSecret = /TOKEN|KEY|SECRET|PASSWORD/i.test(key);
    masked[key] = isSecret && value ? `${value.slice(0, 4)}...` : value;
  }
  return masked;
}

function printProfileSummary(id: string, profile: Profile) {
  const summary = {
    node_id: profile.node_id,
    node_name: nodeDisplayName(id, profile),
    runtime: normalizeRuntime(profile),
    model: profile.model || "(runtime default)",
    session: profileSession(profile) || "(new)",
    channels: profile.channels,
    env: maskSecretEnv(profile.env || {}),
    config: join(nodesDir(), id, "config.json"),
  };
  console.log(`\n[anet] Config summary:`);
  console.log(JSON.stringify(summary, null, 2));
}

async function createInteractiveCommand() {
  console.log(`
[anet] Create a node

This wizard creates one agent node for this project:
  - node config: .anet/nodes/<node-name>/config.json
  - runtime: claude-code-cli / codex-sdk / claude-agent-sdk
  - optional Telegram channel: text + images from an allowlist user
`);

  const id = await ask("Node name");
  if (!id) {
    closeRL();
    console.error("Error: node-name required");
    process.exit(1);
  }
  validateNodeName(id);
  if (resolveNodeRef(id)) {
    closeRL();
    console.error(`Node "${id}" already exists: .anet/nodes/${id}/config.json`);
    process.exit(1);
  }

  console.log(`
Runtime guide:
  - claude-code-cli  Use your Claude Code app/CLI session. Best for existing Claude Code workflows.
  - codex-sdk        Run through agent-node with Codex. Best for GPT-5.4 / OpenAI models.
  - claude-agent-sdk Run through agent-node with an Anthropic-compatible API.
                     Use this for MiniMax or Anthropic-compatible providers.
`);
  const runtime = await askChoice<RuntimeName>("Select runtime:", [
    { label: "claude-code-cli", value: "claude-code-cli", description: "Claude Code CLI（需要 Pro 订阅）" },
    { label: "codex-sdk", value: "codex-sdk", description: "Codex SDK（GPT-5.4）" },
    { label: "claude-agent-sdk", value: "claude-agent-sdk", description: "Claude Agent SDK（MiniMax/书生等）" },
  ]);

  const opts = parseOpts();
  opts.runtime = runtime;

  if (runtime === "codex-sdk") {
    console.log(`
Model guide:
  - gpt-5.4  Default Codex model.
  - o3       Reasoning model; use it if your account/session supports it.
  - custom   Type an exact model name.
`);
    const modelChoice = await askChoice("Select model:", [
      { label: "gpt-5.4", value: "gpt-5.4" },
      { label: "o3", value: "o3" },
      { label: "custom", value: "__custom__" },
    ]);
    opts.model = modelChoice === "__custom__" ? await ask("Model") : modelChoice;
  } else if (runtime === "claude-agent-sdk") {
    console.log(`
Model guide:
  - MiniMax-M2.7       URL: https://api.minimaxi.com/anthropic
  - claude-sonnet-4-6  Anthropic Claude via the default Anthropic API.
  - claude-opus-4-6    Anthropic Claude via the default Anthropic API.
  - claude-haiku-4-5   Anthropic Claude via the default Anthropic API.
  - custom             Type both URL and model for any Anthropic-compatible provider.
`);
    const modelChoice = await askChoice("Select model:", [
      { label: "MiniMax-M2.7", value: "MiniMax-M2.7", description: "URL: https://api.minimaxi.com/anthropic" },
      { label: "claude-sonnet-4-6", value: "claude-sonnet-4-6", description: "Anthropic default URL" },
      { label: "claude-opus-4-6", value: "claude-opus-4-6", description: "Anthropic default URL" },
      { label: "claude-haiku-4-5", value: "claude-haiku-4-5", description: "Anthropic default URL" },
      { label: "custom", value: "__custom__", description: "Manually enter base URL + model" },
    ]);
    opts.model = modelChoice;

    if (opts.model === "__custom__") {
      const baseUrl = await ask("ANTHROPIC_BASE_URL");
      const customModel = await ask("Model");
      if (baseUrl) opts._envs.push(`ANTHROPIC_BASE_URL=${baseUrl}`);
      opts.model = customModel;
    } else if (opts.model === "MiniMax-M2.7") {
      opts._envs.push("ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic");
    }

    console.log(`
API key:
  Paste the provider key for the selected model.
  - MiniMax: get a token from the MiniMax platform / API Keys page.
  - Anthropic Claude: use an Anthropic Console API key.
  - Custom URL: use the key/token for that Anthropic-compatible provider.
`);
    const token = await ask("ANTHROPIC_AUTH_TOKEN");
    if (token) opts._envs.push(`ANTHROPIC_AUTH_TOKEN=${token}`);
  }

  const profile = await ensureNodeToken(createProfileFromOpts(id, opts), id);

  const addTelegram = await ask("Add Telegram channel? (y/n)", "n");
  let telegramConfig: { botToken: string; allowId: string } | null = null;
  if (/^y(es)?$/i.test(addTelegram)) {
    console.log(`
Telegram setup:
  1. Open Telegram and talk to @BotFather.
  2. Create a bot and copy the bot token.
  3. Talk to @userinfobot to get your numeric user ID.
`);
    const botToken = await ask("Telegram Bot Token");
    const allowId = await ask("Allow User ID (numeric ID from @userinfobot)", "7612221352");
    if (!botToken) {
      closeRL();
      console.error("Error: Telegram Bot Token required");
      process.exit(1);
    }
    telegramConfig = { botToken, allowId };
    attachChannel(profile, "telegram");
  }

  closeRL();
  saveCreatedNode(id, profile);
  if (telegramConfig) {
    writeTelegramChannelConfig(id, telegramConfig.botToken, telegramConfig.allowId);
  }
  checkRuntimeDependency(normalizeRuntime(profile), "create");

  console.log(`\n[anet] Created node "${id}" (${normalizeRuntime(profile)})`);
  if (telegramConfig) console.log(`[anet] ✅ Telegram channel added`);
  if (normalizeRuntime(profile) === "claude-code-cli") {
    printClaudeCodeNotice();
  }
  console.log(`[anet] ⚠ dangerouslySkipPermissions and teammateMode enabled by default.`);
  console.log(`[anet] To disable: edit .anet/nodes/${id}/config.json → flags`);
  printProfileSummary(id, loadProfile(id) || profile);
  console.log(`\nStart: anet node start ${id}`);
}

async function createCommand(idOverride?: string) {
  const id = idOverride || args[1];
  if (!id) return createInteractiveCommand();
  if (id.startsWith("--")) {
    console.error("Usage: anet node create <node-name> [--runtime claude-code-cli|codex-sdk|claude-agent-sdk] [--model ...] [--tools ...]");
    console.error("Or run fully interactive: anet node create");
    process.exit(1);
  }
  validateNodeName(id);

  if (resolveNodeRef(id)) {
    console.error(`Node "${id}" already exists: .anet/nodes/${id}/config.json`);
    process.exit(1);
  }

  const opts = parseOpts();
  const gc = loadGlobal();

  // ── Check hub connection BEFORE asking for model/key ──
  if (!gc.hub) {
    try {
      const h = await fetch("http://127.0.0.1:9200/health").then(r => r.json() as any);
      if (h.ok) {
        gc.hub = "http://127.0.0.1:9200";
        saveGlobal(gc);
        console.log(`[anet] 检测到本地 CommHub: ${gc.hub}`);
      }
    } catch {}
  }
  if (!gc.hub) {
    console.error("未找到 CommHub Server。请先运行:\n  anet hub start\n\n或手动配置:\n  anet init --hub http://YOUR_IP:9200");
    process.exit(1);
  }

  // ── Interactive model selector (when no --runtime specified) ──
  const MODEL_PRESETS: Record<string, { runtime: string; label: string; baseUrl?: string; envKey?: string; requiresAuth?: string; signupUrl?: string }> = {
    minimax:   { runtime: "claude-agent-sdk", label: "MiniMax（推荐，国内直连，低成本）", baseUrl: "https://api.minimaxi.com/anthropic", envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://platform.minimaxi.com" },
    deepseek:  { runtime: "claude-agent-sdk", label: "DeepSeek（代码+推理，性价比极高）", baseUrl: "https://api.deepseek.com/anthropic", envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://platform.deepseek.com" },
    glm:       { runtime: "claude-agent-sdk", label: "GLM 智谱（中文理解强）", baseUrl: "https://open.bigmodel.cn/anthropic", envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://open.bigmodel.cn" },
    intern:    { runtime: "claude-agent-sdk", label: "书生 Intern（科学推理）", baseUrl: "https://chat.intern-ai.org.cn/anthropic", envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://chat.intern-ai.org.cn" },
    kimi:      { runtime: "claude-agent-sdk", label: "Kimi（长文本 128K）", baseUrl: "https://api.moonshot.cn/anthropic", envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://platform.moonshot.cn" },
    openrouter:{ runtime: "claude-agent-sdk", label: "OpenRouter（一个 Key 用所有模型）", baseUrl: "https://openrouter.ai/api/v1", envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://openrouter.ai" },
    claude:    { runtime: "claude-agent-sdk", label: "Claude Sonnet/Opus（海外，需 API Key）", envKey: "ANTHROPIC_API_KEY", signupUrl: "https://console.anthropic.com" },
    "claude-code": { runtime: "claude-code-cli", label: "Claude Code CLI（需 Max 订阅）", requiresAuth: "claude" },
    codex:     { runtime: "codex-sdk", label: "GPT-5.4 Codex（海外，需 codex auth login）", requiresAuth: "codex" },
  };

  // Two-step interactive picker: runtime first, then provider+key (only when
  // the runtime needs an Anthropic-compatible API key).
  // Each step has descriptive guidance so users know which to pick when.
  // Inline description into name to avoid inquirer/prompts version skew with
  // the `description` field (Vincent saw "_0x... is not a function" with .57).
  const RUNTIME_CHOICES = [
    { value: "claude-agent-sdk", name: "claude-agent-sdk  — 推荐: 连任何 Anthropic 兼容 API (MiniMax/DeepSeek/GLM/Kimi/Claude), 只需 API Key" },
    { value: "codex-sdk",        name: "codex-sdk         — GPT-5 / o3 (海外, 需先 codex auth login)" },
    { value: "claude-code-cli",  name: "claude-code-cli   — Claude Code 订阅用户 (需 Claude Pro/Team/Max + claude auth login)" },
  ];

  const PROVIDER_CHOICES = [
    { key: "minimax",    label: "MiniMax — 国内直连，低成本，速度快",        baseUrl: "https://api.minimaxi.com/anthropic",     signupUrl: "https://platform.minimaxi.com" },
    { key: "deepseek",   label: "DeepSeek — 代码 + 推理性价比高",            baseUrl: "https://api.deepseek.com/anthropic",     signupUrl: "https://platform.deepseek.com" },
    { key: "glm",        label: "GLM 智谱 — 中文理解强",                     baseUrl: "https://open.bigmodel.cn/anthropic",     signupUrl: "https://open.bigmodel.cn" },
    { key: "kimi",       label: "Kimi — 长文本 128K",                       baseUrl: "https://api.moonshot.cn/anthropic",      signupUrl: "https://platform.moonshot.cn" },
    { key: "intern",     label: "书生 Intern — 科学推理",                    baseUrl: "https://chat.intern-ai.org.cn/anthropic", signupUrl: "https://chat.intern-ai.org.cn" },
    { key: "openrouter", label: "OpenRouter — 一个 Key 用所有模型",          baseUrl: "https://openrouter.ai/api/v1",           signupUrl: "https://openrouter.ai" },
    { key: "claude",     label: "Claude Sonnet/Opus — 海外，官方 API Key",    baseUrl: "",                                        signupUrl: "https://console.anthropic.com" },
    { key: "custom",     label: "自定义 — 输入你的 baseUrl",                  baseUrl: "",                                        signupUrl: "" },
  ];

  // Step 1: pick runtime if not supplied via --runtime.
  if (!opts.runtime && process.stdin.isTTY) {
    try {
      const { select: sel } = await import("@inquirer/prompts");
      opts.runtime = await sel({
        message: "选择 runtime:",
        choices: RUNTIME_CHOICES,
      });
    } catch (e: any) {
      console.log(`[anet] ⚠ Runtime selector failed: ${e?.message || e}`);
      console.log(`[anet]   Defaulting to claude-agent-sdk. To pick explicitly:`);
      console.log(`[anet]   anet node create ${id} --runtime claude-agent-sdk|codex-sdk|claude-code-cli`);
      // Critical: also set opts.runtime so step 2 (provider+key prompt) still
      // runs. Without this the user gets a node with claude-agent-sdk runtime
      // but no API key, every task fails.
      opts.runtime = "claude-agent-sdk";
    }
  }

  // Step 2: provider + key, only for claude-agent-sdk and only if we don't already have a key.
  // Also skip when caller already supplied an Anthropic credential via --env on
  // the command line — demo subcommands (debate / socialmedia) drive
  // createCommand programmatically and pre-fill the key, so prompting again
  // would block the run.
  const envFlagHasAuth = (opts._envs || []).some((e: string) =>
    e.startsWith("ANTHROPIC_AUTH_TOKEN=") || e.startsWith("ANTHROPIC_API_KEY=")
  );
  const wantsProviderPrompt = opts.runtime === "claude-agent-sdk"
    && !process.env.ANTHROPIC_AUTH_TOKEN
    && !process.env.ANTHROPIC_API_KEY
    && !envFlagHasAuth;
  if (wantsProviderPrompt && process.stdin.isTTY) {
    try {
      const { select: sel } = await import("@inquirer/prompts");
      const provider = await sel({
        message: "选择模型 provider:",
        choices: PROVIDER_CHOICES.map(p => ({ value: p.key, name: p.label })),
      });
      const cfg = PROVIDER_CHOICES.find(p => p.key === provider)!;
      let baseUrl = cfg.baseUrl;
      if (cfg.key === "custom") {
        baseUrl = await ask("baseUrl (e.g. https://your-host/anthropic)") || "";
      }
      if (cfg.signupUrl) {
        console.log(`[anet] 没有 Key？去 ${cfg.signupUrl} 注册并创建 API Key`);
      }
      const key = await ask(`输入 API Key (${cfg.key})`);
      const envKey = cfg.key === "claude" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
      opts._envs = opts._envs || [];
      if (baseUrl) opts._envs.push(`ANTHROPIC_BASE_URL=${baseUrl}`);
      if (key) opts._envs.push(`${envKey}=${key}`);
    } catch (e: any) {
      console.log(`[anet] ⚠ Provider selector failed: ${e?.message || e}`);
    }
  } else if (opts.runtime === "codex-sdk") {
    console.log("[anet] 请确保已执行: codex auth login");
  } else if (opts.runtime === "claude-code-cli") {
    console.log("[anet] 请确保已安装 Claude Code CLI 并登录: claude auth login");
  }

  // Interactive network selection (if user has multiple writable networks and no --network specified)
  if (!opts.network && gc.token && gc.hub && process.stdin.isTTY) {
    try {
      const nets = await fetch(`${gc.hub}/api/networks`, {
        headers: { Authorization: `Bearer ${gc.token}` },
      }).then(r => r.json() as any);
      const writable = (nets.networks || []).filter((n: any) => ["owner", "admin", "member"].includes(n.member_role));
      if (writable.length > 1) {
        // Multiple writable networks → interactive select
        try {
          const { select: sel } = await import("@inquirer/prompts");
          const roleIcon: Record<string, string> = { owner: "⭐", admin: "🔧", member: "👤" };
          const chosen = await sel({
            message: "选择网络:",
            choices: writable.map((n: any) => ({
              value: n.network_id,
              name: `${roleIcon[n.member_role] || " "} ${n.network_name} (${n.member_role})`,
            })),
            default: gc.network_id,
          });
          gc.network_id = chosen;
          gc.network_name = writable.find((n: any) => n.network_id === chosen)?.network_name;
          saveGlobal(gc);
        } catch {
          // inquirer not available, use current network
        }
      } else if (writable.length === 1 && !gc.network_id) {
        gc.network_id = writable[0].network_id;
        gc.network_name = writable[0].network_name;
        saveGlobal(gc);
      }
    } catch {}
  }

  const profile = createProfileFromOpts(id, opts);

  // Request a network token (ntok_) for this node — agent-node REQUIRES ntok_ for SSE.
  // No silent fallback to utok_; that just defers the failure to runtime.
  if (!gc.token) {
    console.error(`[anet] ❌ Not logged in. Run: anet login   (or: anet register)`);
    process.exit(1);
  }
  if (!gc.network_id) {
    console.error(`[anet] ❌ No network selected. Run: anet login`);
    process.exit(1);
  }
  let nodeTokenRes: any;
  try {
    nodeTokenRes = await fetch(`${gc.hub}/api/auth/node-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gc.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ network_id: gc.network_id, node_name: id }),
    }).then(r => r.json() as any);
  } catch (e: any) {
    console.error(`[anet] ❌ Could not reach hub: ${e.message}`);
    console.error(`[anet]    Hub: ${gc.hub} — is it running? Try: anet hub start`);
    process.exit(1);
  }
  if (!nodeTokenRes.ok || !nodeTokenRes.token) {
    if (nodeTokenRes.error?.includes("invalid token")) {
      console.error(`[anet] ❌ Your login session has expired (server rotated the token).`);
      console.error(`[anet]    Run: anet login   then re-run: anet node create ${id}`);
    } else {
      console.error(`[anet] ❌ Could not create node token: ${nodeTokenRes.error || "unknown"}`);
    }
    process.exit(1);
  }
  profile.token = nodeTokenRes.token;  // ntok_ written into node config

  saveCreatedNode(id, profile);
  checkRuntimeDependency(normalizeRuntime(profile), "create");

  const netLabel = gc.network_name || gc.network_id || "global";
  console.log(`\n[anet] Created node "${id}" (${normalizeRuntime(profile)}) in network "${netLabel}"`);
  if (profile.token?.startsWith("ntok_")) {
    console.log(`[anet] Network token assigned (node-level)`);
  }
  if (normalizeRuntime(profile) === "claude-code-cli") {
    printClaudeCodeNotice();
  }
  console.log(`[anet] ⚠ dangerouslySkipPermissions and teammateMode enabled by default.`);
  console.log(`[anet] To disable: edit .anet/nodes/${id}/config.json → flags`);
  console.log(`\nStart: anet node start ${id}`);
  closeRL();
  // Only exit if invoked directly from the CLI (top-level command). When called
  // from demoDebateCommand or other in-process orchestration, just return so
  // the caller can continue creating more nodes.
  if (process.env.ANET_INTERNAL_KEEP_PROCESS !== "1") {
    process.exit(0);
  }
}

// ── interactive prompt helper ──

import { createInterface } from "readline";
let _rl: ReturnType<typeof createInterface> | null = null;
function getRL() {
  if (!_rl) _rl = createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
function closeRL() { if (_rl) { _rl.close(); _rl = null; } }

function ask(question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  return new Promise(resolve => {
    getRL().question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

async function interactiveCreateProfile(id: string): Promise<Profile> {
  const gc = loadGlobal();
  console.log(`\nProfile "${id}" not found. Let's create it:\n`);

  const runtime = await ask("Runtime (claude-code / agent-sdk)", "claude-code") as "claude-code" | "agent-sdk";
  const alias = await ask("Alias", id);
  let model: string | undefined;
  let toolsArr: string[] = [];
  let channels: string[] = [];
  let teammateMode = "";

  if (runtime === "agent-sdk") {
    model = await ask("Model", "MiniMax-M2.7");
    const toolsStr = await ask("Tools (comma-separated)", "Read,Bash,Grep");
    toolsArr = toolsStr.split(",").map(s => s.trim()).filter(Boolean);
  } else {
    const channelsStr = await ask("Channels (comma-separated)", "server:commhub");
    channels = channelsStr.split(",").map(s => s.trim()).filter(Boolean);
    teammateMode = await ask("Teammate mode", "in-process");
  }

  const envStr = await ask("Extra env (K=V, comma-separated, empty to skip)");

  const envMap: Record<string, string> = {};
  if (envStr) {
    for (const e of envStr.split(",")) {
      const eq = e.trim().indexOf("=");
      if (eq > 0) envMap[e.trim().slice(0, eq)] = e.trim().slice(eq + 1);
    }
  }

  const hub = gc.hub; // already validated above

  let profile: Profile = {
    anet_version: "0.0.23",
    node_id: generateNodeId(),
    node_name: alias,
    name: alias,
    alias,
    hub,
    runtime,
    ...(model ? { model } : {}),
    ...(toolsArr.length ? { tools: toolsArr } : {}),
    channels,
    env: envMap,
    flags: {
      dangerouslySkipPermissions: true,
      ...(teammateMode ? { teammateMode } : {}),
    },
  };

  profile = await ensureNodeToken(profile, id);
  saveProfile(id, profile);
  closeRL();
  console.log(`\n✅ Profile "${id}" saved\n`);
  return profile;
}

// ── ensure .mcp.json has commhub server ──

function ensureMcpJson(profile: Profile) {
  if (normalizeRuntime(profile) !== "claude-code-cli") return;
  if (!profile.channels?.some(ch => ch.includes("commhub"))) return;

  const mcpJsonPath = join(process.cwd(), ".mcp.json");
  let mcpConfig: any = {};
  if (existsSync(mcpJsonPath)) try { mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf-8")); } catch {}

  // Always update .anet/node-server.js from npm package (keep in sync)
  const anetDir = join(process.cwd(), ".anet");
  const serverTs = join(anetDir, "node-server.js");
  // 查找 node-server.ts 源文件——混淆后路径可能变，多个候选
  const selfDir = typeof import.meta.url === "string" ? new URL(".", import.meta.url).pathname : __dirname || "";
  const argv1Dir = process.argv[1] ? join(process.argv[1], "..") : "";
  const candidates = [
    // dist/src/node-server.js（npm 包混淆后产物，优先）
    join(selfDir, "..", "src", "node-server.js"),
    join(selfDir, "..", "..", "dist", "src", "node-server.js"),
    join(argv1Dir, "..", "src", "node-server.js"),
    join(argv1Dir, "..", "..", "dist", "src", "node-server.js"),
    // src/node-server.ts（开发环境源码）
    join(selfDir, "..", "..", "src", "node-server.ts"),
    join(selfDir, "..", "src", "node-server.ts"),
    join(selfDir, "src", "node-server.ts"),
    join(argv1Dir, "..", "src", "node-server.ts"),
    join(argv1Dir, "..", "..", "src", "node-server.ts"),
    // npm global install fallback
    ...((() => { try { const root = execSync("npm root -g", { encoding: "utf-8", timeout: 5000 }).trim(); return [join(root, "@sleep2agi", "agent-network", "dist", "src", "node-server.js"), join(root, "@sleep2agi", "agent-network", "src", "node-server.ts")]; } catch { return []; } })()),
  ];
  let found = false;
  for (const p of candidates) {
    if (existsSync(p)) {
      mkdirSync(anetDir, { recursive: true });
      const src = readFileSync(p, "utf-8");
      const dst = existsSync(serverTs) ? readFileSync(serverTs, "utf-8") : "";
      if (src !== dst) {
        writeFileSync(serverTs, src);
        console.log(`[anet] Updated .anet/node-server.js`);
      }
      found = true;
      break;
    }
  }
  if (!found && !existsSync(serverTs)) {
    console.warn(`[anet] ⚠ Cannot find node-server.ts source. CommHub channel may not work.`);
    console.warn(`[anet] Fix: npm install -g @sleep2agi/agent-network@latest`);
  }

  // Ensure .anet/package.json + deps
  const pkgJson = join(anetDir, "package.json");
  if (!existsSync(pkgJson)) {
    mkdirSync(anetDir, { recursive: true });
    writeFileSync(pkgJson, JSON.stringify({
      "private": true,
      "dependencies": { "@modelcontextprotocol/sdk": "^1.12.0" }
    }, null, 2) + "\n");
    try {
      execSync("bun install", { cwd: anetDir, stdio: "pipe" });
    } catch {}
  }

  // 只在没有 commhub 配置时才写 .mcp.json
  // 用户可能手动配了指向开发源码(commhub-channel.ts)，不能覆盖
  mcpConfig.mcpServers = mcpConfig.mcpServers || {};
  const hasCommhub = Object.keys(mcpConfig.mcpServers).some(k => k.includes("commhub"));
  if (!hasCommhub) {
    mcpConfig.mcpServers.commhub = { type: "stdio", command: "bun", args: [".anet/node-server.js"] };
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    console.log(`[anet] .mcp.json: added commhub`);
  }

  // Write .anet/.env (hub URL + token)
  const anetEnvPath = join(anetDir, ".env");
  const token = profile.token || "";
  let envContent = `COMMHUB_URL=${profile.hub || "http://127.0.0.1:9200"}\n`;
  if (token) envContent += `COMMHUB_TOKEN=${token}\n`;
  writeFileSync(anetEnvPath, envContent);

  // Write .mcp.json
  mcpConfig.mcpServers = mcpConfig.mcpServers || {};
  mcpConfig.mcpServers.commhub = { type: "stdio", command: "bun", args: [".anet/node-server.js"] };
  writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
  console.log(`[anet] .mcp.json: added commhub channel server`);
}

// ── launch helper (shared by start + resume) ──

async function launchAgent(id: string, forceNewSession = false) {
  const resolved = resolveNodeRef(id);
  if (!resolved) {
    console.error(`Node "${id}" not found. Create it first: anet node create ${id}`);
    process.exit(1);
  }
  const { id: nodeId, profile } = resolved;

  const runtime = normalizeRuntime(profile);
  const displayName = nodeDisplayName(nodeId, profile);
  const session = profileSession(profile);
  const willResume = !!session && !forceNewSession;
  const label = willResume ? `Resuming session ${session.slice(0, 8)}...` : "Starting new session";
  console.log(`[anet] ${label} for "${displayName}" [${runtime}]...\n`);
  checkRuntimeDependency(runtime, "start");
  assertStartCompatibility(runtime);

  // Auto-configure .mcp.json for commhub channel
  ensureMcpJson(profile);

  // Token already merged in loadProfile: project > global.
  // SSE requires a network-scoped token (ntok_); utok_ leftovers from older
  // versions cause cryptic "SSE 401" loops, so reject them up-front.
  const token = profile.token || "";
  if (!token) {
    console.error(`[anet] ❌ Node config has no token but SSE needs ntok_.`);
    console.error(`[anet]    Run \`anet doctor --fix\` to repair (re-requests ntok_ from hub).`);
    console.error(`[anet]    Or recreate manually:`);
    console.error(`[anet]      anet node delete ${nodeId}`);
    console.error(`[anet]      anet node create ${nodeId}`);
    process.exit(1);
  }
  if (token.startsWith("utok_") || token.startsWith("atok_")) {
    const prefix = token.slice(0, 4);
    console.error(`[anet] ❌ Node config has a ${prefix}_ token but SSE needs ntok_.`);
    console.error(`[anet]    Run \`anet doctor --fix\` to repair (re-requests ntok_ from hub).`);
    console.error(`[anet]    Or recreate manually:`);
    console.error(`[anet]      anet node delete ${nodeId}`);
    console.error(`[anet]      anet node create ${nodeId}`);
    process.exit(1);
  }
  console.log(`[anet] Token: ${token.slice(0, 8)}...`);

  if (runtime === "codex-sdk" || runtime === "claude-agent-sdk" || runtime === "http-api") {
    // spawn agent-node
    const agentArgs = [
      "--config", join(nodesDir(), nodeId, "config.json"),
      "--alias", displayName,
      "--runtime", runtime,
    ];
    if (forceNewSession) agentArgs.push("--new-session", "true");

    const hub = profile.hub || loadGlobal().hub || "";
    const env: NodeJS.ProcessEnv = { ...process.env, ...(token ? { COMMHUB_TOKEN: token } : {}), ...(hub ? { COMMHUB_URL: hub } : {}) };
    for (const [k, v] of Object.entries(profile.env)) {
      env[k] = v.replace(/^~/, home);
    }

    // Try agent-node from PATH, fallback to npx
    let cmd = "agent-node";
    try { execSync("which agent-node", { stdio: "pipe" }); } catch {
      cmd = "npx -y @sleep2agi/agent-node@preview";
    }
    const child = spawn(cmd, agentArgs, { env, stdio: "inherit", shell: true });
    const pidFile = join(nodesDir(), nodeId, ".pid");
    if (child.pid) writeFileSync(pidFile, String(child.pid));
    child.on("exit", (code) => {
      try { rmSync(pidFile, { force: true }); } catch {}
      process.exit(code || 0);
    });
  } else {
    // spawn claude CLI
    const env: NodeJS.ProcessEnv = { ...process.env, COMMHUB_ALIAS: profile.alias, ...(token ? { COMMHUB_TOKEN: token } : {}) };
    for (const [k, v] of Object.entries(profile.env)) {
      env[k] = v.replace(/^~/, home);
    }
    if (profile.channels.includes("telegram")) {
      env.TELEGRAM_STATE_DIR = join(nodesDir(), nodeId, "channels", "telegram");
    }

    const claudeArgs: string[] = [];
    if (profile.flags.dangerouslySkipPermissions) claudeArgs.push("--dangerously-skip-permissions");
    for (const ch of profile.channels) {
      if (ch.startsWith("server:")) {
        claudeArgs.push("--dangerously-load-development-channels", ch);
      } else if (ch === "telegram") {
        claudeArgs.push("--channels", "plugin:telegram@claude-plugins-official");
      } else {
        claudeArgs.push("--channels", ch);
      }
    }
    if (profile.flags.teammateMode) claudeArgs.push("--teammate-mode", profile.flags.teammateMode);

    if (willResume) {
      claudeArgs.push("--resume", session);
    }

    claudeArgs.push("-n", displayName);

    const child = spawn("claude", claudeArgs, { env, stdio: "inherit", shell: true });
    const pidFile = join(nodesDir(), nodeId, ".pid");
    if (child.pid) writeFileSync(pidFile, String(child.pid));
    child.on("exit", (code) => {
      try { rmSync(pidFile, { force: true }); } catch {}
      if (!willResume || forceNewSession) {
        console.log(`\n[anet] Tip: bind this Claude Code session with:`);
        console.log(`[anet]   anet session ls`);
        console.log(`[anet]   anet node resume ${nodeId} --session <session-id>`);
        if (forceNewSession && session) {
          console.log(`[anet] Next "anet node start ${nodeId}" will still resume ${session.slice(0, 8)}... until you rebind.`);
        }
      }
      process.exit(code || 0);
    });
  }
}

// ── start (new session) ──

async function startCommand() {
  const id = args[1];
  if (!id) { showProfiles("start"); return; }
  await launchAgent(id, !!parseOpts()["new-session"]);
}

// ── resume (continue session) ──

async function resumeCommand() {
  const ref = args[1];
  if (!ref) {
    console.error("Usage: anet node resume <node-name> --session <session-id>");
    console.error("Daily start/resume: anet node start <node-name>");
    return;
  }

  const resolved = resolveNodeRef(ref);
  let nodeId = resolved?.id || ref;
  let profile = resolved?.profile || null;
  const opts = parseOpts();
  const sessionId = opts.session;

  if (!sessionId) {
    console.warn(`[deprecated] anet node resume <node-name> without --session is now anet node start <node-name>.`);
    await launchAgent(nodeId, false);
    return;
  }

  if (!resolved) validateNodeName(nodeId);
  if (!profile) {
    const createOpts = { ...opts, session: sessionId, runtime: opts.runtime || "claude-code-cli" } as unknown as ReturnType<typeof parseOpts>;
    profile = await ensureNodeToken(createProfileFromOpts(nodeId, createOpts), nodeId);
    saveProfile(nodeId, profile);
    console.log(`[anet] Created node "${nodeId}"`);
  } else {
    const existing = profileSession(profile);
    if (existing && existing !== sessionId && opts.yes !== "true") {
      const answer = await ask(`[anet] ${nodeId} already has session ${existing.slice(0, 8)}..., overwrite? (y/n)`, "n");
      closeRL();
      if (!/^y(es)?$/i.test(answer)) {
        console.log("[anet] Session unchanged.");
        return;
      }
    }
    const stored = loadStoredProfile(nodeId) || profile;
    stored.session = sessionId;
    await ensureNodeToken(stored, nodeId);
    saveProfile(nodeId, stored);
  }

  console.log(`[anet] Saved session ${sessionId.slice(0, 8)}... to .anet/nodes/${nodeId}/config.json\n`);
  await launchAgent(nodeId, false);
}

function showProfiles(cmd: string) {
  const ids = listProfileIds();
  if (ids.length === 0) {
    console.log("No nodes. Run: anet node create <node-name>");
    return;
  }
  console.log("\nNodes:\n");
  for (const id of ids) {
    const p = loadProfile(id);
    const displayName = nodeDisplayName(id, p);
    console.log(`  ${id} (${displayName})  node_id=${p?.node_id || "-"}  [${normalizeRuntime(p || undefined)}]  session=${p ? profileSession(p).slice(0, 8) || "-" : "-"}  channels=[${p?.channels.join(", ")}]`);
  }
  console.log(`\nanet ${cmd} <node-id|node-name>\n`);
}

// ── ls ──

async function lsCommand() {
  const ids = listProfileIds();

  // Fetch CommHub status first
  const gc = loadGlobal();
  let networkSessions: any[] = [];
  let sseSessions: Record<string, number> = {};

  if (gc.hub) {
    try {
      const [statusRes, healthRes] = await Promise.all([
        fetch(`${gc.hub}/api/status`, { headers: authHeaders() }).then(r => r.json() as any),
        fetch(`${gc.hub}/health`, { headers: authHeaders() }).then(r => r.json() as any),
      ]);
      networkSessions = statusRes.sessions || [];
      sseSessions = healthRes.sse_sessions || {};
    } catch {}
  }

  // Nodes with network status
  if (ids.length > 0) {
    console.log("\nNodes:\n");
    console.log("  NAME                 RUNTIME        STATUS    SSE  SESSION");
    console.log("  ──────────────────── ────────────── ──────── ──── ────────");
    for (const id of ids) {
      const p = loadProfile(id);
      const displayName = nodeDisplayName(id, p);
      const runtime = normalizeRuntime(p || undefined);
      const session = p ? profileSession(p).slice(0, 8) || "-" : "-";

      // Check PID
      const pidFile = join(nodesDir(), id, ".pid");
      let localAlive = false;
      if (existsSync(pidFile)) {
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
        try { process.kill(pid, 0); localAlive = true; } catch {}
      }

      // Match with CommHub
      const ns: any = networkSessions.find((n: any) => n.alias === displayName || n.node_id === p?.node_id);
      const serverStatus = ns ? ns.status : (localAlive ? "starting" : "offline");
      const sseConnected = sseSessions[displayName] ? "●" : "○";

      const statusIcon = serverStatus === "idle" ? "idle" :
                         serverStatus === "working" ? "working" :
                         serverStatus === "offline" ? "offline" :
                         serverStatus;
      console.log(`  ${displayName.padEnd(20)} ${runtime.padEnd(14)} ${statusIcon.padEnd(8)} ${sseConnected.padEnd(4)} ${session}`);
    }
    console.log();
  }

  // Local sessions
  const cwd = process.cwd();
  const sessionsDir = join(home, ".claude", "sessions");
  const localSessions: any[] = [];

  if (existsSync(sessionsDir)) {
    for (const f of readdirSync(sessionsDir).filter(f => f.endsWith(".json"))) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8"));
        if (data.cwd === cwd) localSessions.push(data);
      } catch {}
    }
  }

  if (localSessions.length === 0 && ids.length === 0) {
    console.log("No sessions or nodes in this directory.");
    console.log("Get started: anet init\n");
    return;
  }

  // Display sessions
  if (localSessions.length > 0) {
    console.log(`Sessions (${cwd}):\n`);
    console.log("  SESSION              PID     NETWORK");
    console.log("  ──────────────────── ─────── ─────────────────────");

    for (const s of localSessions) {
      const shortId = s.sessionId.slice(0, 18);
      let alive = false;
      try { process.kill(s.pid, 0); alive = true; } catch {}

      // Find in CommHub
      let network = "(not in network)";
      const projectKey = cwd.replace(/\//g, "-");
      const aliasEnvPath = join(home, ".claude", "channels", "commhub", projectKey, ".env");
      if (existsSync(aliasEnvPath)) {
        const content = readFileSync(aliasEnvPath, "utf-8");
        const match = content.match(/COMMHUB_ALIAS=(.+)/);
        if (match) {
          const alias = match[1].trim();
          const ns: any = networkSessions.find((n: any) => n.alias === alias);
          const sse = sseSessions[alias] ? "●" : "○";
          network = ns ? `${alias} ${ns.status} ${sse}` : `${alias} (not registered)`;
        }
      }

      console.log(`  ${shortId}  ${(alive ? `${s.pid}` : `${s.pid}✕`).padEnd(7)} ${network}`);
    }
    console.log();
  }
}

// ── run ──

async function runCommand() {
  const gc = loadGlobal();
  const opts = parseOpts();
  const hub = process.env.COMMHUB_URL || opts.hub || gc.hub || "http://127.0.0.1:9200";
  const alias = process.env.COMMHUB_ALIAS || opts.alias;

  if (!alias) { console.error("Error: --alias required"); process.exit(1); }

  const { CommHub } = await import("../src/client.js");
  const hub2 = new CommHub({ url: hub, alias });
  hub2.on("task", async (msg: any) => {
    console.log(`[${alias}] ← ${msg.from_session}: ${msg.content.slice(0, 100)}`);
    await hub2.send(msg.from_session, `[${alias}] 收到: ${msg.content.slice(0, 200)}`);
  });
  hub2.on("connected", () => console.log(`[${alias}] Connected`));
  hub2.on("disconnected", () => console.log(`[${alias}] Reconnecting...`));
  process.on("SIGINT", () => hub2.disconnect().then(() => process.exit(0)));
  console.log(`[${alias}] Listening on ${hub}`);
}

// ── server ──

async function serverCommand() {
  const sub = args[1];
  if (sub === "start" || sub === "local" || !sub) {
    // anet hub start — start the CommHub Server only.
    // Auth (register/login) is NOT done here; user runs `anet register` or `anet login`
    // after this. Keeps token state managed in one place and avoids rotation
    // out-of-sync between hub-start and the saved global config.
    const opts = parseOpts();
    const port = opts.port || "9200";
    // --host / --ip flag (or HOST env) controls the bind address. Default to
    // 127.0.0.1 (loopback only) for safety; users running on a remote box
    // who want LAN access pass --ip 0.0.0.0 explicitly.
    const host = opts.ip || opts.host || process.env.HOST || "127.0.0.1";
    const sc = loadServerConfig();
    const token = opts.token || sc.token || randomUUID().replace(/-/g, "");
    const gc = loadGlobal();
    // Health checks always go to loopback; the saved hub URL also stays on
    // loopback for the local machine. LAN clients use the LAN URL printed
    // below in the next-steps banner.
    const hubUrl = `http://127.0.0.1:${port}`;

    console.log(`\n  anet hub start\n`);

    // Check if server already running
    let serverAlreadyRunning = false;
    let child: any = null;
    try {
      const h = await fetch(`${hubUrl}/health`).then(r => r.json() as any);
      if (h.ok) {
        serverAlreadyRunning = true;
        console.log(`  ✅ CommHub Server already running on ${hubUrl}`);
      }
    } catch {}

    if (!serverAlreadyRunning) {
      console.log(`  Starting CommHub Server on port ${port} (bind ${host})...`);
      const env: Record<string, string> = {
        ...process.env as any,
        PORT: port,
        HOST: host,
        COMMHUB_AUTH_TOKEN: token,
      };
      // Pin to a specific version to defeat bunx caching of older versions.
      // Bump this whenever commhub-server is updated. (bunx with @preview will
      // cache the first-resolved version and may not refetch even when the
      // tag points at something newer; specifying the exact version forces
      // a fresh install whenever this string changes.)
      const PINNED_SERVER_VERSION = "0.7.0-preview.0";
      child = spawn("bunx", ["--bun", `@sleep2agi/commhub-server@${PINNED_SERVER_VERSION}`], { env, stdio: "pipe", shell: true });

      // Wait for server with polling
      let ready = false;
      let serverVersion = "";
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const h = await fetch(`${hubUrl}/health`).then(r => r.json() as any);
          if (h.ok) { ready = true; serverVersion = h.version || ""; break; }
        } catch {}
      }
      if (!ready) {
        // commhub-server is TypeScript w/ a bun shebang; it requires Bun.
        // Most Node-only systems hit this exact failure.
        let bunInstalled = false;
        try { execSync("command -v bun", { stdio: "pipe" }); bunInstalled = true; } catch {}
        if (!bunInstalled) {
          console.error(`  ❌ Bun is required to run commhub-server. Install with:`);
          console.error(`     curl -fsSL https://bun.sh/install | bash`);
          console.error(`     # then re-run: anet hub start`);
        } else {
          console.error(`  ❌ Server failed to start. Check the bunx output above for the real error.`);
        }
        child?.kill();
        return;
      }
      console.log(`  ✅ Server running on ${hubUrl} (commhub-server v${serverVersion || "?"})`);
      // Warn loudly if user is on a known-broken old version (cache poisoning).
      if (serverVersion && serverVersion.startsWith("0.4.")) {
        console.error(`\n  ⚠️  Old commhub-server v${serverVersion} detected — task routing will not work.`);
        console.error(`     Clear caches and restart:`);
        console.error(`       pkill -f commhub-server`);
        console.error(`       bun pm cache rm  ;  rm -rf ~/.bun/install/cache/@sleep2agi`);
        console.error(`       npm cache clean --force`);
        console.error(`       anet hub start\n`);
      }
    }

    // Save hub URL + server token. Do NOT touch gc.token here — that's owned by login.
    gc.hub = hubUrl;
    saveServerConfig({ port, host, token });
    saveGlobal(gc);

    // Wait for API to fully boot (the /api/auth/* endpoints may not respond
    // immediately even after /health goes ok).
    for (let i = 0; i < 10; i++) {
      try {
        const r = await fetch(`${hubUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "__probe__", password: "______" }),
        });
        if (r.headers.get("content-type")?.includes("json")) break;
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }

    // Bootstrap an admin account without shipping default credentials.
    // Interactive users may enter credentials; non-interactive runs get a
    // one-time random password printed in this banner only.
    let defaultUser = opts.username || opts.user || "";
    let defaultPass = opts.password || opts.pass || "";
    if ((!defaultUser || !defaultPass) && process.stdin.isTTY) {
      if (!defaultUser) defaultUser = await ask("Admin username");
      if (!defaultPass) defaultPass = await ask("Admin password (leave blank to generate)");
    }
    if (!defaultUser) defaultUser = `admin_${randomBytes(3).toString("hex")}`;
    if (!defaultPass) defaultPass = randomBytes(12).toString("base64url");
    let defaultAccountReady = false;
    try {
      const reg = await fetch(`${hubUrl}/api/auth/register`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ username: defaultUser, password: defaultPass }),
      }).then(r => r.json() as any);
      if (reg.ok) {
        defaultAccountReady = true;
        console.log(`  ✅ Admin account created`);
        console.log(`     username: ${defaultUser}`);
        console.log(`     password: ${defaultPass}`);
        console.log(`     Store this password now; it will not be shown again.`);
      } else if (reg.error?.includes("already taken")) {
        defaultAccountReady = true;
        console.log(`  ℹ  Admin account "${defaultUser}" already exists`);
      } else {
        console.log(`  ⚠  Could not bootstrap admin account: ${reg.error}`);
      }
    } catch (e: any) {
      console.log(`  ⚠  Admin account bootstrap skipped: ${e.message}`);
    }

    // Verify existing user token (if any) is still valid; if not, drop it so the
    // user gets a clear "please login" prompt instead of silent staleness.
    let havValidUser = false;
    if (gc.token && gc.token.startsWith("utok_")) {
      try {
        const me = await fetch(`${hubUrl}/api/auth/me`, {
          headers: { Authorization: `Bearer ${gc.token}` },
        }).then(r => r.json() as any);
        if (me.ok) {
          havValidUser = true;
          console.log(`  ✅ Logged in as "${me.user.username}" (existing session)`);
        }
      } catch {}
      if (!havValidUser) {
        console.log(`  ⚠  Saved token is no longer valid. Run: anet login`);
        delete gc.token;
        delete gc.user;
        saveGlobal(gc);
      }
    }

    // Pick first non-loopback IPv4 so other machines on the LAN know how to reach us.
    let lanIp = "";
    try {
      const nets = (await import("os")).networkInterfaces();
      for (const list of Object.values(nets)) {
        for (const n of list || []) {
          if (n.family === "IPv4" && !n.internal && !lanIp) lanIp = n.address;
        }
      }
    } catch {}
    const lanUrl = lanIp ? `http://${lanIp}:${port}` : "";

    console.log(`\n  Server: ${hubUrl}${lanUrl ? `   (LAN: ${lanUrl})` : ""}\n`);

    const loginHint = defaultAccountReady
      ? `anet login --username ${defaultUser} --password ${defaultPass}`
      : `anet login`;

    if (havValidUser) {
      console.log(`  This machine — already logged in. Next:`);
      console.log(`    anet node create my-agent`);
      console.log(`    anet node start my-agent\n`);
    } else {
      console.log(`  This machine — login then create a node:`);
      console.log(`    ${loginHint}`);
      console.log(`    anet node create my-agent`);
      console.log(`    anet node start my-agent\n`);
    }

    const acceptsLan = host === "0.0.0.0" || host === "::" || (host !== "127.0.0.1" && host !== "localhost");
    if (lanUrl && acceptsLan) {
      console.log(`  Other machines connecting to this hub:`);
      console.log(`    anet init --hub ${lanUrl}`);
      console.log(`    ${loginHint}`);
      console.log(`    anet node create my-agent\n`);
    } else if (lanUrl) {
      console.log(`  LAN access: restart with --host 0.0.0.0, then other machines can use ${lanUrl}\n`);
    }

    console.log(`  Start fresh (wipe everything — local SQLite + tokens + nodes):`);
    console.log(`    # 1. stop the hub (Ctrl+C this process)`);
    console.log(`    # 2. wipe state on this machine:`);
    console.log(`    rm -rf ~/.commhub ~/.anet ./.anet`);
    console.log(`    # 3. anet hub start  again\n`);

    if (child) {
      // Forward server output
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
      child.on("exit", (code: number) => process.exit(code || 0));
      process.on("SIGINT", () => { child.kill(); process.exit(0); });
    }

  } else if (sub === "config") {
    // anet server config — 显示/设置 server 配置
    const opts = parseOpts();
    const sc = loadServerConfig();
    if (opts.port) sc.port = opts.port;
    if (opts.host) sc.host = opts.host;
    if (opts.token) sc.token = opts.token;

    if (opts.port || opts.host || opts.token) {
      saveServerConfig(sc);
      console.log(`Server config saved: ${serverConfigPath()}`);
    }
    console.log(JSON.stringify(sc, null, 2));

  } else if (sub === "dashboard" || sub === "dash") {
    // anet hub dashboard — start Dashboard UI
    const opts = parseOpts();
    const gc = loadGlobal();
    const hubUrl = gc.hub || "http://127.0.0.1:9200";
    const dashPort = opts.port || "3000";
    // --host / --ip for LAN access; defaults to 127.0.0.1.
    const dashHost = opts.ip || opts.host || process.env.HOSTNAME || "127.0.0.1";

    console.log(`[anet] Starting Dashboard on ${dashHost}:${dashPort}...`);
    console.log(`[anet] Connecting to CommHub: ${hubUrl}`);

    const env: Record<string, string> = {
      ...process.env as any,
      PORT: dashPort,
      HOSTNAME: dashHost,
      NEXT_PUBLIC_COMMHUB_URL: hubUrl,
      COMMHUB_URL: hubUrl,
    };

    // Try npx first
    // Pin Dashboard version. Bump whenever the Dashboard package is updated.
    const PINNED_DASHBOARD_VERSION = "0.3.3-preview.0";
    const dashChild = spawn("npx", ["-y", `@sleep2agi/agent-network-dashboard@${PINNED_DASHBOARD_VERSION}`], { env, stdio: "inherit", shell: true });
    dashChild.on("error", () => {
      console.error(`[anet] Dashboard package not found. Install manually:`);
      console.error(`  npx @sleep2agi/agent-network-dashboard`);
    });
    dashChild.on("exit", (code) => process.exit(code || 0));
    process.on("SIGINT", () => { dashChild.kill(); process.exit(0); });

  } else {
    console.log(`
anet hub <command>

  start [options]    Start CommHub Server (bootstraps admin account; login separately)
  dashboard          Start Dashboard UI
  config [options]   Show/set server config

Options:
  --port <port>      Port (default: 9200)
  --host <host>      Bind address (default: 127.0.0.1)
  --token <token>    Auth token

Options:
  --port <port>      Port (default: 9200 for server, 3000 for dashboard)
  --username <user>  Bootstrap admin username
  --password <pass>  Bootstrap admin password (random if omitted)

Example:
  anet hub start                     # Start server + bootstrap admin account
  anet hub dashboard                 # Start Dashboard UI
  anet hub start --host 0.0.0.0      # Allow LAN agents
  anet hub start --port 8080         # Custom port
  anet hub config                    # Show config
`);
  }
}

// ── import ──

async function importCommand() {
  const gc = loadGlobal();
  const opts = parseOpts();
  const hub = opts.hub || gc.hub;
  if (!hub) { console.error("Run 'anet init' first"); process.exit(1); }

  // Fetch all sessions from CommHub
  let sessions: any[] = [];
  try {
    const res = await fetch(`${hub}/api/status`, { headers: authHeaders() });
    const data = await res.json() as any;
    sessions = data.sessions || [];
  } catch (e: any) {
    console.error(`Cannot reach ${hub}: ${e.message}`);
    process.exit(1);
  }

  if (sessions.length === 0) { console.log("No sessions in CommHub."); return; }

  // Filter: only claude-code agents with project_dir
  const claudeSessions = sessions.filter((s: any) => s.agent === "claude-code" && s.project_dir);
  if (claudeSessions.length === 0) { console.log("No claude-code sessions found."); return; }

  const targetAlias = args[1]; // optional: anet import 指挥室
  const toImport = targetAlias
    ? claudeSessions.filter((s: any) => s.alias === targetAlias)
    : claudeSessions;

  if (toImport.length === 0) { console.log(`No session found for "${targetAlias}".`); return; }

  let created = 0;
  for (const s of toImport) {
    const projectDir = s.project_dir;
    const nodeDir = join(projectDir, ".anet", "nodes", s.alias);
    const configPath = join(nodeDir, "config.json");

    if (existsSync(configPath)) {
      console.log(`  ⏭  ${s.alias} — already exists (${projectDir})`);
      continue;
    }

    // Skip if project_dir doesn't exist on this machine
    if (!existsSync(projectDir)) {
      console.log(`  ⚠  ${s.alias} — project_dir not found: ${projectDir}`);
      continue;
    }

    const config: Profile = {
      anet_version: "0.1.0",
      node_id: generateNodeId(),
      node_name: s.alias,
      runtime: "claude-code-cli",
      channels: ["server:commhub"],
      env: {},
      flags: { dangerouslySkipPermissions: true, teammateMode: "in-process" },
      session: s.resume_id,
    };

    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      anet_version: config.anet_version,
      node_id: config.node_id,
      node_name: config.node_name,
      runtime: config.runtime,
      channels: config.channels,
      env: config.env,
      flags: config.flags,
      session: config.session,
    }, null, 2) + "\n");
    console.log(`  ✅ ${s.alias} → ${projectDir}/.anet/nodes/${s.alias}/config.json`);
    created++;
  }

  console.log(`\nImported ${created} session(s). Use: cd <project> && anet node resume <alias>`);
}

// ── session ──

function sessionCommand() {
  const sub = args[1];
  if (sub === "ls" || sub === "list" || !sub) {
    // Scan ~/.claude/projects/{project-key}/ for .jsonl files
    const cwd = process.cwd();
    const projectKey = cwd.replace(/\//g, "-");
    const projectDir = join(home, ".claude", "projects", projectKey);

    if (!existsSync(projectDir)) {
      console.log(`No sessions for ${cwd}`);
      return;
    }

    const files = readdirSync(projectDir).filter(f => f.endsWith(".jsonl")).sort((a, b) => {
      const sa = statSync(join(projectDir, a));
      const sb = statSync(join(projectDir, b));
      return sb.mtimeMs - sa.mtimeMs; // newest first
    });

    if (files.length === 0) { console.log("No sessions."); return; }

    console.log(`\nSessions in ${cwd} (${files.length} total):\n`);
    console.log("  SESSION ID                             SIZE      MODIFIED");
    console.log("  ──────────────────────────────────────  ────────  ────────────────");

    for (const f of files) {
      const id = f.replace(".jsonl", "");
      const st = statSync(join(projectDir, f));
      const size = st.size < 1024 ? `${st.size}B` : st.size < 1024 * 1024 ? `${(st.size / 1024).toFixed(0)}KB` : `${(st.size / 1024 / 1024).toFixed(1)}MB`;
      const mtime = st.mtime.toISOString().replace("T", " ").slice(0, 16);
      console.log(`  ${id}  ${size.padStart(8)}  ${mtime}`);
    }
    console.log();
  } else {
    console.log(`
anet session <command>

  ls    List Claude Code sessions in current project
`);
  }
}

async function renameCommand() {
  const fromRef = args[1];
  const newName = args[2];
  if (!fromRef || !newName) {
    console.log(`
anet node rename <node-id|node-name> <new-node-name>
`);
    return;
  }

  validateNodeName(newName);
  const resolved = resolveNodeRef(fromRef);
  if (!resolved) {
    console.error(`Node "${fromRef}" not found.`);
    process.exit(1);
  }

  const existing = resolveNodeRef(newName);
  if (existing && existing.id !== resolved.id) {
    console.error(`Node name "${newName}" already exists.`);
    process.exit(1);
  }

  const oldId = resolved.id;
  const stored = loadStoredProfile(oldId) || resolved.profile;
  stored.node_name = newName;
  stored.alias = newName;
  await ensureNodeToken(stored, oldId);

  const oldDir = join(nodesDir(), oldId);
  const newDir = join(nodesDir(), newName);
  if (oldId !== newName) {
    if (existsSync(newDir)) {
      console.error(`Target directory already exists: .anet/nodes/${newName}`);
      process.exit(1);
    }
    renameSync(oldDir, newDir);
  }

  saveProfile(newName, stored);
  writeLegacyProjectAlias(newName);
  console.log(`[anet] Renamed node "${oldId}" -> "${newName}"`);
  console.log(`[anet] node_id: ${stored.node_id}`);
}

// ── notify server ──

async function notifyServerOffline(profile: Profile, nodeId: string) {
  const gc = loadGlobal();
  const hub = profile.hub || gc.hub;
  if (!hub) return;
  const displayName = nodeDisplayName(nodeId, profile);
  const resumeId = profile.node_id ? `sdk-${profile.node_id}` : `sdk-${displayName}-0`;
  try {
    // MCP call: report_status offline
    await fetch(`${hub}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", ...authHeaders(profile.token || gc.token) },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "anet-cli", version: "1.0" } },
      }),
    });
    await fetch(`${hub}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", ...authHeaders(profile.token || gc.token) },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "report_status", arguments: { resume_id: resumeId, alias: displayName, status: "offline" } },
      }),
    });
  } catch {}
}

// ── stop ──

function stopNode(nodeId: string): boolean {
  const pidFile = join(nodesDir(), nodeId, ".pid");
  if (!existsSync(pidFile)) return false;
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
  if (isNaN(pid)) { rmSync(pidFile, { force: true }); return false; }
  try {
    process.kill(pid, 0); // check alive
    process.kill(pid, "SIGTERM");
    rmSync(pidFile, { force: true });
    return true;
  } catch {
    rmSync(pidFile, { force: true });
    return false;
  }
}

async function stopCommand() {
  const ref = args[1];
  if (!ref) {
    console.log(`
anet node stop <node-id|node-name>

Stop a running agent node.
`);
    return;
  }

  const resolved = resolveNodeRef(ref);
  if (!resolved) {
    console.error(`Node "${ref}" not found.`);
    process.exit(1);
  }

  const displayName = nodeDisplayName(resolved.id, resolved.profile);
  const killed = stopNode(resolved.id);
  // Always notify server — even if PID file missing, server may have stale session
  await notifyServerOffline(resolved.profile, resolved.id);
  if (killed) {
    console.log(`[anet] Stopped "${displayName}" (server notified)`);
  } else {
    console.log(`[anet] "${displayName}" is not running locally (server notified offline)`);
  }
}

// ── delete ──

async function deleteCommand() {
  const ref = args[1];
  if (!ref) {
    console.log(`
anet node delete <node-id|node-name>

Delete a node and its config. Use --force to skip confirmation.
`);
    return;
  }

  const resolved = resolveNodeRef(ref);
  if (!resolved) {
    console.error(`Node "${ref}" not found.`);
    process.exit(1);
  }

  const { id: nodeId, profile } = resolved;
  const displayName = nodeDisplayName(nodeId, profile);
  const opts = parseOpts();

  // Stop if running + notify server
  stopNode(nodeId);
  await notifyServerOffline(profile, nodeId);

  const nodeDir = join(nodesDir(), nodeId);
  if (!existsSync(nodeDir)) {
    console.error(`Node directory not found: ${nodeDir}`);
    process.exit(1);
  }

  if (opts.force !== "true" && opts.yes !== "true") {
    console.log(`[anet] This will delete "${displayName}" (node_id: ${profile.node_id || "-"})`);
    console.log(`[anet]   ${nodeDir}`);
    console.log(`[anet] Run again with --force to confirm.`);
    return;
  }

  rmSync(nodeDir, { recursive: true, force: true });
  console.log(`[anet] Deleted "${displayName}"`);
}

// ── channel ──

async function channelCommand() {
  // anet channel add telegram <node-id> --bot-token xxx --allow xxx
  // anet channel ls [node-id]
  const sub = args[1];
  const opts = parseOpts();

  if (sub === "add") {
    const type = args[2]; // P0: telegram
    const nodeRef = args[3];

    if (!type || !nodeRef) {
      console.log(`
anet channel add <type> <node-id> [options]

Types:  telegram

Options:
  --bot-token <token>   Bot token
  --allow <user-id>     Allow user ID

Example:
  anet channel add telegram 指挥室 --bot-token 123:ABC --allow 7612221352
  anet channel add telegram 指挥室     # 交互式
`);
      return;
    }
    if (type !== "telegram") {
      console.error(`P0 only supports telegram channels. Unsupported type: ${type}`);
      process.exit(1);
    }

    const resolved = resolveNodeRef(nodeRef);
    const nodeId = resolved?.id || nodeRef;
    const profile = resolved?.profile || null;
    if (!profile) {
      console.error(`Node "${nodeRef}" not found. Create it first: anet node create ${nodeRef} --runtime codex-sdk`);
      process.exit(1);
    }
    const storedProfile = loadStoredProfile(nodeId) || profile;

    let botToken = opts["bot-token"];
    let allowId = opts.allow;
    if (!botToken) botToken = await ask(`${type} Bot Token`);
    if (!allowId) allowId = await ask("Allow User ID (发 @userinfobot 获取数字ID)", "7612221352");
    closeRL();

    if (!botToken || !allowId) {
      console.error("Error: bot-token and allow required");
      process.exit(1);
    }

    const channelDir = writeTelegramChannelConfig(nodeId, botToken, allowId);

    attachChannel(storedProfile, "telegram");
    await ensureNodeToken(storedProfile, nodeId);
    saveProfile(nodeId, storedProfile);

    console.log(`\n✅ ${type} channel added to "${nodeDisplayName(nodeId, profile)}"`);
    console.log(`   ${channelDir}/`);
    console.log(`   config.json updated`);

  } else if (sub === "ls") {
    const nodeRef = args[2];
    const resolved = nodeRef ? resolveNodeRef(nodeRef) : null;
    if (nodeRef && !resolved) {
      console.error(`Node "${nodeRef}" not found.`);
      process.exit(1);
    }
    const ids = resolved ? [resolved.id] : listProfileIds();
    let found = false;

    for (const id of ids) {
      const channelsDir = join(nodesDir(), id, "channels");
      if (!existsSync(channelsDir)) continue;
      const types = readdirSync(channelsDir).filter(d => {
        try { return statSync(join(channelsDir, d)).isDirectory(); } catch { return false; }
      });
      if (types.length === 0) continue;
      if (!found) { console.log("\nNode Channels:\n"); found = true; }
      for (const t of types) {
        const accessPath = join(channelsDir, t, "access.json");
        let allow = "";
        if (existsSync(accessPath)) {
          try { allow = JSON.parse(readFileSync(accessPath, "utf-8")).allowFrom?.join(", ") || ""; } catch {}
        }
        const profile = loadProfile(id);
        const label = profile ? `${id} (${nodeDisplayName(id, profile)})` : id;
        console.log(`  ${label.padEnd(20)} ${t.padEnd(12)} allow: ${allow || "(none)"}`);
      }
    }
    if (!found) console.log("No channels. Add one: anet channel add telegram <node-id>");
    console.log();

  } else {
    console.log(`
anet channel <command>

  add <type> <node-id>          Add channel to a node
  ls [node-id]                  List channels

Data: .anet/nodes/<node-id>/channels/<type>/
`);
  }
}

// ── upgrade ──

function printManualAnetUpgrade() {
  console.log("   Run manually after this command exits:");
  console.log("     npm install -g @sleep2agi/agent-network@latest");
  console.log("   Or run in a fresh shell:");
  console.log("     sh -c 'npm install -g @sleep2agi/agent-network@latest && anet -v'");
}

function upgradeCommand() {
  const opts = parseOpts();
  const forkScript = opts["fork-script"];

  console.log("[anet] Upgrade plan\n");
  console.log("1/2 anet (self)");
  console.log("   Automatic self-upgrade is disabled.");
  console.log("   Reason: upgrading the currently running anet process can remove or replace the CLI mid-run.");
  if (forkScript) {
    try {
      const child = spawn(forkScript, [], {
        stdio: "inherit",
        shell: true,
        detached: true,
      });
      child.unref();
      console.log(`   Spawned external upgrade script: ${forkScript}`);
      console.log("   Re-run `anet -v` after the script finishes.");
    } catch (e: any) {
      console.log(`   ⚠ Failed to start external script: ${e.message}`);
      printManualAnetUpgrade();
    }
  } else {
    printManualAnetUpgrade();
  }

  try {
    console.log("\n2/2 agent-node");
    execSync("npm install -g @sleep2agi/agent-node@latest", { stdio: "inherit", shell: "/bin/bash" });
  } catch {
    console.log("   ⚠ Failed to update @sleep2agi/agent-node");
  }

  console.log("\n[anet] Current versions:");
  printVersionReport();
}

// ── Main ──

// ── status (network overview) ──

async function statusCommand() {
  const gc = loadGlobal();
  const hub = gc.hub;
  if (!hub) { console.log("No hub configured. Run: anet init"); return; }

  try {
    const [statusRes, healthRes, tasksRes] = await Promise.all([
      fetch(`${hub}/api/status`, { headers: authHeaders() }).then(r => r.json() as any).catch(() => ({ sessions: [] })),
      fetch(`${hub}/health`, { headers: authHeaders() }).then(r => r.json() as any).catch(() => ({})),
      fetch(`${hub}/api/tasks?limit=10`, { headers: authHeaders() }).then(r => r.json() as any).catch(() => ({ tasks: [] })),
    ]);

    const sessions = statusRes.sessions || [];
    const sse = healthRes.sse_sessions || {};
    const tasks = tasksRes.tasks || [];

    const idle = sessions.filter((s: any) => s.status === "idle");
    const working = sessions.filter((s: any) => s.status === "working");
    const offline = sessions.filter((s: any) => s.status === "offline");

    console.log(`\n  CommHub: ${hub}`);
    console.log(`  Agents: ${idle.length} idle, ${working.length} working, ${offline.length} offline`);
    console.log(`  SSE:    ${Object.keys(sse).length} connected`);
    console.log(`  Tasks:  ${tasks.length} recent\n`);

    if (working.length > 0) {
      console.log("  Working:");
      for (const s of working) {
        console.log(`    ${s.alias.padEnd(16)} ${(s.task || "").slice(0, 60)}`);
      }
      console.log();
    }

    if (tasks.length > 0) {
      console.log("  Recent Tasks:");
      console.log("  STATUS     FROM            TO              CONTENT");
      console.log("  ──────── ─────────────── ─────────────── ────────────────────────");
      for (const t of tasks.slice(0, 10)) {
        const st = (t.status || "?").padEnd(8);
        const from = (t.from_name || "?").padEnd(15);
        const to = (t.to_name || "?").padEnd(15);
        const content = (t.content || "").slice(0, 40);
        console.log(`  ${st} ${from} ${to} ${content}`);
      }
      console.log();
    }
  } catch (e: any) {
    console.error(`Failed to connect to ${hub}: ${e.message}`);
  }
}

// ── tasks (query tasks) ──

async function tasksCommand() {
  const gc = loadGlobal();
  const hub = gc.hub;
  if (!hub) { console.log("No hub configured. Run: anet init"); return; }
  const opts = parseOpts();
  const status = opts.status || args[1];
  const limit = opts.limit || "20";

  try {
    let url = `${hub}/api/tasks?limit=${limit}`;
    if (status) url += `&status=${status}`;
    const res = await fetch(url, { headers: authHeaders() }).then(r => r.json() as any);
    const tasks = res.tasks || [];

    if (tasks.length === 0) {
      console.log("\n  No tasks found.\n");
      return;
    }

    console.log(`\n  Tasks (${tasks.length}):\n`);
    console.log("  STATUS     FROM            TO              AGE      CONTENT");
    console.log("  ──────── ─────────────── ─────────────── ──────── ────────────────────────");
    for (const t of tasks) {
      const st = (t.status || "?").padEnd(8);
      const from = (t.from_name || "?").slice(0, 15).padEnd(15);
      const to = (t.to_name || "?").slice(0, 15).padEnd(15);
      const age = t.created_at ? timeAgo(t.created_at) : "?";
      const content = (t.content || "").slice(0, 40);
      console.log(`  ${st} ${from} ${to} ${age.padEnd(8)} ${content}`);
    }
    console.log(`\n  Filter: anet tasks replied | anet tasks failed | anet tasks --status delivered\n`);
  } catch (e: any) {
    console.error(friendlyError(e));
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr.replace(" ", "T") + "Z").getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

// ── quickstart ──

async function quickstartCommand() {
  console.log(`
╔══════════════════════════════════════════════════╗
║   🚀 anet quickstart — 3 分钟搭建 Agent 网络     ║
╚══════════════════════════════════════════════════╝
`);

  const gc = loadGlobal();
  const qsOpts = parseOpts();

  // Step 1: Hub
  if (!gc.hub) {
    console.log("Step 1/4: CommHub Server");
    console.log("  你需要一个 CommHub Server。两种方式:");
    console.log("  a) 本机启动: 另开终端运行 bunx @sleep2agi/commhub-server");
    console.log("  b) 连接远程: 输入服务器地址");
    console.log();
    const hubUrl = await ask("CommHub URL [http://127.0.0.1:9200]: ") || "http://127.0.0.1:9200";
    gc.hub = hubUrl;
    saveGlobal(gc);
    console.log(`  ✅ Hub: ${hubUrl}\n`);
  } else {
    console.log(`Step 1/4: Hub ✅ ${gc.hub}\n`);
  }

  // Step 1.5: Check server is reachable
  try {
    const health = await fetch(`${gc.hub}/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json() as any).catch(() => null);
    if (!health?.ok) {
      console.log(`  ⚠ Server not reachable at ${gc.hub}`);
      console.log(`  Make sure CommHub is running: bunx @sleep2agi/commhub-server`);
      console.log(`  Or check the URL and try again.\n`);
      return;
    }
    console.log(`  ✅ Server online (v${health.version || "?"})\n`);
  } catch {
    console.log(`  ⚠ Cannot connect to ${gc.hub}. Start server first.\n`);
    return;
  }

  // Step 2: Register/Login
  if (!gc.token || !gc.user) {
    console.log("Step 2/4: 创建账号");
    const username = qsOpts.username || qsOpts.user || await ask("用户名: ");
    const password = qsOpts.password || qsOpts.pass || await ask("密码 (≥6位): ");
    closeRL();
    if (!username || !password) { closeRL(); console.error("需要用户名和密码。用法: anet quickstart --username xxx --password xxx"); return; }

    // Try register first, if exists then login
    let res = await fetch(`${gc.hub}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }).then(r => r.json() as any).catch(() => null);

    if (!res?.ok) {
      // Try login
      res = await fetch(`${gc.hub}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      }).then(r => r.json() as any).catch(() => null);
    }

    if (!res?.ok) { closeRL(); console.error(`  ❌ 失败: ${res?.error || "无法连接"}`); return; }

    gc.token = res.token;
    gc.user = res.user;
    const nets = await fetch(`${gc.hub}/api/networks`, { headers: { Authorization: `Bearer ${res.token}` } }).then(r => r.json() as any).catch(() => ({ networks: [] }));
    if (nets.networks?.length > 0) {
      gc.network_id = nets.networks[0].network_id;
      gc.network_name = nets.networks[0].network_name;
    }
    saveGlobal(gc);
    console.log(`  ✅ 登录成功: ${res.user.username}\n`);
  } else {
    console.log(`Step 2/4: 已登录 ✅ ${gc.user.username}\n`);
  }

  // Step 3: Create agent
  console.log("Step 3/4: 创建你的第一个 Agent");
  const agentName = qsOpts.agent || qsOpts.name || await ask("Agent 名称 [my-agent]: ") || "my-agent";
  closeRL();

  // Check if already exists
  const existing = resolveNodeRef(agentName);
  if (!existing) {
    let runtime = qsOpts.runtime || "codex-sdk";
    // Only show interactive selection if no runtime specified and TTY available
    if (!qsOpts.runtime && process.stdin.isTTY) {
      const runtimes = ["codex-sdk (GPT-5.4)", "http-api (MiniMax/OpenAI)", "claude-agent-sdk (Claude)"];
      console.log("\n  Runtime 选择:");
      runtimes.forEach((r, i) => console.log(`    ${i + 1}) ${r}`));
      try {
        const choice = await (async () => {
          const { select: sel } = await import("@inquirer/prompts");
          return sel({
            message: "选择 Runtime:",
            choices: [
              { value: "codex-sdk", name: "codex-sdk (GPT-5.4) — 推荐" },
              { value: "http-api", name: "http-api (MiniMax/OpenAI 兼容)" },
              { value: "claude-agent-sdk", name: "claude-agent-sdk (Claude Code)" },
            ],
          });
        })();
        runtime = choice;
      } catch {
        // inquirer not available, use default
      }
    } else if (!qsOpts.runtime) {
      console.log(`  Using default runtime: ${runtime}`);
    }

    const createArgs = ["create", agentName, "--runtime", runtime];
    if (runtime === "codex-sdk") createArgs.push("--model", "gpt-5.4");
    args.splice(0, args.length, ...createArgs);
    await createCommand();
  } else {
    console.log(`  ✅ Agent "${agentName}" 已存在\n`);
  }

  // Step 4: Done!
  console.log(`
╔══════════════════════════════════════════════════╗
║   🎉 设置完成！                                   ║
╠══════════════════════════════════════════════════╣
║                                                   ║
║   启动 Agent:  anet node start ${agentName.padEnd(15)}   ║
║   查看状态:    anet status                         ║
║   查看任务:    anet tasks                          ║
║   网络管理:    anet network ls                     ║
║   系统诊断:    anet doctor                         ║
║                                                   ║
╚══════════════════════════════════════════════════╝
`);
}

// ── register ──

async function registerCommand() {
  const gc = loadGlobal();
  const sc = loadServerConfig();
  let hub = gc.hub;

  // Auto-detect local hub
  if (!hub) {
    try {
      const h = await fetch("http://127.0.0.1:9200/health").then(r => r.json() as any);
      if (h.ok) { hub = "http://127.0.0.1:9200"; gc.hub = hub; saveGlobal(gc); console.log(`[anet] 检测到本地 CommHub: ${hub}`); }
    } catch {}
  }
  if (!hub) { console.error("未找到 CommHub Server。请先运行: anet hub start"); return; }

  const opts = parseOpts();
  const username = opts.username || opts.user || await ask("Username: ");
  const password = opts.password || opts.pass || await ask("Password (min 6): ");
  const email = opts.email || ((opts.username || opts.user) ? "" : await ask("Email (optional): "));
  closeRL();

  if (!username || !password) { console.error("Username and password required."); return; }

  // Auto-include server auth token for registration
  const serverToken = sc.token || getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (serverToken) headers["Authorization"] = `Bearer ${serverToken}`;

  try {
    const res = await fetch(`${hub}/api/auth/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username, password, email: email || undefined }),
    }).then(r => r.json() as any);

    if (!res.ok) { console.error(`Registration failed: ${res.error}`); return; }

    // Auto-login
    gc.token = res.token;
    gc.user = res.user;
    const nets = await fetch(`${hub}/api/networks`, { headers: { Authorization: `Bearer ${res.token}` } }).then(r => r.json() as any);
    if (nets.ok && nets.networks?.length > 0) {
      gc.network_id = nets.networks[0].network_id;
      gc.network_name = nets.networks[0].network_name;
    }
    saveGlobal(gc);
    console.log(`[anet] Registered and logged in as ${res.user.username}`);
    if (gc.network_name) console.log(`[anet] Default network: ${gc.network_name}`);
    console.log(`[anet] Token saved to ~/.anet/config.json`);
  } catch (e: any) { console.error(friendlyError(e)); }
}

// ── login/logout/whoami ──

async function loginCommand() {
  const gc = loadGlobal();
  const opts = parseOpts();
  // Accept --hub on the login command directly so scripts (setup-anet.sh)
  // don't have to run a separate `anet init` step. If supplied, persist it
  // to gc.hub so subsequent commands work.
  const hub = opts.hub || gc.hub;
  if (!hub) { console.error("No hub configured. Pass --hub <url> or run 'anet init' first."); return; }
  if (opts.hub && opts.hub !== gc.hub) {
    gc.hub = opts.hub;
    saveGlobal(gc);
  }

  // anet login --token <token>
  if (opts.token) {
    try {
      const res = await fetch(`${hub}/api/auth/me`, { headers: { Authorization: `Bearer ${opts.token}` } }).then(r => r.json() as any);
      if (!res.ok) { console.error(`Invalid token: ${res.error}`); return; }
      gc.token = opts.token;
      gc.user = res.user;
      gc.network_id = res.current_network;
      saveGlobal(gc);
      console.log(`[anet] Logged in as ${res.user.username} (token)`);
      console.log(`[anet] Network: ${res.current_network || "none"}`);
    } catch (e: any) { console.error(friendlyError(e)); }
    return;
  }

  // Interactive login
  const username = opts.username || opts.user || await ask("Username: ");
  const password = opts.password || opts.pass || await ask("Password: ");
  closeRL();

  if (!username || !password) { console.error("Username and password required."); return; }

  try {
    const res = await fetch(`${hub}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }).then(r => r.json() as any);

    if (!res.ok) { console.error(`Login failed: ${res.error}`); return; }

    gc.token = res.token;
    gc.user = res.user;
    console.log(`[anet] Logged in as ${res.user.username}`);

    // Fetch networks and let user choose
    const nets = await fetch(`${hub}/api/networks`, { headers: { Authorization: `Bearer ${res.token}` } }).then(r => r.json() as any);
    const networks = nets.ok ? (nets.networks || []) : [];

    if (networks.length > 1 && process.stdin.isTTY) {
      // Multiple networks → interactive select
      try {
        const { select: sel } = await import("@inquirer/prompts");
        const roleIcon: Record<string, string> = { owner: "⭐", admin: "🔧", member: "👤", viewer: "👁" };
        const chosen = await sel({
          message: "选择网络:",
          choices: networks.map((n: any) => ({
            value: n.network_id,
            name: `${roleIcon[n.member_role] || " "} ${n.network_name} (${n.member_role || "owner"})`,
          })),
        });
        const net = networks.find((n: any) => n.network_id === chosen);
        gc.network_id = chosen;
        gc.network_name = net?.network_name;
      } catch {
        // inquirer not available, use first network
        gc.network_id = networks[0].network_id;
        gc.network_name = networks[0].network_name;
      }
    } else if (networks.length > 0) {
      gc.network_id = networks[0].network_id;
      gc.network_name = networks[0].network_name;
    }

    saveGlobal(gc);
    if (gc.network_name) console.log(`[anet] Network: ${gc.network_name}`);
    console.log(`[anet] Token saved to ~/.anet/config.json`);
  } catch (e: any) { console.error(friendlyError(e)); }
}

function logoutCommand() {
  const gc = loadGlobal();
  delete gc.token;
  delete gc.user;
  delete gc.network_id;
  delete gc.network_name;
  saveGlobal(gc);
  console.log("[anet] Logged out. Token removed.");
}

async function whoamiCommand() {
  const gc = loadGlobal();
  const hub = gc.hub;
  const token = gc.token;
  if (!hub || !token) { console.log("Not logged in. Run: anet login"); return; }

  try {
    const res = await fetch(`${hub}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json() as any);
    if (!res.ok) { console.log("Session expired. Run: anet login"); return; }
    console.log(`\n  User: ${res.user.username} (${res.user.user_id})`);
    console.log(`  Role: ${res.user.role}`);
    console.log(`  Hub:  ${hub}`);
    if (res.networks?.length) {
      console.log(`\n  Networks:`);
      for (const n of res.networks) {
        const current = n.network_id === gc.network_id ? " ← current" : "";
        console.log(`    ${n.network_name} (${n.network_id.slice(0, 12)})${current}`);
      }
    }
    console.log();
  } catch (e: any) { console.error(friendlyError(e)); }
}

// ── network ──

async function networkCommand() {
  const sub = args[1];
  const gc = loadGlobal();
  const hub = gc.hub;
  const token = gc.token;

  if (!hub) { console.error("Run 'anet init' first."); return; }
  if (!token) { console.error("Run 'anet login' first."); return; }

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  if (sub === "create") {
    const name = args[2];
    const opts = parseOpts();
    if (!name) { console.log("Usage: anet network create <name> [--description <desc>]"); return; }
    try {
      const res = await fetch(`${hub}/api/networks`, {
        method: "POST", headers,
        body: JSON.stringify({ name, description: opts.description }),
      }).then(r => r.json() as any);
      if (res.ok) {
        console.log(`[anet] Network "${name}" created (${res.network_id})`);
      } else {
        console.error(`Failed: ${res.error}`);
      }
    } catch (e: any) { console.error(friendlyError(e)); }
    return;
  }

  if (sub === "ls" || sub === "list" || !sub) {
    try {
      const res = await fetch(`${hub}/api/networks`, { headers }).then(r => r.json() as any);
      if (!res.ok) { console.error(res.error); return; }
      if (!res.networks?.length) { console.log("\n  No networks. Create one: anet network create <name>\n"); return; }
      console.log("\n  Networks:\n");
      const roleIcon: Record<string, string> = { owner: "⭐", admin: "🔧", member: "👤", viewer: "👁" };
      for (const n of res.networks) {
        const current = n.network_id === gc.network_id ? " ← current" : "";
        const icon = roleIcon[n.member_role] || " ";
        const role = n.member_role ? ` (${n.member_role})` : "";
        console.log(`  ${icon} ${n.network_name.padEnd(18)} ${role.padEnd(10)} ${n.network_id.slice(0, 12)}${current}`);
      }
      console.log();
    } catch (e: any) { console.error(friendlyError(e)); }
    return;
  }

  if (sub === "use") {
    const name = args[2];
    if (!name) { console.log("Usage: anet network use <name>"); return; }
    try {
      const res = await fetch(`${hub}/api/networks`, { headers }).then(r => r.json() as any);
      const net = res.networks?.find((n: any) => n.network_name === name || n.network_id === name);
      if (!net) { console.error(`Network "${name}" not found.`); return; }
      gc.network_id = net.network_id;
      gc.network_name = net.network_name;
      saveGlobal(gc);
      console.log(`[anet] Switched to network "${net.network_name}" (${net.network_id.slice(0, 12)})`);
    } catch (e: any) { console.error(friendlyError(e)); }
    return;
  }

  if (sub === "info") {
    const netId = gc.network_id;
    if (!netId) { console.log("No network selected. Run: anet network use <name>"); return; }
    try {
      const detail = await fetch(`${hub}/api/networks/${netId}`, { headers }).then(r => r.json() as any);
      if (!detail.ok) { console.error(detail.error); return; }
      const n = detail.network;
      const s = detail.stats;
      console.log(`\n  Network: ${n.network_name}`);
      console.log(`  ID:      ${n.network_id}`);
      console.log(`  Owner:   ${n.owner_id}`);
      if (n.description) console.log(`  Desc:    ${n.description}`);
      console.log(`  Created: ${n.created_at}`);
      console.log(`\n  Stats:`);
      console.log(`    Nodes:    ${s.nodes}`);
      console.log(`    Sessions: ${s.sessions}`);
      if (s.tasks?.length) {
        console.log(`    Tasks:`);
        for (const t of s.tasks) console.log(`      ${t.status}: ${t.count}`);
      }
      console.log();
    } catch (e: any) { console.error(friendlyError(e)); }
    return;
  }

  if (sub === "delete") {
    const name = args[2];
    if (!name) { console.log("Usage: anet network delete <name> --force"); return; }
    const opts2 = parseOpts();
    try {
      const res = await fetch(`${hub}/api/networks`, { headers }).then(r => r.json() as any);
      const net = res.networks?.find((n: any) => n.network_name === name || n.network_id === name);
      if (!net) { console.error(`Network "${name}" not found.`); return; }
      if (opts2.force !== "true") {
        console.log(`[anet] This will delete network "${net.network_name}" (${net.network_id})`);
        console.log(`[anet] Run again with --force to confirm.`);
        return;
      }
      const del = await fetch(`${hub}/api/networks/${net.network_id}`, { method: "DELETE", headers }).then(r => r.json() as any);
      if (del.ok) {
        console.log(`[anet] Network "${net.network_name}" deleted`);
        if (gc.network_id === net.network_id) { delete gc.network_id; delete gc.network_name; saveGlobal(gc); }
      } else { console.error(`Failed: ${del.error}`); }
    } catch (e: any) { console.error(friendlyError(e)); }
    return;
  }

  if (sub === "rename") {
    const name = args[2];
    const newName = args[3];
    if (!name || !newName) { console.log("Usage: anet network rename <current-name> <new-name>"); return; }
    try {
      const res = await fetch(`${hub}/api/networks`, { headers }).then(r => r.json() as any);
      const net = res.networks?.find((n: any) => n.network_name === name || n.network_id === name);
      if (!net) { console.error(`Network "${name}" not found.`); return; }
      const rename = await fetch(`${hub}/api/networks/${net.network_id}`, { method: "PUT", headers, body: JSON.stringify({ name: newName }) }).then(r => r.json() as any);
      if (rename.ok) {
        console.log(`[anet] Renamed "${name}" → "${newName}"`);
        if (gc.network_id === net.network_id) { gc.network_name = newName; saveGlobal(gc); }
      } else { console.error(`Failed: ${rename.error}`); }
    } catch (e: any) { console.error(friendlyError(e)); }
    return;
  }

  if (sub === "invite") {
    const opts = parseOpts();
    const netId = gc.network_id;
    if (!netId) { console.error("No network selected. Run: anet network use <name>"); return; }
    const role = opts.role || "member";
    const maxUses = parseInt(opts.uses || "1", 10);
    const expiresDays = opts.expires ? parseInt(opts.expires, 10) : undefined;
    try {
      const res = await fetch(`${hub}/api/networks/${netId}/invite`, {
        method: "POST", headers,
        body: JSON.stringify({ role, max_uses: maxUses, expires_days: expiresDays }),
      }).then(r => r.json() as any);
      if (res.ok) {
        console.log(`\n  Invite code: ${res.invite_code}`);
        console.log(`  Network:     ${gc.network_name || netId}`);
        console.log(`  Role:        ${role}`);
        console.log(`  Uses:        ${maxUses === -1 ? "unlimited" : maxUses}`);
        if (expiresDays) console.log(`  Expires:     ${expiresDays} days`);
        console.log(`\n  Share this with the invitee:`);
        console.log(`  anet network join ${res.invite_code}\n`);
      } else { console.error(`Failed: ${res.error}`); }
    } catch (e: any) { console.error(friendlyError(e)); }
    return;
  }

  if (sub === "join") {
    const code = args[2];
    if (!code) { console.log("Usage: anet network join <invite-code>"); return; }
    try {
      const res = await fetch(`${hub}/api/networks/join`, {
        method: "POST", headers,
        body: JSON.stringify({ invite_code: code }),
      }).then(r => r.json() as any);
      if (res.ok) {
        // Switch to the joined network
        gc.network_id = res.network_id;
        // Fetch network name
        const nets = await fetch(`${hub}/api/networks`, { headers }).then(r => r.json() as any);
        const net = nets.networks?.find((n: any) => n.network_id === res.network_id);
        if (net) gc.network_name = net.network_name;
        saveGlobal(gc);
        console.log(`[anet] Joined network "${gc.network_name || res.network_id}" as ${res.role}`);
        console.log(`[anet] Switched to this network.`);
      } else { console.error(`Failed: ${res.error}`); }
    } catch (e: any) { console.error(friendlyError(e)); }
    return;
  }

  if (sub === "members") {
    const netId = gc.network_id;
    if (!netId) { console.error("No network selected. Run: anet network use <name>"); return; }
    try {
      const res = await fetch(`${hub}/api/networks/${netId}/members`, { headers }).then(r => r.json() as any);
      if (!res.ok) { console.error(res.error); return; }
      console.log(`\n  Members of ${gc.network_name || netId}:\n`);
      const roleIcon: Record<string, string> = { owner: "⭐", admin: "🔧", member: "👤", viewer: "👁" };
      for (const m of res.members) {
        console.log(`  ${roleIcon[m.role] || "?"} ${(m.display_name || m.username).padEnd(16)} ${m.role.padEnd(8)} joined ${m.joined_at?.slice(0, 10) || "?"}`);
      }
      console.log();
    } catch (e: any) { console.error(friendlyError(e)); }
    return;
  }

  console.log(`
anet network <command>

  ls                    List my networks
  create <name>         Create a new network
  use <name>            Switch to a network
  info                  Current network details + stats
  rename <old> <new>    Rename a network
  delete <name> --force Delete a network
  invite                Generate invite code for current network
  join <code>           Join a network by invite code
  members               List members of current network
`);
}

// ── logs ──

function logsCommand() {
  const ref = args[1];
  if (!ref) {
    console.log("\nanet logs <node-name>   Show recent agent logs\nanet logs <node-name> --follow   Tail logs\n");
    return;
  }
  const resolved = resolveNodeRef(ref);
  if (!resolved) { console.error(`Node "${ref}" not found.`); process.exit(1); }

  const logDir = join(nodesDir(), resolved.id, "logs");
  if (!existsSync(logDir)) { console.log("No logs yet."); return; }

  const files = readdirSync(logDir).filter(f => f.endsWith(".log")).sort().reverse();
  if (files.length === 0) { console.log("No log files."); return; }

  const latest = join(logDir, files[0]);
  const opts = parseOpts();

  if (opts.follow === "true" || opts.f === "true") {
    console.log(`Tailing ${latest}...\n`);
    const child = spawn("tail", ["-f", "-n", "50", latest], { stdio: "inherit" });
    process.on("SIGINT", () => { child.kill(); process.exit(0); });
  } else {
    const lines = readFileSync(latest, "utf-8").split("\n");
    const n = parseInt(opts.n || opts.lines || "30");
    const tail = lines.slice(-n).join("\n");
    console.log(`\n${files[0]} (last ${n} lines):\n`);
    console.log(tail);
    if (files.length > 1) console.log(`\n${files.length} log files in ${logDir}`);
  }
}

// ── token ──

async function tokenCommand() {
  const gc = loadGlobal();
  const hub = gc.hub;
  const token = gc.token;
  if (!hub || !token) { console.error("Not logged in. Run: anet login"); return; }
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const sub = args[1];

  if (sub === "create") {
    const name = args[2] || "api-token";
    try {
      const res = await fetch(`${hub}/api/auth/tokens`, { method: "POST", headers, body: JSON.stringify({ name }) }).then(r => r.json() as any);
      if (res.ok) {
        console.log(`\n  ✅ Token created: ${res.token}`);
        console.log(`  Name: ${name}`);
        console.log(`  ID:   ${res.token_id}`);
        console.log(`\n  ⚠ Save this token — it won't be shown again!\n`);
      } else { console.error(`Failed: ${res.error}`); }
    } catch (e: any) { console.error(friendlyError(e)); }
    return;
  }

  if (sub === "revoke") {
    const tokenId = args[2];
    if (!tokenId) { console.log("Usage: anet token revoke <token-id>"); return; }
    try {
      const res = await fetch(`${hub}/api/auth/tokens/${tokenId}`, { method: "DELETE", headers }).then(r => r.json() as any);
      if (res.ok) console.log(`  ✅ Token ${tokenId} revoked`);
      else console.error(`Failed: ${res.error}`);
    } catch (e: any) { console.error(friendlyError(e)); }
    return;
  }

  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log(`
anet token <command>

  ls                    List all tokens
  create <name>         Create a new API token
  revoke <token-id>     Revoke a token by ID
`);
    return;
  }

  // Default: list tokens (same as "ls")
  try {
    const res = await fetch(`${hub}/api/auth/tokens`, { headers }).then(r => r.json() as any);
    if (!res.ok) { console.error(res.error); return; }
    if (!res.tokens?.length) { console.log("\n  No tokens. Create one: anet token create <name>\n"); return; }
    console.log("\n  API Tokens:\n");
    console.log("  ID                   NAME           LAST USED");
    console.log("  ──────────────────── ────────────── ──────────────────");
    for (const t of res.tokens) {
      console.log(`  ${(t.token_id || "?").padEnd(22)} ${(t.name || "?").padEnd(14)} ${t.last_used_at || "never"}`);
    }
    console.log();
  } catch (e: any) { console.error(friendlyError(e)); }
}

// ── passwd ──

async function passwdCommand() {
  const gc = loadGlobal();
  const hub = gc.hub;
  const token = gc.token;
  if (!hub || !token) { console.error("Not logged in. Run: anet login"); return; }

  const opts = parseOpts();
  const oldPw = opts["old-password"] || opts.old || await ask("Current password: ");
  const newPw = opts["new-password"] || opts["new"] || await ask("New password (min 6): ");
  closeRL();

  if (!oldPw || !newPw) { console.error("Both passwords required."); return; }

  try {
    const res = await fetch(`${hub}/api/auth/password`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
    }).then(r => r.json() as any);

    if (res.ok) {
      console.log("[anet] Password changed successfully.");
    } else {
      console.error(`[anet] Failed: ${res.error}`);
    }
  } catch (e: any) { console.error(friendlyError(e)); }
}

// ── demo ──

async function demoCommand() {
  const sub = args[1];
  if (!sub || sub.startsWith("-")) {
    return demoListCommand();
  }
  switch (sub) {
    case "ls": case "list":
      return demoListCommand();
    case "debate":
      args.splice(1, 1);
      return await demoDebateCommand();
    case "socialmedia": case "social":
      args.splice(1, 1);
      return await demoSocialMediaCommand();
    default:
      console.error(`Unknown demo "${sub}". Run 'anet demo ls' to see all available demos.`);
      process.exit(1);
  }
}

function demoListCommand() {
  console.log(`
  Available demos:

  [32m●[0m debate          辩论赛 — 6 agent (主持人 / 正反 4 辩 / 评委), ~10 min
                  anet demo debate --topic "AI 创造的岗位是否比消灭的多"

  [32m●[0m socialmedia     社交媒体内容工厂 — 4 agent (选题/文案/配图/审核), ~3 min
                  anet demo socialmedia --topic "..." --platform xiaohongshu

  See 'anet demo <name> --help' for details.
`);
}


// ── demo: debate ──
// Runs a multi-agent debate with 6 roles (host / 2 pro / 2 con / judge).
// Spawns local agents that connect to the configured hub, dispatches 9 steps
// in sequence, then prints+saves a markdown transcript. Self-cleaning unless
// --keep is passed.

const DEBATE_ROLES = ["主持人", "正方一辩", "正方二辩", "反方一辩", "反方二辩", "评委"] as const;

const DEBATE_PROMPTS: Record<string, (topic: string) => string> = {
  "主持人": (topic) => `你是辩论赛**主持人**，姓名"周老师"。
本次议题：「${topic}」（正方：肯定 / 反方：否定）

收到来自用户/api 的"开场"任务时:
- 用富有节奏感的台词宣布议题、介绍辩论流程(立论→质询→总结→评判),点燃气氛
- 200 字以内,要有梗、要有金句

收到"宣布结束并交评委"任务时:
- 简要回顾本场亮点 50-100 字
- 邀请评委判分

风格：央视《对话》主持的稳重 + 综艺主持的节奏感。`,
  "正方一辩": (topic) => `你是**正方一辩**,姓名"林希",立场:支持议题「${topic}」。
角色个性:逻辑严密、引用数据(可合理虚构)、善用历史经验类比。

收到"立论"任务:
- 直接抛出核心观点 + 3 个论据
- 350-500 字,开篇要抓人

收到"总结陈词"任务:
- 用对方在质询/反驳中暴露的弱点反将一军
- 重申核心立场,留金句
- 250-350 字`,
  "正方二辩": (topic) => `你是**正方二辩**,姓名"陈一川",立场:支持议题「${topic}」。
角色个性:犀利、好斗、专挑对方逻辑漏洞。

收到"质询反方"任务(附反方一辩立论):
- 针对反方立论的 2-3 个具体论点,用反问/数据/案例反驳
- 不要客套,火力全开
- 250-400 字`,
  "反方一辩": (topic) => `你是**反方一辩**,姓名"沈墨",立场:反对议题「${topic}」。
角色个性:冷静的现实派,引用研究报告,强调本议题与表面相似情境的本质差异。

收到"立论"任务(附议题+正方一辩立论):
- 先指出正方论证的最大破绽
- 列举 3 个论据(可合理虚构数据)
- 350-500 字

收到"总结陈词"任务:
- 强化"质量胜过数量"或类似的核心论调
- 250-350 字`,
  "反方二辩": (topic) => `你是**反方二辩**,姓名"白川",立场:反对议题「${topic}」。
角色个性:辛辣、直接、喜欢戳破对方的"乐观假设",常用类比讽刺。

收到"质询正方"任务(附正方一辩立论):
- 用讽刺、类比、反问对正方 2-3 个具体论点开火
- 250-400 字`,
  "评委": (_topic) => `你是辩论赛**评委**,姓名"张教授",公允、深刻、点评一针见血。

收到"判分并宣布胜负"任务(附整场辩论实录):
- 先 100 字总评本场亮点
- 然后给正方/反方分别打分(0-100),列出 2 条加分、2 条扣分理由
- 最后宣布胜负 + 给出核心理由
- 总长 400-600 字
- 不要讨好双方,必须分出胜负`,
};

async function demoDebateCommand() {
  const opts = parseOpts();
  const help = args.includes("--help") || args.includes("-h");
  if (help) {
    console.log(`
  anet demo debate — 多 agent 辩论赛 demo

  Usage:
    anet demo debate [--topic <议题>] [--key <minimax-key>] [--out <path>] [--keep] [--quick]

  Options:
    --topic <text>    辩题 (默认交互输入)
    --key <key>       MiniMax API key (默认 \$MINIMAX_KEY 或交互)
    --out <path>      实录保存路径 (默认 ./debate-<topic>-<ts>.md)
    --keep            跑完不删 6 个 agent + network (默认会清掉)
    --quick           简化版 (开场→正一→反一→评委,4 步)
    --step-timeout    每步超时秒数 (默认 360)
    --suffix          自定义 alias 后缀 (默认随机 4 位)
    --no-network      跑在当前/default network 内 (默认会单独建 debate-<suffix> network)
    --network <id>    指定已存在的 network

  Examples:
    anet demo debate --topic "AI 创造的岗位是否比消灭的多"
    anet demo debate --keep --topic "..."        # 保留 agent
    MINIMAX_KEY=sk-cp-xxx anet demo debate

  需要:
    - 已 anet login 到 hub
    - MiniMax key (Token Plan 至少有 MiniMax-M* 配额)
`);
    return;
  }

  const gc = loadGlobal();
  const hub = gc.hub;
  if (!hub) { console.error("  ❌ 没有 hub. 先 'anet init' 或 'anet hub start'."); return; }
  if (!gc.token) { console.error("  ❌ 没有 token. 先 'anet login'."); return; }

  let topic = opts.topic || "";
  if (!topic) {
    process.stdout.write("  辩题: ");
    topic = await new Promise<string>(r => {
      let buf = "";
      process.stdin.on("data", chunk => {
        buf += chunk.toString();
        if (buf.includes("\n")) r(buf.trim());
      });
    });
  }
  if (!topic) { console.error("  ❌ 议题不能为空."); return; }

  const minimaxKey = opts.key || process.env.MINIMAX_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
  if (!minimaxKey) {
    console.error("  ❌ 需要 MiniMax key. 用 --key 或 export MINIMAX_KEY=sk-cp-...");
    return;
  }

  const stepTimeout = parseInt(opts["step-timeout"] || "360", 10) * 1000;
  const keep = args.includes("--keep");
  const quick = args.includes("--quick");
  const suffix = opts.suffix || Math.random().toString(16).slice(2, 6);
  const outPath = opts.out || `./debate-${topic.slice(0, 20).replace(/[^一-龥\w]/g, "-")}-${Date.now()}.md`;

  // Network selection: by default we create a dedicated network "debate-<suffix>"
  // for the run so the demo's 6 agents + tasks live in their own namespace and
  // are wiped together at cleanup. Pass --no-network to fall back to the
  // current/default network (legacy behavior), or --network <id> to use an
  // existing network you already created.
  const useDefaultNetwork = args.includes("--no-network");
  const explicitNetwork = opts.network || "";
  let networkId = "";
  let createdNetworkId = "";
  let networkLabel = "";

  if (explicitNetwork) {
    networkId = explicitNetwork;
    networkLabel = `(provided ${explicitNetwork.slice(0, 16)})`;
  } else if (useDefaultNetwork) {
    try {
      const me = await fetch(`${hub}/api/auth/me`, { headers: authHeaders() }).then(r => r.json() as any);
      networkId = me?.user?.default_network_id || "";
    } catch {}
    if (!networkId) {
      try {
        const nets = await fetch(`${hub}/api/networks`, { headers: authHeaders() }).then(r => r.json() as any);
        const def = (nets?.networks || []).find((n: any) => n.network_name === "default") || nets?.networks?.[0];
        networkId = def?.network_id || "";
      } catch {}
    }
    networkLabel = `(default network)`;
  } else {
    const netName = `debate-${suffix}`;
    console.log(`  ⏳ 正在创建独立 network: ${netName}...`);
    try {
      const r = await fetch(`${hub}/api/networks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gc.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: netName, description: `Auto-created for anet demo debate: ${topic.slice(0, 80)}` }),
      }).then(r => r.json() as any);
      if (!r?.ok || !r.network_id) {
        console.error(`  ❌ 创建 network 失败: ${r?.error || "unknown"}. 用 --no-network 退到 default 或 --network <id> 指定.`);
        return;
      }
      createdNetworkId = r.network_id;
      networkId = createdNetworkId;
      networkLabel = `(${netName} ${createdNetworkId.slice(0, 16)})`;
    } catch (e: any) {
      console.error(`  ❌ 创建 network 抛出异常: ${e.message}. 用 --no-network 退到 default.`);
      return;
    }
  }

  if (!networkId) {
    console.error("  ⚠️  没有 network_id — agent 可能拉不到任务.");
  }

  // Aliases used for this run (with suffix to avoid collision).
  const roleAliases: Record<string, string> = {};
  for (const r of DEBATE_ROLES) roleAliases[r] = `${r}-${suffix}`;

  console.log(`\n  🎙️  辩题: ${topic}`);
  console.log(`  📡 Hub:  ${hub}`);
  console.log(`  📂 Net:  ${networkLabel}`);
  console.log(`  🆔 Run:  ${suffix}\n`);

  // 1. Create + configure 6 agents
  // Switch the active network in ~/.anet/config.json to createdNetworkId so
  // createCommand provisions the 6 nodes inside the demo's dedicated network.
  // We restore the original network_id in a finally block below regardless of
  // success/failure so the user's CLI never gets stuck on the demo network.
  const origNetworkId = gc.network_id || "";
  const origNetworkName = gc.network_name || "";
  if (createdNetworkId) {
    saveGlobal({ ...gc, network_id: createdNetworkId, network_name: `debate-${suffix}` });
  } else if (explicitNetwork) {
    saveGlobal({ ...gc, network_id: explicitNetwork });
  }

  const restoreNetwork = () => {
    if (createdNetworkId || explicitNetwork) {
      try {
        const cur = loadGlobal();
        saveGlobal({ ...cur, network_id: origNetworkId || undefined, network_name: origNetworkName || undefined });
      } catch {}
    }
  };

  // Tell createCommand not to process.exit so we can call it 6 times
  process.env.ANET_INTERNAL_KEEP_PROCESS = "1";
  try {
    console.log(`  [1/4] 创建 6 个 agent (alias 后缀 -${suffix})...`);
    const nodesRoot = nodesDir();
    for (const role of DEBATE_ROLES) {
      const alias = roleAliases[role];
      if (!existsSync(join(nodesRoot, alias, "config.json"))) {
        const createArgs = ["create", alias,
          "--runtime", "claude-agent-sdk",
          "--model", "MiniMax-M2.7",
          "--env", `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`,
          "--env", `ANTHROPIC_AUTH_TOKEN=${minimaxKey}`,
          "--env", `ANTHROPIC_MODEL=MiniMax-M2.7`,
          // Force the dedicated demo network so createCommand doesn't prompt
          // "选择网络" once per agent — gc.network_id alone isn't enough,
          // createCommand only skips the picker when --network is explicit.
          ...(networkId ? ["--network", networkId] : []),
        ];
        args.length = 0; args.push(...createArgs);
        try { await createCommand(); } catch (e: any) {
          console.error(`     ❌ create ${alias}: ${e.message}`);
          restoreNetwork();
          delete process.env.ANET_INTERNAL_KEEP_PROCESS;
          return;
        }
      }
      // Inject systemPrompt for this role
      const cfgPath = join(nodesRoot, alias, "config.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      cfg.systemPrompt = DEBATE_PROMPTS[role](topic);
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    }
    console.log(`        ✓ 创建/更新 6 个 agent`);
  } finally {
    restoreNetwork();
    delete process.env.ANET_INTERNAL_KEEP_PROCESS;
  }

  // 2. Start each in tmux
  console.log(`  [2/4] 启动 6 个 agent (tmux session)...`);
  for (const role of DEBATE_ROLES) {
    const alias = roleAliases[role];
    const sessName = `debate-${suffix}-${alias}`;
    try { execSync(`tmux kill-session -t ${JSON.stringify(sessName)} 2>/dev/null`, { stdio: "pipe" }); } catch {}
    try {
      execSync(`tmux new-session -d -s ${JSON.stringify(sessName)} 'anet node start ${JSON.stringify(alias)}'`, { stdio: "pipe", shell: "/bin/bash" });
    } catch (e: any) {
      console.error(`     ❌ tmux ${alias}: ${e.message}`);
      return;
    }
  }

  // Wait until all 6 are SSE-connected
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const h = await fetch(`${hub}/health`).then(r => r.json() as any);
      const sse = h?.sse_sessions || {};
      const allUp = DEBATE_ROLES.every(r => sse[roleAliases[r]] >= 1);
      if (allUp) { console.log(`        ✓ 6 agent 全部 SSE connected`); break; }
    } catch {}
  }

  // 3. Drive the 8 (or 4 quick) steps
  type Speech = { header: string; speaker: string; alias: string; text: string };
  const transcript: Speech[] = [];

  async function postTask(alias: string, task: string): Promise<string> {
    const body = JSON.stringify({ alias, task, priority: "normal", from: "api", network_id: networkId || undefined });
    const res = await fetch(`${hub}/api/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body,
    });
    const j: any = await res.json();
    if (!j?.ok) throw new Error(`postTask failed: ${JSON.stringify(j)}`);
    return j.message_id;
  }

  // Wait for a reply via /api/messages polling (looks for type='reply' with in_reply_to=msgId).
  async function waitReply(msgId: string, alias: string, timeoutMs: number): Promise<string> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const r = await fetch(`${hub}/api/messages?limit=200`, { headers: authHeaders() }).then(x => x.json() as any);
        const msg = (r?.messages || []).find((m: any) => m.from_alias === alias && m.type === "reply" && m.content);
        // /api/messages doesn't include in_reply_to in the SELECT yet, so we
        // match by recency + speaker. Since each step is sequential and we
        // only wait for one alias at a time, this is unambiguous.
        if (msg) {
          let text = msg.content as string;
          if (text.startsWith(`[${alias}]`)) text = text.slice(alias.length + 2).trimStart();
          return text;
        }
      } catch {}
    }
    throw new Error(`timeout waiting for ${alias} reply`);
  }

  async function step(stepNo: number, total: number, header: string, role: string, task: string): Promise<string> {
    const alias = roleAliases[role];
    process.stdout.write(`  [${stepNo}/${total}] ${header} (${alias}) ... `);
    const t0 = Date.now();
    const msgId = await postTask(alias, task);
    const reply = await waitReply(msgId, alias, stepTimeout);
    const dt = Math.round((Date.now() - t0) / 1000);
    console.log(`✓ ${dt}s, ${reply.length} 字`);
    transcript.push({ header, speaker: role, alias, text: reply });
    return reply;
  }

  console.log(`  [3/4] 驱动辩论流程 (${quick ? 4 : 9} 步)...`);
  try {
    if (quick) {
      const t = 4;
      await step(1, t, "开场", "主持人",
        `请你作为主持人,开场宣布以下辩题并介绍流程：\n议题：「${topic}」`);
      const pro = await step(2, t, "正方立论", "正方一辩", `议题:「${topic}」\n请发表立论,直接开始。`);
      const con = await step(3, t, "反方立论", "反方一辩",
        `议题:「${topic}」\n\n正方立论:\n---\n${pro}\n---\n\n请反方立论。`);
      const md = transcript.map(s => `## ${s.header} — ${s.speaker}\n\n${s.text}\n`).join("\n");
      await step(4, t, "评委判分", "评委",
        `议题:「${topic}」\n\n请根据完整辩论判分:\n\n${md}`);
    } else {
      const t = 9;
      await step(1, t, "开场", "主持人",
        `请你作为主持人,开场宣布以下辩题并介绍辩论流程:\n议题：「${topic}」`);
      const pro1 = await step(2, t, "正一立论", "正方一辩",
        `议题:「${topic}」\n你是正方一辩,请立论。`);
      const con1 = await step(3, t, "反一立论", "反方一辩",
        `议题:「${topic}」\n\n正方一辩立论:\n---\n${pro1}\n---\n\n你是反方一辩,请立论。`);
      const pro2 = await step(4, t, "正二质询", "正方二辩",
        `议题:「${topic}」\n\n反方一辩立论:\n---\n${con1}\n---\n\n你是正方二辩,请质询反方。`);
      const con2 = await step(5, t, "反二质询", "反方二辩",
        `议题:「${topic}」\n\n正方一辩立论:\n---\n${pro1}\n---\n\n你是反方二辩,请质询正方。`);
      const conS = await step(6, t, "反一总结", "反方一辩",
        `议题:「${topic}」\n你是反方一辩,请总结陈词。前面发言:\n[正一]\n${pro1}\n\n[反一(你)]\n${con1}\n\n[正二]\n${pro2}\n\n[反二]\n${con2}`);
      const proS = await step(7, t, "正一总结", "正方一辩",
        `议题:「${topic}」\n你是正方一辩,请总结陈词。完整辩论:\n[正一(你)]\n${pro1}\n\n[反一]\n${con1}\n\n[正二]\n${pro2}\n\n[反二]\n${con2}\n\n[反一总结]\n${conS}`);
      const md = transcript.map(s => `【${s.header}】${s.speaker}\n${s.text}`).join("\n\n");
      const verdict = await step(8, t, "评委判分", "评委",
        `议题:「${topic}」\n请根据完整辩论判分。完整实录:\n\n${md}`);
      await step(9, t, "闭幕", "主持人",
        `议题:「${topic}」\n\n评委已宣布:\n---\n${verdict}\n---\n\n请你做闭幕,回顾本场亮点 50-100 字。`);
    }
  } catch (e: any) {
    console.error(`\n  ❌ 流程失败: ${e.message}`);
    if (!keep) console.log(`  (--keep 未指定,稍后会清理 agent)`);
  }

  // 4. Output transcript
  console.log(`\n  [4/4] 写入实录: ${outPath}`);
  const md = [
    `# 辩论赛实录`,
    ``,
    `**议题**: ${topic}`,
    ``,
    `**时间**: ${new Date().toLocaleString()}`,
    ``,
    `**Run**: ${suffix}`,
    ``,
    ...transcript.flatMap(s => [`## ${s.header} — ${s.speaker}`, ``, s.text, ``]),
  ].join("\n");
  writeFileSync(outPath, md);
  console.log(`        ✓ ${md.length} 字写入 ${outPath}`);

  // Cleanup unless --keep
  if (!keep) {
    console.log(`\n  🧹 清理 6 个 agent (用 --keep 跳过)...`);
    for (const role of DEBATE_ROLES) {
      const alias = roleAliases[role];
      const sessName = `debate-${suffix}-${alias}`;
      try { execSync(`tmux kill-session -t ${JSON.stringify(sessName)} 2>/dev/null`, { stdio: "pipe" }); } catch {}
      args.length = 0; args.push("delete", alias, "--force");
      try { await deleteCommand(); } catch {}
    }
    if (createdNetworkId) {
      try {
        await fetch(`${hub}/api/networks/${createdNetworkId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${gc.token}` },
        });
        console.log(`        ✓ 删除独立 network (${createdNetworkId.slice(0, 16)})`);
      } catch (e: any) {
        console.log(`        ⚠ 删除 network 失败: ${e.message}. 手动: anet network delete ${createdNetworkId}`);
      }
    }
    console.log(`        ✓ 清理完成`);
  } else {
    console.log(`\n  📌 已保留 6 个 agent (alias 后缀 -${suffix})。手动清理:`);
    console.log(`     tmux kill-session -t debate-${suffix}-*`);
    console.log(`     anet node delete ${DEBATE_ROLES.map(r => `${r}-${suffix}`).join(" ")}`);
    if (createdNetworkId) {
      console.log(`     anet network delete ${createdNetworkId}`);
    }
  }

  console.log(`\n  🏁 完成！实录: ${outPath}\n`);
}

// ── demo: socialmedia ──
// 4-agent social media content factory: angle finder → copywriter →
// image art-director → reviewer. Drives the same step-by-step flow as
// debate but tuned for content production instead of argumentation.
// Default platform is xiaohongshu (small red book / "RED"); override
// with --platform twitter|wechat|linkedin.

const SOCIAL_ROLES = ["选题官", "文案官", "配图官", "审核官"] as const;

const PLATFORM_GUIDE: Record<string, string> = {
  xiaohongshu: "小红书 (RED): 标题钩子要狠，正文人称化，多 emoji 分隔，短段落，结尾互动引导，3-6 个 # 话题标签",
  twitter:     "Twitter / X: 280 字内单条主推 + 可选 1-3 条延展短回复 (thread)，钩子前置，1-2 个话题标签",
  wechat:      "微信公众号: 长文叙事，开头悬念，小标题分段，引用案例，结尾价值升华或互动 CTA",
  linkedin:    "LinkedIn: 专业第一人称叙述，行业洞察 + 数据，1-3 行短段落，结尾留思考问题，2-4 个话题标签",
};

const SOCIAL_PROMPTS: Record<string, (topic: string, platform: string) => string> = {
  "选题官": (topic, platform) => `你是社交媒体内容工厂的**选题官**，姓名"林若"。
任务：为话题「${topic}」在 ${platform} 平台上找 3 个不同的内容切入角度。
平台特点：${PLATFORM_GUIDE[platform] || PLATFORM_GUIDE.xiaohongshu}

收到任务时:
- 列出 3 个独立的内容 angle，每个 1 行 + 标注预估热度 (高/中/低) + 理由
- 然后明确推荐其中 1 个 (写"📌 推荐角度: <编号>") 给文案官
- 总长 200-350 字`,
  "文案官": (topic, platform) => `你是社交媒体内容工厂的**文案官**，姓名"陈夏"。
平台：${platform}
平台风格规则：${PLATFORM_GUIDE[platform] || PLATFORM_GUIDE.xiaohongshu}

收到任务时(附话题 + 选题官推荐角度):
- 严格按平台风格写一篇完整内容
- 含醒目标题 / 开头钩子 / 正文 / 结尾 CTA / 话题标签
- 长度按平台风格控制 (xiaohongshu 400-600 字 / twitter 单条 ≤280 字 + thread 0-3 条 / wechat 800-1500 字 / linkedin 300-500 字)
- 写完用三个 dash 分隔，最后给配图官一句话简介："📷 给配图官: <你想要的视觉画面 30 字内>"`,
  "配图官": (topic, platform) => `你是社交媒体内容工厂的**配图官**，姓名"白苏"。
不实际生图，只输出可直接给图像模型 (MidJourney / DALL-E / image-01 / 即梦) 用的 prompt。

收到任务时 (附完整文案):
- 给 3 张配图的英文 prompt (建议封面 1 + 正文配图 2)，每条 prompt 80-150 字符，含主体/构图/色调/风格关键词
- 中文一句话说明每张图的位置和作用
- 总长 250-400 字`,
  "审核官": (topic, platform) => `你是社交媒体内容工厂的**审核官**，姓名"周岩"。

收到任务 (附话题 + 文案 + 配图 prompts):
- 用 4 个维度评分 (0-10)：吸引力 / 平台适配性 / 合规风险 / 转发意愿
- 列 2-3 条具体修改建议
- 最后给"✅ 通过 / ⚠️ 修改后通过 / ❌ 重做"的明确判定 + 一句金句 reason
- 总长 250-400 字`,
};

const SOCIAL_PLATFORMS = ["xiaohongshu", "twitter", "wechat", "linkedin"] as const;

async function demoSocialMediaCommand() {
  const opts = parseOpts();
  const help = args.includes("--help") || args.includes("-h");
  if (help) {
    console.log(`
  anet demo socialmedia — 4-agent 社交媒体内容工厂

  Usage:
    anet demo socialmedia [--topic <主题>] [--platform xiaohongshu|twitter|wechat|linkedin] [--key <key>]

  Options:
    --topic <text>      内容主题 (默认交互输入)
    --platform <id>     目标平台 (默认 xiaohongshu)
    --key <key>         MiniMax API key (默认 \$MINIMAX_KEY)
    --out <path>        实录路径 (默认 ./social-<topic>-<ts>.md)
    --keep              跑完保留 4 个 agent + network
    --step-timeout <s>  每步超时秒数 (默认 360)
    --suffix <s>        alias 后缀 (默认随机 4 hex)
    --no-network        在 default network 跑 (默认建独立 demo-social-<suffix>)
    --network <id>      复用已有 network

  4 个角色:
    📌 选题官 林若 — 找 3 个 angle 推荐 1 个
    ✍️ 文案官 陈夏 — 按平台风格写完整内容
    📷 配图官 白苏 — 输出 3 条图像生成 prompt
    🔍 审核官 周岩 — 4 维度评分 + 修改建议 + 通过判定

  Examples:
    anet demo socialmedia --topic "Bun 1.3 新特性" --platform xiaohongshu
    anet demo socialmedia --topic "..." --platform twitter --key sk-cp-xxx
`);
    return;
  }

  const gc = loadGlobal();
  const hub = gc.hub;
  if (!hub) { console.error("  ❌ 没有 hub. 先 'anet init' 或 'anet hub start'."); return; }
  if (!gc.token) { console.error("  ❌ 没有 token. 先 'anet login'."); return; }

  let topic = opts.topic || "";
  if (!topic) {
    process.stdout.write("  主题: ");
    topic = await new Promise<string>(r => {
      let buf = "";
      process.stdin.on("data", chunk => {
        buf += chunk.toString();
        if (buf.includes("\n")) r(buf.trim());
      });
    });
  }
  if (!topic) { console.error("  ❌ 主题不能为空."); return; }

  const platform = (opts.platform || "xiaohongshu").toLowerCase();
  if (!SOCIAL_PLATFORMS.includes(platform as any)) {
    console.error(`  ❌ 平台 "${platform}" 不支持. 可选: ${SOCIAL_PLATFORMS.join(", ")}`);
    return;
  }

  const minimaxKey = opts.key || process.env.MINIMAX_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
  if (!minimaxKey) {
    console.error("  ❌ 需要 MiniMax key. 用 --key 或 export MINIMAX_KEY=...");
    return;
  }

  const stepTimeout = parseInt(opts["step-timeout"] || "360", 10) * 1000;
  const keep = args.includes("--keep");
  const suffix = opts.suffix || Math.random().toString(16).slice(2, 6);
  const outPath = opts.out || `./social-${topic.slice(0, 20).replace(/[^一-龥\w]/g, "-")}-${Date.now()}.md`;

  const useDefaultNetwork = args.includes("--no-network");
  const explicitNetwork = opts.network || "";
  let networkId = "";
  let createdNetworkId = "";
  let networkLabel = "";

  if (explicitNetwork) {
    networkId = explicitNetwork;
    networkLabel = `(provided ${explicitNetwork.slice(0, 16)})`;
  } else if (useDefaultNetwork) {
    try {
      const me = await fetch(`${hub}/api/auth/me`, { headers: authHeaders() }).then(r => r.json() as any);
      networkId = me?.user?.default_network_id || "";
    } catch {}
    if (!networkId) {
      try {
        const nets = await fetch(`${hub}/api/networks`, { headers: authHeaders() }).then(r => r.json() as any);
        const def = (nets?.networks || []).find((n: any) => n.network_name === "default") || nets?.networks?.[0];
        networkId = def?.network_id || "";
      } catch {}
    }
    networkLabel = `(default network)`;
  } else {
    const netName = `demo-social-${suffix}`;
    try {
      const r = await fetch(`${hub}/api/networks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gc.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: netName, description: `Auto-created for anet demo socialmedia: ${topic.slice(0, 80)}` }),
      }).then(r => r.json() as any);
      if (!r?.ok || !r.network_id) {
        console.error(`  ❌ 创建 network 失败: ${r?.error || "unknown"}.`);
        return;
      }
      createdNetworkId = r.network_id;
      networkId = createdNetworkId;
      networkLabel = `(${netName} ${createdNetworkId.slice(0, 16)})`;
    } catch (e: any) {
      console.error(`  ❌ 创建 network 抛出异常: ${e.message}.`);
      return;
    }
  }

  const roleAliases: Record<string, string> = {};
  for (const r of SOCIAL_ROLES) roleAliases[r] = `${r}-${suffix}`;

  console.log(`\n  📱 主题: ${topic}`);
  console.log(`  🎯 平台: ${platform}`);
  console.log(`  📡 Hub:  ${hub}`);
  console.log(`  📂 Net:  ${networkLabel}`);
  console.log(`  🆔 Run:  ${suffix}\n`);

  const origNetworkId = gc.network_id || "";
  const origNetworkName = gc.network_name || "";
  if (createdNetworkId) {
    saveGlobal({ ...gc, network_id: createdNetworkId, network_name: `demo-social-${suffix}` });
  } else if (explicitNetwork) {
    saveGlobal({ ...gc, network_id: explicitNetwork });
  }
  let restoreNetwork = () => {
    if (createdNetworkId || explicitNetwork) {
      try {
        const cur = loadGlobal();
        saveGlobal({ ...cur, network_id: origNetworkId || undefined, network_name: origNetworkName || undefined });
      } catch {}
    }
  };

  process.env.ANET_INTERNAL_KEEP_PROCESS = "1";
  try {
    console.log(`  [1/3] 创建 4 个 agent (alias 后缀 -${suffix})...`);
    const nodesRoot = nodesDir();
    for (const role of SOCIAL_ROLES) {
      const alias = roleAliases[role];
      if (!existsSync(join(nodesRoot, alias, "config.json"))) {
        const createArgs = ["create", alias,
          "--runtime", "claude-agent-sdk",
          "--model", "MiniMax-M2.7",
          "--env", `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`,
          "--env", `ANTHROPIC_AUTH_TOKEN=${minimaxKey}`,
          "--env", `ANTHROPIC_MODEL=MiniMax-M2.7`,
          // Force the dedicated demo network so createCommand doesn't prompt
          // "选择网络" once per agent — gc.network_id alone isn't enough,
          // createCommand only skips the picker when --network is explicit.
          ...(networkId ? ["--network", networkId] : []),
        ];
        args.length = 0; args.push(...createArgs);
        try { await createCommand(); } catch (e: any) {
          console.error(`     ❌ create ${alias}: ${e.message}`);
          restoreNetwork();
          delete process.env.ANET_INTERNAL_KEEP_PROCESS;
          return;
        }
      }
      const cfgPath = join(nodesRoot, alias, "config.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      cfg.systemPrompt = SOCIAL_PROMPTS[role](topic, platform);
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    }
    console.log(`        ✓ 4 个 agent 就位`);
  } finally {
    restoreNetwork();
    delete process.env.ANET_INTERNAL_KEEP_PROCESS;
  }

  console.log(`  [2/3] 启动 4 个 agent (tmux session)...`);
  for (const role of SOCIAL_ROLES) {
    const alias = roleAliases[role];
    const sessName = `social-${suffix}-${alias}`;
    try { execSync(`tmux kill-session -t ${JSON.stringify(sessName)} 2>/dev/null`, { stdio: "pipe" }); } catch {}
    try {
      execSync(`tmux new-session -d -s ${JSON.stringify(sessName)} 'anet node start ${JSON.stringify(alias)}'`, { stdio: "pipe", shell: "/bin/bash" });
    } catch (e: any) {
      console.error(`     ❌ tmux ${alias}: ${e.message}`);
      return;
    }
  }

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const h = await fetch(`${hub}/health`).then(r => r.json() as any);
      const sse = h?.sse_sessions || {};
      const allUp = SOCIAL_ROLES.every(r => sse[roleAliases[r]] >= 1);
      if (allUp) { console.log(`        ✓ 4 agent 全部 SSE connected`); break; }
    } catch {}
  }

  type Speech = { header: string; speaker: string; alias: string; text: string };
  const transcript: Speech[] = [];

  async function postTask(alias: string, task: string): Promise<string> {
    const body = JSON.stringify({ alias, task, priority: "normal", from: "api", network_id: networkId || undefined });
    const res = await fetch(`${hub}/api/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body,
    });
    const j: any = await res.json();
    if (!j?.ok) throw new Error(`postTask failed: ${JSON.stringify(j)}`);
    return j.message_id;
  }

  async function waitReply(_msgId: string, alias: string, timeoutMs: number): Promise<string> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const r = await fetch(`${hub}/api/messages?limit=200`, { headers: authHeaders() }).then(x => x.json() as any);
        const msg = (r?.messages || []).find((m: any) => m.from_alias === alias && m.type === "reply" && m.content);
        if (msg) {
          let text = msg.content as string;
          if (text.startsWith(`[${alias}]`)) text = text.slice(alias.length + 2).trimStart();
          return text;
        }
      } catch {}
    }
    throw new Error(`timeout waiting for ${alias} reply`);
  }

  async function step(stepNo: number, total: number, header: string, role: string, task: string): Promise<string> {
    const alias = roleAliases[role];
    process.stdout.write(`  [${stepNo}/${total}] ${header} (${alias}) ... `);
    const t0 = Date.now();
    const msgId = await postTask(alias, task);
    const reply = await waitReply(msgId, alias, stepTimeout);
    const dt = Math.round((Date.now() - t0) / 1000);
    console.log(`✓ ${dt}s, ${reply.length} 字`);
    transcript.push({ header, speaker: role, alias, text: reply });
    return reply;
  }

  console.log(`  [3/3] 内容生产 (4 步)...`);
  try {
    const total = 4;
    const angles = await step(1, total, "选题", "选题官",
      `请你为话题「${topic}」在 ${platform} 平台找 3 个内容切入角度，并明确推荐 1 个。`);
    const copy = await step(2, total, "文案", "文案官",
      `话题:「${topic}」\n平台: ${platform}\n选题官产出:\n---\n${angles}\n---\n按推荐角度写一篇完整内容。`);
    const imagery = await step(3, total, "配图", "配图官",
      `话题:「${topic}」\n平台: ${platform}\n文案:\n---\n${copy}\n---\n请给 3 条图像生成 prompt。`);
    const review = await step(4, total, "审核", "审核官",
      `话题:「${topic}」\n平台: ${platform}\n\n[文案]\n${copy}\n\n[配图 prompts]\n${imagery}\n\n请评分 + 修改建议 + 通过判定。`);
    void review;
  } catch (e: any) {
    console.error(`\n  ❌ 流程失败: ${e.message}`);
  }

  console.log(`\n  📝 写入实录: ${outPath}`);
  const md = [
    `# 社交媒体内容工厂实录`,
    ``,
    `**主题**: ${topic}`,
    ``,
    `**平台**: ${platform}`,
    ``,
    `**时间**: ${new Date().toLocaleString()}`,
    ``,
    `**Run**: ${suffix}`,
    ``,
    ...transcript.flatMap(s => [`## ${s.header} — ${s.speaker}`, ``, s.text, ``]),
  ].join("\n");
  writeFileSync(outPath, md);
  console.log(`        ✓ ${md.length} 字写入 ${outPath}`);

  if (!keep) {
    console.log(`\n  🧹 清理 4 个 agent...`);
    for (const role of SOCIAL_ROLES) {
      const alias = roleAliases[role];
      const sessName = `social-${suffix}-${alias}`;
      try { execSync(`tmux kill-session -t ${JSON.stringify(sessName)} 2>/dev/null`, { stdio: "pipe" }); } catch {}
      args.length = 0; args.push("delete", alias);
      try { await deleteCommand(); } catch {}
    }
    if (createdNetworkId) {
      try {
        await fetch(`${hub}/api/networks/${createdNetworkId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${gc.token}` },
        });
        console.log(`        ✓ 删除独立 network (${createdNetworkId.slice(0, 16)})`);
      } catch (e: any) {
        console.log(`        ⚠ 删除 network 失败: ${e.message}.`);
      }
    }
    console.log(`        ✓ 清理完成`);
  } else {
    console.log(`\n  📌 已保留 4 个 agent (alias 后缀 -${suffix})`);
    if (createdNetworkId) console.log(`     network: ${createdNetworkId}`);
  }

  console.log(`\n  🏁 完成！实录: ${outPath}\n`);
}


// ── config show ──

function configShowCommand() {
  const gc = loadGlobal();
  const configPath = join(home, ".anet", "config.json");

  console.log(`\n  anet config (${configPath})\n`);
  console.log(`  hub:          ${gc.hub || "(not set — run: anet init)"}`);
  console.log(`  token:        ${gc.token ? gc.token.slice(0, 12) + "..." : "(not set — run: anet login)"}`);
  console.log(`  user:         ${gc.user?.username || "(not logged in)"}`);
  console.log(`  network_id:   ${gc.network_id || "(none — run: anet network use)"}`);
  console.log(`  network_name: ${gc.network_name || "(none)"}`);

  // Show node count
  const nd = nodesDir();
  let nodeCount = 0;
  try { nodeCount = readdirSync(nd).filter(d => existsSync(join(nd, d, "config.json"))).length; } catch {}
  console.log(`\n  nodes:        ${nodeCount} in .anet/nodes/`);

  const sub = args[1];
  if (sub === "path") {
    console.log(`\n  ${configPath}`);
  } else if (sub === "json") {
    console.log(`\n${JSON.stringify(gc, null, 2)}`);
  } else {
    console.log(`\n  Subcommands:`);
    console.log(`    anet config          Show config summary`);
    console.log(`    anet config path     Print config file path`);
    console.log(`    anet config json     Print raw JSON`);
  }
  console.log();
}

// ── info ──

async function infoCommand() {
  const ref = args[1];
  if (!ref) { console.log("\nanet info <node-name>   Detailed node information\n"); return; }
  const resolved = resolveNodeRef(ref);
  if (!resolved) { console.error(`Node "${ref}" not found.`); process.exit(1); }
  const { id: nodeId, profile } = resolved;
  const displayName = nodeDisplayName(nodeId, profile);

  console.log(`\n  Node: ${displayName}`);
  console.log(`  ──────────────────────────────────`);
  console.log(`  node_id:  ${profile.node_id || "-"}`);
  console.log(`  runtime:  ${normalizeRuntime(profile)}`);
  console.log(`  model:    ${profile.model || "(default)"}`);
  console.log(`  hub:      ${profile.hub || loadGlobal().hub || "-"}`);
  console.log(`  channels: ${profile.channels?.join(", ") || "(none)"}`);
  console.log(`  config:   .anet/nodes/${nodeId}/config.json`);

  // PID check
  const pidFile = join(nodesDir(), nodeId, ".pid");
  let alive = false;
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
    try { process.kill(pid, 0); alive = true; } catch {}
    console.log(`  pid:      ${pid} ${alive ? "● running" : "✕ stopped"}`);
  } else {
    console.log(`  pid:      (not running)`);
  }

  // Server status
  const gc = loadGlobal();
  if (gc.hub) {
    try {
      const status = await fetch(`${gc.hub}/api/status`, { headers: authHeaders() }).then(r => r.json() as any);
      const session = status.sessions?.find((s: any) => s.alias === displayName || s.node_id === profile.node_id);
      if (session) {
        console.log(`\n  Server Status:`);
        console.log(`    status:   ${session.status}`);
        console.log(`    task:     ${(session.task || "-").slice(0, 60)}`);
        console.log(`    updated:  ${session.updated_at || "-"}`);
      } else {
        console.log(`\n  Server: not registered`);
      }
    } catch {}

    // Recent tasks
    try {
      const tasks = await fetch(`${gc.hub}/api/tasks?to_name=${encodeURIComponent(displayName)}&limit=3`, { headers: authHeaders() }).then(r => r.json() as any);
      if (tasks.tasks?.length > 0) {
        console.log(`\n  Recent Tasks:`);
        for (const t of tasks.tasks) {
          console.log(`    ${t.status.padEnd(10)} ${(t.from_name || "?").padEnd(12)} ${(t.content || "").slice(0, 40)}`);
        }
      }
    } catch {}
  }

  // Logs
  const logDir = join(nodesDir(), nodeId, "logs");
  if (existsSync(logDir)) {
    const files = readdirSync(logDir).filter(f => f.endsWith(".log")).sort().reverse();
    if (files.length > 0) console.log(`\n  Logs: ${files.length} file(s), latest: ${files[0]}`);
  }

  console.log();
}

// ── license ──

async function licenseCommand() {
  const gc = loadGlobal();
  const hub = gc.hub;
  if (!hub) { console.error("Run 'anet init' first."); return; }

  try {
    const res = await fetch(`${hub}/api/license`, { headers: authHeaders() }).then(r => r.json() as any);
    if (!res.ok) { console.error("Failed to get license info."); return; }
    const lic = res.license;
    const lim = res.limits;

    console.log(`\n  License: ${lic.type.toUpperCase()}`);
    if (lic.expires_at) {
      console.log(`  Expires: ${lic.expires_at}${lic.expired ? " (EXPIRED)" : ""}`);
      if (lic.days_left !== null) console.log(`  Days left: ${lic.days_left}`);
    }
    console.log(`\n  Limits:`);
    console.log(`    Agents:    ${lim.max_agents}`);
    console.log(`    Networks:  ${lim.max_networks}`);
    console.log(`    Tasks/day: ${lim.max_tasks_day}`);

    if (lic.expired) {
      console.log(`\n  ⚠ License expired! Options:`);
      console.log(`    anet activate <key>    Activate a license key`);
      console.log(`    anet init --hub https://hub.sleep2agi.com  Use free hosted`);
    }
    console.log();
  } catch (e: any) { console.error(friendlyError(e)); }
}

async function activateCommand() {
  const gc = loadGlobal();
  const hub = gc.hub;
  if (!hub) { console.error("Run 'anet init' first."); return; }

  const key = args[1];
  if (!key) {
    console.log("\nUsage: anet activate <license-key>\n\nExample: anet activate anet-XXXX-XXXX-XXXX-XXXX\n");
    return;
  }

  try {
    const res = await fetch(`${hub}/api/license/activate`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }).then(r => r.json() as any);

    if (res.ok) {
      console.log(`\n  ✅ License activated: ${res.type.toUpperCase()}`);
      console.log(`  Valid for ${res.expires_in_days} days\n`);
    } else {
      console.error(`  ❌ Activation failed: ${res.error}\n`);
    }
  } catch (e: any) { console.error(friendlyError(e)); }
}

// ── doctor (diagnostic) ──

// Auto-detect node config issues a fix run can repair. Returns a list of
// human-readable problems plus actionable migrations.
type NodeIssue =
  | { kind: "legacy_alias_field"; from: string; to: string }
  | { kind: "legacy_resume_field" }
  | { kind: "legacy_runtime_name"; from: string }
  | { kind: "stale_dev_hub"; current: string }
  | { kind: "missing_token" }
  | { kind: "user_token"; prefix: string }
  | { kind: "untyped_token"; preview: string }
  | { kind: "missing_node_id" };

function diagnoseNode(id: string): { raw: Record<string, any>; issues: NodeIssue[] } | null {
  const p = join(nodesDir(), id, "config.json");
  if (!existsSync(p)) return null;
  let raw: Record<string, any>;
  try { raw = JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
  const gc = loadGlobal();
  const issues: NodeIssue[] = [];
  if (raw.alias && !raw.name && !raw.node_name) issues.push({ kind: "legacy_alias_field", from: "alias", to: "name" });
  if (raw.resume && !raw.session) issues.push({ kind: "legacy_resume_field" });
  if (raw.runtime === "claude-code") issues.push({ kind: "legacy_runtime_name", from: raw.runtime });
  // Known stale dev IPs that pre-V3 docs leaked into node configs. Treat any
  // non-empty hub != global hub as suspect when the global one is set.
  const STALE_HUBS = ["http://47.77.216.1:9200"];
  if (raw.hub && (STALE_HUBS.includes(raw.hub) || (gc.hub && raw.hub !== gc.hub))) {
    issues.push({ kind: "stale_dev_hub", current: raw.hub });
  }
  const rawToken = String(raw.token || "");
  if (!rawToken) issues.push({ kind: "missing_token" });
  else if (rawToken.startsWith("utok_") || rawToken.startsWith("atok_")) {
    issues.push({ kind: "user_token", prefix: rawToken.slice(0, 4) });
  } else if (!rawToken.startsWith("ntok_")) {
    issues.push({ kind: "untyped_token", preview: String(raw.token).slice(0, 8) + "…" });
  }
  if (!raw.node_id) issues.push({ kind: "missing_node_id" });
  return { raw, issues };
}

async function migrateNode(id: string, opts: { hub: string; utok: string; networkId: string }): Promise<{ ok: boolean; changes: string[]; error?: string }> {
  const p = join(nodesDir(), id, "config.json");
  const diag = diagnoseNode(id);
  if (!diag) return { ok: false, changes: [], error: "diagnose failed" };
  const { raw, issues } = diag;
  if (!issues.length) return { ok: true, changes: [] };

  const changes: string[] = [];
  // Field renames
  if (raw.alias && !raw.name) { raw.name = raw.alias; delete raw.alias; changes.push("alias→name"); }
  if (raw.resume && !raw.session) { raw.session = raw.resume; delete raw.resume; changes.push("resume→session"); }
  if (raw.runtime === "claude-code") { raw.runtime = "claude-code-cli"; changes.push("runtime claude-code→claude-code-cli"); }
  // Stale hub URL → use global hub
  if (raw.hub && opts.hub && raw.hub !== opts.hub) {
    const wasStaleDev = ["http://47.77.216.1:9200"].includes(raw.hub);
    if (wasStaleDev || raw.hub.includes("47.77.216.1")) {
      raw.hub = opts.hub; changes.push(`hub→${opts.hub}`);
    }
  }
  // Backfill node_id / node_name / anet_version
  if (!raw.anet_version) raw.anet_version = "0.1.0";
  if (!raw.node_id) { raw.node_id = `n_${Math.random().toString(16).slice(2, 10)}`; changes.push(`node_id=${raw.node_id}`); }
  if (!raw.node_name) raw.node_name = raw.name || id;

  // Token: if missing, user-scoped, or untyped, request a fresh ntok_ from hub
  const tokenStr = String(raw.token || "");
  if (!tokenStr || !tokenStr.startsWith("ntok_")) {
    try {
      const res = await fetch(`${opts.hub}/api/auth/node-token`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.utok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ network_id: opts.networkId, node_name: raw.node_name }),
      });
      const body = await res.json() as any;
      if (!body?.ok || !body.token) {
        return { ok: false, changes, error: `node-token request failed: ${body?.error || res.status}` };
      }
      raw.token = body.token;
      changes.push(tokenStr ? `token→ntok_…${body.token.slice(-6)}` : `token=ntok_…${body.token.slice(-6)}`);
    } catch (e: any) {
      return { ok: false, changes, error: `node-token request threw: ${e.message}` };
    }
  }

  writeFileSync(p, JSON.stringify(raw, null, 2) + "\n");
  return { ok: true, changes };
}

async function doctorCommand() {
  const fix = args.includes("--fix");
  console.log(`\nanet doctor — System Diagnostic${fix ? " (auto-fix mode)" : ""}\n`);
  let ok = 0, warn = 0, fail = 0;
  const check = (name: string, pass: boolean, detail?: string) => {
    if (pass) { console.log(`  ✅ ${name}${detail ? ` (${detail})` : ""}`); ok++; }
    else { console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
  };
  const info = (name: string, detail: string) => { console.log(`  ℹ  ${name}: ${detail}`); };
  const warning = (name: string, detail: string) => { console.log(`  ⚠  ${name}: ${detail}`); warn++; };

  // 1. Global config
  const gc = loadGlobal();
  check("Global config (~/.anet/config.json)", !!gc.hub, gc.hub || "missing — run: anet init");
  if (gc.token) check("Auth token configured", true);
  else warning("Auth token", "not set — agents connect without auth");

  // 2. Hub connectivity
  if (gc.hub) {
    try {
      const health = await fetch(`${gc.hub}/health`, { headers: authHeaders() }).then(r => r.json() as any);
      check("CommHub reachable", health.ok === true, `${gc.hub} v${health.version || "?"}`);
      if (health.api_version) info("API version", health.api_version);
      info("Sessions", `${health.sessions_count || health.sessions || 0} registered`);
      info("SSE connections", `${Object.keys(health.sse_sessions || {}).length} active`);
      if (health.license) info("License", health.license);
      if (health.multi_network) check("Multi-network", true);
    } catch (e: any) {
      check("CommHub reachable", false, `${gc.hub} — ${e.message}`);
    }
  }

  // 3. Nodes — also detect legacy/broken configs and (with --fix) migrate.
  const ids = listProfileIds();
  check("Nodes configured", ids.length > 0, `${ids.length} node(s)`);
  let needsMigration: string[] = [];
  for (const id of ids) {
    const p = loadProfile(id);
    const name = nodeDisplayName(id, p);
    const runtime = normalizeRuntime(p || undefined);
    const pid = join(nodesDir(), id, ".pid");
    const alive = existsSync(pid) ? (() => { try { process.kill(parseInt(readFileSync(pid, "utf-8")), 0); return true; } catch { return false; } })() : false;
    info(`  ${name}`, `${runtime} ${alive ? "● running" : "○ stopped"} node_id=${p?.node_id || "-"}`);
    const diag = diagnoseNode(id);
    if (diag && diag.issues.length) {
      needsMigration.push(id);
      for (const issue of diag.issues) {
        const detail = (() => {
          switch (issue.kind) {
            case "legacy_alias_field": return "config still uses 'alias' (V2 era); should be 'name'";
            case "legacy_resume_field": return "config still uses 'resume'; should be 'session'";
            case "legacy_runtime_name": return `runtime '${issue.from}' is V2; should be 'claude-code-cli'`;
            case "stale_dev_hub": return `hub='${issue.current}' doesn't match global hub`;
            case "missing_token": return "no token field — V3 SSE requires ntok_";
            case "user_token": return `token is ${issue.prefix}_ user-scoped; SSE requires ntok_`;
            case "untyped_token": return `token has no V3 prefix (preview '${issue.preview}')`;
            case "missing_node_id": return "no node_id field";
          }
        })();
        warning(`    ↳ ${name}`, detail);
      }
    }
  }
  if (needsMigration.length) {
    if (fix) {
      console.log(`\n  ⚙  Auto-fixing ${needsMigration.length} node(s)...`);
      if (!gc.hub || !gc.token || !gc.network_id) {
        console.log(`  ❌ Cannot migrate: global config missing hub/token/network_id. Run 'anet login' first.`);
      } else {
        for (const id of needsMigration) {
          const result = await migrateNode(id, { hub: gc.hub, utok: gc.token, networkId: gc.network_id });
          if (result.ok) {
            console.log(`     ✅ ${id}: ${result.changes.join(" / ") || "no changes"}`);
            ok++;
          } else {
            console.log(`     ❌ ${id}: ${result.error}`);
            fail++;
          }
        }
      }
    } else {
      info("→ run", `anet doctor --fix  to auto-migrate ${needsMigration.length} node(s)`);
    }
  }

  // 4. Dependencies
  try { execSync("claude --version", { stdio: "pipe" }); check("Claude Code CLI", true); } catch { warning("Claude Code CLI", "not found (needed for claude-code-cli runtime)"); }
  try { execSync("codex --version", { stdio: "pipe" }); check("Codex CLI", true); } catch { warning("Codex CLI", "not found (needed for codex-sdk runtime)"); }
  try { execSync("bun --version", { stdio: "pipe" }); check("Bun runtime", true); } catch { warning("Bun", "not found (needed for commhub-server)"); }

  // 5. .mcp.json
  const mcpPath = join(process.cwd(), ".mcp.json");
  if (existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
      const hasCommhub = Object.values(mcp.mcpServers || {}).some((s: any) => s.command?.includes("node-server") || JSON.stringify(s).includes("commhub"));
      check(".mcp.json commhub channel", !!hasCommhub, hasCommhub ? "configured" : "missing commhub server entry");
    } catch { warning(".mcp.json", "parse error"); }
  } else {
    info(".mcp.json", "not found in current directory");
  }

  // 6. Telegram channel env (silent token loss is a known foot-gun)
  const tgEnv = join(home, ".claude", "channels", "telegram", ".env");
  if (existsSync(tgEnv)) {
    const size = (() => { try { return statSync(tgEnv).size; } catch { return 0; } })();
    if (size === 0 || size === 1) {
      warning("Telegram bot token", `~/.claude/channels/telegram/.env is empty (size=${size}); token lost. Reconfigure: /telegram:configure`);
    } else {
      check("Telegram channel env", true, `~/.claude/channels/telegram/.env (${size}B)`);
    }
  } else {
    info("Telegram channel env", "not configured (no telegram bot token)");
  }

  console.log(`\n  Result: ${ok} ok, ${warn} warnings, ${fail} errors\n`);
}

switch (command) {
  case "init":
    if (args[1] === "project") initProject();
    else if (args[1] === "profile") await initProfile();
    else await initGlobal();
    break;
  case "create": await createCommand(); break;
  case "server": serverCommand(); break;
  case "hub": serverCommand(); break; // anet hub start/dashboard/config
  case "node": // anet node create/start/stop/resume/delete/ls/rename
    switch (args[1]) {
      case "create": args.splice(0, 1); await createCommand(); break;
      case "start": args.splice(0, 1); await startCommand(); break;
      case "stop": args.splice(0, 1); await stopCommand(); break;
      case "resume": args.splice(0, 1); await resumeCommand(); break;
      case "delete": args.splice(0, 1); await deleteCommand(); break;
      case "rename": args.splice(0, 1); await renameCommand(); break;
      case "ls": case "list": lsCommand(); break;
      default: console.log(`Usage: anet node <create|start|stop|resume|delete|ls|rename> [name]`); break;
    }
    break;
  case "start": await startCommand(); break;   // backward compat
  case "resume": await resumeCommand(); break; // backward compat
  case "rename": await renameCommand(); break; // backward compat
  case "stop": await stopCommand(); break; // backward compat
  case "delete": await deleteCommand(); break; // backward compat
  case "import": importCommand(); break;
  case "channel": await channelCommand(); break;
  case "setup": await setupCommand(); break;
  case "upgrade": upgradeCommand(); break;
  case "session": sessionCommand(); break;
  case "ls": case "list": lsCommand(); break;
  case "status": await statusCommand(); break;
  case "tasks": await tasksCommand(); break;
  case "doctor": await doctorCommand(); break;
  case "license": await licenseCommand(); break;
  case "activate": await activateCommand(); break;
  case "passwd": await passwdCommand(); break;
  case "token": await tokenCommand(); break;
  case "demo": await demoCommand(); break;
  case "logs": logsCommand(); break;
  case "info": await infoCommand(); break;
  case "config": configShowCommand(); break;
  case "login": await loginCommand(); break;
  case "register": await registerCommand(); break;
  case "quickstart": await quickstartCommand(); break;
  case "logout": logoutCommand(); break;
  case "whoami": await whoamiCommand(); break;
  case "network": await networkCommand(); break;
  case "run": runCommand(); break;
  case "-v": case "--version": case "version": {
    printVersionReport();
    break;
  }
  case "--help": case "-h": case undefined: printHelp(); break;
  default:
    if (resolveNodeRef(command)) { args.unshift("start"); await startCommand(); }
    else { console.error(`Unknown: ${command}`); printHelp(); process.exit(1); }
}
