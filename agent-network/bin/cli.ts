#!/usr/bin/env node
/**
 * anet — AI Agent Network CLI
 *
 * anet init                    配置 hub（全局）
 * anet init project            配置当前项目
 * anet create commander        创建 node
 * anet start commander         启动
 * anet ls                      查看状态
 * anet run                     独立 SSE Agent
 */

import { chmodSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { spawn, execSync } from "child_process";
import { createHash } from "crypto";
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
}

type RuntimeName = "claude-code-cli" | "codex-sdk" | "claude-agent-sdk";

function normalizeRuntime(profileOrRuntime?: Profile | string): RuntimeName {
  if (typeof profileOrRuntime === "string") {
    if (profileOrRuntime === "codex" || profileOrRuntime === "codex-sdk") return "codex-sdk";
    if (profileOrRuntime === "claude" || profileOrRuntime === "claude-sdk" || profileOrRuntime === "claude-agent-sdk") return "claude-agent-sdk";
    if (profileOrRuntime === "agent-sdk") return "claude-agent-sdk";
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
  return `n_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
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
    token: project.token || gc.token || "",
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
  return join(new URL(".", import.meta.url).pathname, "..", "..", "package.json");
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
  console.log(`anet v${versions.anet.version}`);
  console.log(formatDetectedVersion(versions.agentNode));
  // Show SDK sub-dependencies if agent-node is installed
  if (versions.agentNode.state === "ok") {
    try {
      const sub = detectAgentNodeSubDeps();
      if (sub.claudeAgentSdk) console.log(`  └ @anthropic-ai/claude-agent-sdk v${sub.claudeAgentSdk}`);
      if (sub.codexSdk) console.log(`  └ @openai/codex-sdk v${sub.codexSdk}`);
    } catch {}
  }
  console.log(formatDetectedVersion(versions.commhubServer));
  console.log(formatDetectedVersion(versions.claude));
  console.log(formatDetectedVersion(versions.codex));
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

  console.log(`\n完成！下一步: anet create <node-name>`);
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
    return "Cannot connect to CommHub server. Is it running?\n  Start: anet server local\n  Or check: anet doctor";
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
  anet create <name>            Create a node (interactive)
  anet start <name>             Start node (resume session)
  anet stop <name>              Stop a running node
  anet delete <name> --force    Delete node and config
  anet rename <ref> <new-name>  Rename a node (by node_id or name)
  anet ls                       List nodes with network status
  anet info <name>              Detailed node info + server status
  anet status                   Network overview (agents + tasks)
  anet tasks [status]           Query tasks (replied/failed/delivered)

Session:
  anet start <name> --new-session   Start with fresh session
  anet resume <name> --session <id> Resume specific session
  anet session ls               List Claude Code sessions

Channel:
  anet channel add telegram <name> --bot-token <tok> --allow <uid>
  anet channel ls [name]        List channels

Setup:
  anet init                     Configure hub URL (global)
  anet init project             Setup project (channel plugin)
  anet setup                    Install runtime dependencies
  anet server local              One-command local server + setup
  anet server start             Start CommHub Server
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
  anet quickstart                 3-minute guided setup
  anet demo                      Live system dashboard
  anet init --hub http://IP:9200  Manual setup
  anet create my-agent
  anet start my-agent
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

  console.log(`\n✅ Project ready. Next: anet create <node-name>`);
}

// ── init profile ──

async function initProfile() {
  console.warn(`[deprecated] anet init profile is now anet create.`);
  console.warn(`             Run: anet create <node-name> [--runtime ...]\n`);
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

  const runtime = normalizeRuntime(opts.runtime || "claude-code-cli");
  const defaultModel = runtime === "codex-sdk" ? "gpt-5.4" : undefined;

  const profile: Profile = {
    anet_version: "0.1.0",
    node_id: generateNodeId(),
    node_name: id,
    alias: id,
    runtime,
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

  const profile = createProfileFromOpts(id, opts);

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
  console.log(`\nStart: anet start ${id}`);
}

async function createCommand(idOverride?: string) {
  const id = idOverride || args[1];
  if (!id) return createInteractiveCommand();
  if (id.startsWith("--")) {
    console.error("Usage: anet create <node-name> [--runtime claude-code-cli|codex-sdk|claude-agent-sdk] [--model ...] [--tools ...]");
    console.error("Or run fully interactive: anet create");
    process.exit(1);
  }
  validateNodeName(id);

  if (resolveNodeRef(id)) {
    console.error(`Node "${id}" already exists: .anet/nodes/${id}/config.json`);
    process.exit(1);
  }

  const opts = parseOpts();
  const profile = createProfileFromOpts(id, opts);
  saveCreatedNode(id, profile);
  checkRuntimeDependency(normalizeRuntime(profile), "create");

  console.log(`\n[anet] Created node "${id}" (${normalizeRuntime(profile)})`);
  if (normalizeRuntime(profile) === "claude-code-cli") {
    printClaudeCodeNotice();
  }
  console.log(`[anet] ⚠ dangerouslySkipPermissions and teammateMode enabled by default.`);
  console.log(`[anet] To disable: edit .anet/nodes/${id}/config.json → flags`);
  console.log(`\nStart: anet start ${id}`);
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

  const hub = gc.hub;
  if (!hub) {
    console.error("\nRun 'anet init' first to configure hub URL");
    process.exit(1);
  }

  const profile: Profile = {
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
    console.error(`Node "${id}" not found. Create it first: anet create ${id}`);
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

  // Token already merged in loadProfile: project > global
  const token = profile.token || "";
  if (token) console.log(`[anet] Token: ${token.slice(0, 8)}...`);
  else console.log(`[anet] Warning: no token configured. Check ~/.anet/config.json`);

  if (runtime === "codex-sdk" || runtime === "claude-agent-sdk") {
    // spawn agent-node
    const agentArgs = [
      "--config", join(nodesDir(), nodeId, "config.json"),
      "--alias", displayName,
    ];
    if (forceNewSession) agentArgs.push("--new-session", "true");

    const env = { ...process.env, ...(token ? { COMMHUB_TOKEN: token } : {}) };
    for (const [k, v] of Object.entries(profile.env)) {
      env[k] = v.replace(/^~/, home);
    }

    const child = spawn("agent-node", agentArgs, { env, stdio: "inherit", shell: true });
    const pidFile = join(nodesDir(), nodeId, ".pid");
    if (child.pid) writeFileSync(pidFile, String(child.pid));
    child.on("exit", (code) => {
      try { rmSync(pidFile, { force: true }); } catch {}
      process.exit(code || 0);
    });
  } else {
    // spawn claude CLI
    const env = { ...process.env, COMMHUB_ALIAS: profile.alias, ...(token ? { COMMHUB_TOKEN: token } : {}) };
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
        console.log(`[anet]   anet resume ${nodeId} --session <session-id>`);
        if (forceNewSession && session) {
          console.log(`[anet] Next "anet start ${nodeId}" will still resume ${session.slice(0, 8)}... until you rebind.`);
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
    console.error("Usage: anet resume <node-name> --session <session-id>");
    console.error("Daily start/resume: anet start <node-name>");
    return;
  }

  const resolved = resolveNodeRef(ref);
  let nodeId = resolved?.id || ref;
  let profile = resolved?.profile || null;
  const opts = parseOpts();
  const sessionId = opts.session;

  if (!sessionId) {
    console.warn(`[deprecated] anet resume <node-name> without --session is now anet start <node-name>.`);
    await launchAgent(nodeId, false);
    return;
  }

  if (!resolved) validateNodeName(nodeId);
  if (!profile) {
    const createOpts = { ...opts, session: sessionId, runtime: opts.runtime || "claude-code-cli" } as ReturnType<typeof parseOpts>;
    profile = createProfileFromOpts(nodeId, createOpts);
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
    saveProfile(nodeId, stored);
  }

  console.log(`[anet] Saved session ${sessionId.slice(0, 8)}... to .anet/nodes/${nodeId}/config.json\n`);
  await launchAgent(nodeId, false);
}

function showProfiles(cmd: string) {
  const ids = listProfileIds();
  if (ids.length === 0) {
    console.log("No nodes. Run: anet create <node-name>");
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
  if (sub === "start") {
    const opts = parseOpts();
    const sc = loadServerConfig();

    // CLI > server config > global config > auto-generate
    const port = opts.port || sc.port || "9200";
    const host = opts.host || sc.host || "0.0.0.0";
    let token = opts.token || sc.token || getToken();

    // Auto-generate token on first start
    if (!token) {
      token = crypto.randomUUID().replace(/-/g, "");
      console.log(`[anet] Generated auth token: ${token}`);
      console.log(`[anet] Save this token — agents need it to connect.\n`);
    }

    // Save to server config + global config
    saveServerConfig({ port, host, token });
    const gc = loadGlobal();
    if (!gc.token) { gc.token = token; saveGlobal(gc); }

    console.log(`[anet] Starting CommHub Server on ${host}:${port}${token ? " (auth enabled)" : ""}...`);

    const env: Record<string, string> = { ...process.env as any, PORT: port, HOST: host };
    if (token) env.COMMHUB_AUTH_TOKEN = token;

    // bunx 跑 commhub-server（server 是 bun-only）
    const child = spawn("bunx", ["@sleep2agi/commhub-server"], { env, stdio: "inherit", shell: true });
    child.on("exit", (code) => process.exit(code || 0));

  } else if (sub === "local") {
    // anet server local — one-command local setup
    // Starts server + configures hub + registers user + ready to go
    const opts = parseOpts();
    const port = opts.port || "9200";
    const username = opts.username || opts.user || "local";
    const password = opts.password || opts.pass || "local123456";

    console.log(`
╔══════════════════════════════════════════════════╗
║   🏠 anet server local — One-command setup       ║
╚══════════════════════════════════════════════════╝
`);

    console.log(`  Starting CommHub Server on port ${port}...`);

    const env: Record<string, string> = { ...process.env as any, PORT: port, HOST: "127.0.0.1" };
    const child = spawn("bunx", ["@sleep2agi/commhub-server"], { env, stdio: "pipe", shell: true });

    // Wait for server to start
    await new Promise(r => setTimeout(r, 4000));

    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json() as any);
      if (!health.ok) throw new Error("server not ready");
      console.log(`  ✅ Server running on http://127.0.0.1:${port}`);
    } catch {
      console.error(`  ❌ Server failed to start. Is Bun installed?`);
      child.kill();
      return;
    }

    // Configure hub
    const gc = loadGlobal();
    gc.hub = `http://127.0.0.1:${port}`;
    saveGlobal(gc);
    console.log(`  ✅ Hub configured: ${gc.hub}`);

    // Register + login
    try {
      await fetch(`${gc.hub}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const login = await fetch(`${gc.hub}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      }).then(r => r.json() as any);

      if (login.ok) {
        gc.token = login.token;
        gc.user = login.user;
        const nets = await fetch(`${gc.hub}/api/networks`, { headers: { Authorization: `Bearer ${login.token}` } }).then(r => r.json() as any);
        if (nets.networks?.length > 0) {
          gc.network_id = nets.networks[0].network_id;
          gc.network_name = nets.networks[0].network_name;
        }
        saveGlobal(gc);
        console.log(`  ✅ Logged in as "${username}"`);
      }
    } catch {}

    // Get license info
    try {
      const lic = await fetch(`${gc.hub}/api/license`).then(r => r.json() as any);
      if (lic.license) console.log(`  ✅ License: ${lic.license.type} (${lic.license.days_left} days)`);
    } catch {}

    console.log(`
╔══════════════════════════════════════════════════╗
║   🎉 Ready! Server running in foreground.        ║
║                                                   ║
║   Next steps (in another terminal):               ║
║     anet create my-agent                          ║
║     anet start my-agent                           ║
║     anet status                                   ║
║                                                   ║
║   Press Ctrl+C to stop the server.                ║
╚══════════════════════════════════════════════════╝
`);

    // Forward server output
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    child.on("exit", (code) => process.exit(code || 0));
    process.on("SIGINT", () => { child.kill(); process.exit(0); });

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

  } else {
    console.log(`
anet server <command>

  start [options]    Start CommHub Server
  config [options]   Show/set server config

Options:
  --port <port>      Port (default: 9200)
  --host <host>      Bind address (default: 0.0.0.0)
  --token <token>    Auth token

Config: ${serverConfigPath()}
First 'anet server start' saves config, after that just 'anet server start'.

Example:
  anet server start --port 9200 --token my-secret   # 首次，保存配置
  anet server start                                  # 之后直接启动
  anet server config                                 # 查看配置
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

  console.log(`\nImported ${created} session(s). Use: cd <project> && anet resume <alias>`);
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

function renameCommand() {
  const fromRef = args[1];
  const newName = args[2];
  if (!fromRef || !newName) {
    console.log(`
anet rename <node-id|node-name> <new-node-name>
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
anet stop <node-id|node-name>

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
anet delete <node-id|node-name>

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
    const storedProfile = profile ? (loadStoredProfile(nodeId) || profile) : null;
    if (!profile) {
      console.error(`Node "${nodeRef}" not found. Create it first: anet create ${nodeRef} --runtime codex-sdk`);
      process.exit(1);
    }

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

  // Step 2: Register/Login
  if (!gc.token || !gc.user) {
    console.log("Step 2/4: 创建账号");
    const opts2 = parseOpts();
    const username = opts2.username || opts2.user || await ask("用户名: ");
    const password = opts2.password || opts2.pass || await ask("密码 (≥6位): ");
    closeRL();
    if (!username || !password) { console.error("需要用户名和密码。用法: anet quickstart --username xxx --password xxx"); return; }

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
  const agentName = opts2.agent || opts2.name || await ask("Agent 名称 [my-agent]: ") || "my-agent";
  closeRL();

  // Check if already exists
  const existing = resolveNodeRef(agentName);
  if (!existing) {
    let runtime = opts2.runtime || "codex-sdk";
    // Only show interactive selection if no runtime specified and TTY available
    if (!opts2.runtime && process.stdin.isTTY) {
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
    } else if (!opts2.runtime) {
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
║   启动 Agent:  anet start ${agentName.padEnd(20)}   ║
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
  const hub = gc.hub;
  if (!hub) { console.error("Run 'anet init' first."); return; }
  const opts = parseOpts();

  const username = opts.username || opts.user || await ask("Username: ");
  const password = opts.password || opts.pass || await ask("Password (min 6): ");
  const email = opts.email || await ask("Email (optional): ");
  closeRL();

  if (!username || !password) { console.error("Username and password required."); return; }

  try {
    const res = await fetch(`${hub}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  const hub = gc.hub;
  if (!hub) { console.error("Run 'anet init' first."); return; }

  const opts = parseOpts();

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
    // Get default network
    const nets = await fetch(`${hub}/api/networks`, { headers: { Authorization: `Bearer ${res.token}` } }).then(r => r.json() as any);
    if (nets.ok && nets.networks?.length > 0) {
      gc.network_id = nets.networks[0].network_id;
      gc.network_name = nets.networks[0].network_name;
    }
    saveGlobal(gc);
    console.log(`[anet] Logged in as ${res.user.username}`);
    if (gc.network_name) console.log(`[anet] Network: ${gc.network_name} (${gc.network_id?.slice(0, 12)})`);
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
      for (const n of res.networks) {
        const current = n.network_id === gc.network_id ? " ← current" : "";
        console.log(`  ${n.network_name.padEnd(20)} ${n.network_id.slice(0, 16)}${current}`);
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

  console.log(`
anet network <command>

  ls                    List my networks
  create <name>         Create a new network
  rename <old> <new>    Rename a network
  delete <name> --force Delete a network
  use <name>            Switch to a network
  info                  Current network details + stats
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

  // Default: list tokens
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
  const gc = loadGlobal();
  const hub = gc.hub;
  if (!hub) { console.error("Run 'anet init' or 'anet server local' first."); return; }

  console.log(`
╔══════════════════════════════════════════════════╗
║  🎬  Agent Network Demo                          ║
╚══════════════════════════════════════════════════╝
`);

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
  const step = async (n: number, msg: string) => {
    await delay(300);
    console.log(`  ${n}. ${msg}`);
  };

  try {
    // 1. Health check
    await step(1, "Checking server...");
    const health = await fetch(`${hub}/health`, { headers: authHeaders() }).then(r => r.json() as any);
    if (!health.ok) { console.error("  ❌ Server not reachable. Run: anet server local"); return; }
    console.log(`     ✅ CommHub online at ${hub}`);

    // 2. License
    await step(2, "License status...");
    const lic = await fetch(`${hub}/api/license`, { headers: authHeaders() }).then(r => r.json() as any);
    if (lic.license) console.log(`     ✅ ${lic.license.type.toUpperCase()} — ${lic.license.days_left ?? "∞"} days left`);

    // 3. User
    await step(3, "User info...");
    const token = gc.token;
    if (token) {
      const me = await fetch(`${hub}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json() as any).catch(() => null);
      if (me?.ok) console.log(`     ✅ Logged in as ${me.user.username} — ${me.networks?.length || 0} network(s)`);
      else console.log(`     ⚠ Token expired. Run: anet login`);
    } else {
      console.log(`     ⚠ Not logged in. Run: anet login`);
    }

    // 4. Stats
    await step(4, "Network stats...");
    const stats = await fetch(`${hub}/api/stats`, { headers: authHeaders() }).then(r => r.json() as any);
    console.log(`     📊 Tasks: ${stats.tasks?.total || 0} | Sessions: ${stats.sessions?.by_status?.reduce((a: number, s: any) => a + s.count, 0) || 0} | Nodes: ${stats.nodes?.total || 0}`);

    // 5. Recent tasks
    await step(5, "Recent activity...");
    const tasks = await fetch(`${hub}/api/tasks?limit=3`, { headers: authHeaders() }).then(r => r.json() as any);
    if (tasks.tasks?.length > 0) {
      for (const t of tasks.tasks.slice(0, 3)) {
        console.log(`     ${t.status.padEnd(10)} ${(t.from_name || "?").padEnd(12)} → ${(t.to_name || "?").padEnd(12)} ${(t.content || "").slice(0, 30)}`);
      }
    } else {
      console.log(`     (no tasks yet)`);
    }

    // 6. Nodes
    await step(6, "Local nodes...");
    const ids = listProfileIds();
    if (ids.length > 0) {
      for (const id of ids.slice(0, 5)) {
        const p = loadProfile(id);
        const name = nodeDisplayName(id, p);
        console.log(`     ${name.padEnd(16)} [${normalizeRuntime(p || undefined)}]`);
      }
    } else {
      console.log(`     (none — run: anet create my-agent)`);
    }

    console.log(`
╔══════════════════════════════════════════════════╗
║  Next steps:                                      ║
║    anet create my-agent       Create an agent      ║
║    anet start my-agent        Start it             ║
║    anet status                See who's online     ║
║    anet tasks                 See task history     ║
║    anet doctor                Full diagnostic      ║
╚══════════════════════════════════════════════════╝
`);
  } catch (e: any) {
    console.error(`  ❌ ${e.message}`);
  }
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

async function doctorCommand() {
  console.log("\nanet doctor — System Diagnostic\n");
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
      check("CommHub reachable", health.ok === true, gc.hub);
      info("Sessions", `${health.sessions_count || 0} registered`);
      info("SSE connections", `${Object.keys(health.sse_sessions || {}).length} active`);
    } catch (e: any) {
      check("CommHub reachable", false, `${gc.hub} — ${e.message}`);
    }
  }

  // 3. Nodes
  const ids = listProfileIds();
  check("Nodes configured", ids.length > 0, `${ids.length} node(s)`);
  for (const id of ids.slice(0, 5)) {
    const p = loadProfile(id);
    const name = nodeDisplayName(id, p);
    const runtime = normalizeRuntime(p || undefined);
    const pid = join(nodesDir(), id, ".pid");
    const alive = existsSync(pid) ? (() => { try { process.kill(parseInt(readFileSync(pid, "utf-8")), 0); return true; } catch { return false; } })() : false;
    info(`  ${name}`, `${runtime} ${alive ? "● running" : "○ stopped"} node_id=${p?.node_id || "-"}`);
  }

  // 4. Dependencies
  try { execSync("claude --version", { stdio: "pipe" }); check("Claude Code CLI", true); } catch { warning("Claude Code CLI", "not found (needed for claude-agent-sdk runtime)"); }
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
  case "start": startCommand(); break;
  case "resume": resumeCommand(); break;
  case "rename": renameCommand(); break;
  case "stop": await stopCommand(); break;
  case "delete": await deleteCommand(); break;
  case "import": importCommand(); break;
  case "channel": channelCommand(); break;
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
    if (resolveNodeRef(command)) { args.unshift("start"); startCommand(); }
    else { console.error(`Unknown: ${command}`); printHelp(); process.exit(1); }
}
