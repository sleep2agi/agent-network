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
import { homedir } from "os";
import { spawn, execSync, execFileSync } from "child_process";
import { createHash, randomBytes, randomUUID } from "crypto";
import { checkbox, confirm, select } from "@inquirer/prompts";

const args = process.argv.slice(2);
const command = args[0];
const home = process.env.HOME || process.env.USERPROFILE || "~";

// ── Config helpers ──

function globalConfigPath() { return join(home, ".anet", "config.json"); }
function serverConfigPath() { return join(home, ".anet", "server", "config.json"); }
function adminUtokPath() { return join(home, ".anet", "server", "admin-utok.json"); }
function nodesDir() { return join(process.cwd(), ".anet", "nodes"); }
function encodeCwd(cwd: string): string { return cwd.replace(/\//g, "-"); }
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function killTmuxSession(sessionName: string) {
  try { execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "pipe" }); } catch {}
}
function startNodeTmuxSession(sessionName: string, alias: string) {
  execFileSync("tmux", ["new-session", "-d", "-s", sessionName, `anet node start ${shellQuote(alias)}`], { stdio: "pipe" });
}
function sessionFileExists(uuid: string, cwd: string = process.cwd()): boolean {
  if (!uuid) return false;
  return existsSync(join(homedir(), ".claude", "projects", encodeCwd(cwd), `${uuid}.jsonl`));
}

let claudeSessionIdSupport: boolean | null = null;
function claudeSupportsSessionId(): boolean {
  if (claudeSessionIdSupport !== null) return claudeSessionIdSupport;
  try {
    const help = execSync("claude --help", { encoding: "utf-8", timeout: 5000 });
    claudeSessionIdSupport = help.includes("--session-id");
  } catch {
    claudeSessionIdSupport = false;
  }
  return claudeSessionIdSupport;
}

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
  const p = serverConfigPath();
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
}

function serverAuthTokenFromConfig(config = loadServerConfig()): string {
  return config.auth_token || config.token || "";
}

function commhubDbPath() {
  return process.env.COMMHUB_DB || join(home, ".commhub", "commhub.db");
}

function saveAdminUtok(data: Record<string, any>) {
  const dir = join(home, ".anet", "server");
  const p = adminUtokPath();
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
}

function loadAdminUtok(): Record<string, any> {
  const p = adminUtokPath();
  if (existsSync(p)) try { return JSON.parse(readFileSync(p, "utf-8")); } catch {}
  return {};
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
  systemPrompt?: string;
  // Team-scale demo metadata (issue #51 / RFC-008). Read by Phase 2 leader
  // fan-out logic — set by `anet demo sci-team` scaffold.
  team?: string;
  role?: "leader" | "worker";
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
    // RFC-008 / issue #51 team-scale demo metadata. Optional on every node;
    // present only when set by `anet demo sci-team` (Phase 1 scaffold) or
    // a future RFC-008 client. Without this persist, agent-node reads back a
    // config.json missing systemPrompt / team / role and the scaffold's
    // placeholder leader/researcher prompts are silently dropped.
    ...(normalized.systemPrompt ? { systemPrompt: normalized.systemPrompt } : {}),
    ...(normalized.team ? { team: normalized.team } : {}),
    ...(normalized.role ? { role: normalized.role } : {}),
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
    // `command` is a shell builtin; use /bin/sh -c with shell-safe quoting
    // (shellQuote, NOT JSON.stringify which lets $() / `` expand inside "...")
    execFileSync("/bin/sh", ["-c", `command -v ${shellQuote(name)}`], { stdio: "ignore" });
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

function getAnetVersion(): string {
  try { return JSON.parse(readFileSync(packageJsonPath(), "utf-8")).version || ""; }
  catch { return ""; }
}

// 🅗2 temp fallback per #61 — anet@latest 用户从 dashboard 0.4.5-preview.1 (pin
// stale 80 rounds) → 0.4.2 (current @latest) 是 *功能 regress*, 因为 dashboard
// preview channel 远超 latest channel。短期双 channel 都拉 @preview, 等 N站马
// promote 0.4.5 → @latest 后 swap anet@latest 路径回 @latest (🅗1)。
// TODO(#61 phase-2): swap anet@latest fallback "preview" → "latest" once
//   @sleep2agi/agent-network-dashboard promotes 0.4.5 stable.
function dashboardReleaseTag(): string {
  const envOverride = process.env.ANET_DASHBOARD_VERSION;
  if (envOverride) return envOverride;
  return "preview";
}

// #89 — npx leaves half-baked `.agent-network-dashboard-<rand>` staging dirs in
// its cache when a previous run was interrupted/concurrent; the next run's rename
// then fails with ENOTEMPTY and the user is stuck until they manually nuke
// ~/.npm/_npx. Best-effort sweep of *stale* (>60s, skips an in-progress concurrent
// npx) staging dirs before spawn. Never throws — startup must not depend on this.
function cleanStaleNpxDashboardTemp() {
  try {
    const npxRoot = join(home, ".npm", "_npx");
    if (!existsSync(npxRoot)) return;
    for (const hash of readdirSync(npxRoot)) {
      const scopeDir = join(npxRoot, hash, "node_modules", "@sleep2agi");
      if (!existsSync(scopeDir)) continue;
      for (const entry of readdirSync(scopeDir)) {
        if (!entry.startsWith(".agent-network-dashboard-")) continue;
        const full = join(scopeDir, entry);
        try {
          if (Date.now() - statSync(full).mtimeMs < 60_000) continue; // in-progress
          rmSync(full, { recursive: true, force: true });
          console.log(`[anet] cleaned stale npx temp dir: ${entry}`);
        } catch {}
      }
    }
  } catch {}
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
    const output = execFileSync(commandName, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
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
    const output = execFileSync("npm", ["ls", "-g", pkgName, "--depth=0", "--json"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
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
  execFileSync("npm", ["install", "-g", pkgName], { stdio: "inherit" });
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
    token = await ask("Auth token (legacy, press Enter to skip — most users skip)");
  }
  closeRL();
  try {
    const res = await fetch(`${hub}/health`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const data = await res.json() as any;
    console.log(`✅ CommHub v${data.version} — ${data.sessions_count ?? 0} sessions, ${data.sse_connections ?? 0} SSE`);
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
    ...(opts.session || runtime === "claude-code-cli" ? { session: opts.session || randomUUID() } : {}),
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
    // Vendor presets here are *verified-with-real-call* only. Adding a new
    // vendor without per-vendor verify is forbidden (cf. preview.0-preview.2
    // incident where DeepSeek / GLM / Kimi / MiMo entries were fabricated
    // from PROVIDER_CHOICES — none worked). Add via `custom` until verified.
    console.log(`
Model guide (verified Anthropic-compatible + Claude + custom):
  - intern-s2-preview  上海 AI Lab 书生 (默认, chat.intern-ai.org.cn) [UNVERIFIED]
  - intern-s1-pro      上海 AI Lab 书生 (chat.intern-ai.org.cn)
  - MiniMax-M2.7       MiniMax (api.minimaxi.com/anthropic)
  - claude-sonnet-4-6  Anthropic Claude via the default Anthropic API.
  - claude-opus-4-6    Anthropic Claude via the default Anthropic API.
  - claude-haiku-4-5   Anthropic Claude via the default Anthropic API.
  - custom             Type both URL and model for any Anthropic-compatible
                       provider (DeepSeek / GLM / Kimi / MiMo / OpenRouter /
                       self-hosted vLLM, etc.).
  注: intern-* 走 http-api runtime — claude-agent-sdk ↔ intern endpoint 会 hang (#98)。
`);
    const modelChoice = await askChoice("Select model:", [
      { label: "intern-s2-preview",  value: "intern-s2-preview",  description: "上海 AI Lab 书生 默认 [UNVERIFIED] (http-api runtime)" },
      { label: "intern-s1-pro",      value: "intern-s1-pro",      description: "上海 AI Lab 书生 (http-api runtime)" },
      { label: "MiniMax-M2.7",       value: "MiniMax-M2.7",       description: "MiniMax (api.minimaxi.com/anthropic)" },
      { label: "claude-sonnet-4-6",  value: "claude-sonnet-4-6",  description: "Anthropic default URL" },
      { label: "claude-opus-4-6",    value: "claude-opus-4-6",    description: "Anthropic default URL" },
      { label: "claude-haiku-4-5",   value: "claude-haiku-4-5",   description: "Anthropic default URL" },
      { label: "custom",             value: "__custom__",         description: "Manually enter base URL + model" },
    ]);
    opts.model = modelChoice;

    // Preset baseUrl injection — only verified vendors. New vendor MUST land
    // here only after per-vendor verify-with-real-call (curl ANTHROPIC_BASE_URL
    // with the chosen model id and confirm 200), not by copying from
    // PROVIDER_CHOICES or docs (those have not been verified end-to-end).
    if (opts.model === "__custom__") {
      const baseUrl = await ask("ANTHROPIC_BASE_URL");
      const customModel = await ask("Model");
      if (baseUrl) opts._envs.push(`ANTHROPIC_BASE_URL=${baseUrl}`);
      opts.model = customModel;
    } else if (opts.model === "MiniMax-M2.7") {
      opts._envs.push("ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic");
    } else if (opts.model === "intern-s1-pro" || opts.model === "intern-s2-preview") {
      // Intern uses the bare hostname; no /anthropic suffix (Vincent verified
      // 2026-05-13 telegram 4227). Runtime forced to http-api: claude-agent-sdk
      // ↔ intern endpoint hangs (#98 root-cause). intern-s2-preview model id is
      // [UNVERIFIED] — pending real-call verify, intern key 待 Vincent 提供后验.
      opts._envs.push("ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn");
      opts.runtime = "http-api";
    }

    // Per-vendor signup URL hint. Only verified vendors get a hint; unverified
    // ones force the user through `custom` (where they paste their own values).
    const vendorSignupUrls: Record<string, string> = {
      "MiniMax-M2.7":      "https://platform.minimaxi.com",
      "intern-s1-pro":     "https://chat.intern-ai.org.cn/",
      "intern-s2-preview": "https://chat.intern-ai.org.cn/",
    };
    const hintUrl = vendorSignupUrls[opts.model];

    console.log(`
API key:
  Paste the provider key for the selected model.${hintUrl ? `
  📋 注册 / 拿 ${opts.model} API Key: ${hintUrl}` : ""}
  - MiniMax / 书生: token from the vendor's API Keys page.
  - Anthropic Claude: use an Anthropic Console API key.
  - Custom URL: use the key/token for that Anthropic-compatible provider
    (DeepSeek / GLM / Kimi / MiMo / OpenRouter / etc. all work via custom).
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
    const allowId = await ask("Allow User ID (numeric ID from @userinfobot)", "");
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
  // Batch mode: `anet create --batch` enters the multi-node wizard
  // (issue #55, Vincent 4335). All other create flows fall through to the
  // existing single-node create path below.
  if (!idOverride && args.includes("--batch")) {
    return await createBatchWizardCommand();
  }
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
  //
  // Vendor URL/model values must be *verified-with-real-call* before landing.
  // Entries marked "TODO unverified" had wrong base URLs / model ids in
  // preview.0-preview.2 (Vincent telegram 4227 caught it). Until each vendor
  // is re-verified (curl ANTHROPIC_BASE_URL with a known model and confirm
  // 200), prefer the `custom` path. See feedback_vendor_verify_before_hardcode.
  const MODEL_PRESETS: Record<string, { runtime: string; label: string; baseUrl?: string; envKey?: string; requiresAuth?: string; signupUrl?: string }> = {
    minimax:   { runtime: "claude-agent-sdk", label: "MiniMax（推荐，国内直连，低成本）", baseUrl: "https://api.minimaxi.com/anthropic", envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://platform.minimaxi.com" },
    // TODO unverified — Vincent 4227 incident: DeepSeek base URL / model id had not been verified end-to-end. Keep entry as a stub but do NOT trust the baseUrl until re-verified.
    deepseek:  { runtime: "claude-agent-sdk", label: "DeepSeek（代码+推理，性价比极高）[UNVERIFIED]", baseUrl: "https://api.deepseek.com/anthropic", envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://platform.deepseek.com" },
    // TODO unverified — same caveat as DeepSeek (Vincent 4227).
    glm:       { runtime: "claude-agent-sdk", label: "GLM 智谱（中文理解强）[UNVERIFIED]", baseUrl: "https://open.bigmodel.cn/anthropic", envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://open.bigmodel.cn" },
    // Verified by Vincent 2026-05-13 telegram 4227: base URL is bare hostname (no /anthropic suffix). Model id `intern-s1-pro` (lowercase).
    // runtime http-api — claude-agent-sdk ↔ intern endpoint hangs (#98 root-cause); never leave an intern preset on a runtime that hangs.
    intern:    { runtime: "http-api", label: "上海 AI Lab 书生（intern-s1-pro）", baseUrl: "https://chat.intern-ai.org.cn", envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://chat.intern-ai.org.cn/" },
    // [UNVERIFIED] — pending real-call verify, intern key 待 Vincent 提供后验 (#98 发现旧 key 过期). Default model per Vincent 4644+4645. runtime http-api per #98.
    "intern-s2": { runtime: "http-api", label: "上海 AI Lab 书生（intern-s2-preview，默认）[UNVERIFIED]", baseUrl: "https://chat.intern-ai.org.cn", envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://chat.intern-ai.org.cn/" },
    // TODO unverified — same caveat as DeepSeek (Vincent 4227).
    kimi:      { runtime: "claude-agent-sdk", label: "Kimi（长文本 128K）[UNVERIFIED]", baseUrl: "https://api.moonshot.cn/anthropic", envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://platform.moonshot.cn" },
    // TODO unverified — same caveat as DeepSeek (Vincent 4227).
    mimo:      { runtime: "claude-agent-sdk", label: "小米 MiMo（V2.5 系列）[UNVERIFIED]", baseUrl: "https://api.xiaomimimo.com/anthropic", envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://platform.xiaomimimo.com" },
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

  // [UNVERIFIED] entries marked below — same caveat as MODEL_PRESETS above.
  // Vincent telegram 4227 incident: only minimax + intern verified end-to-end.
  // Use `custom` for everything else until per-vendor verify lands.
  const PROVIDER_CHOICES = [
    // intern-s2-preview = default model (Vincent 4644+4645) — listed first so the
    // provider picker preselects it. [UNVERIFIED] — pending real-call verify,
    // intern key 待 Vincent 提供后验. runtime forced to http-api in the prompt
    // block below (claude-agent-sdk ↔ intern endpoint hangs, #98).
    { key: "intern-s2-preview", label: "上海 AI Lab 书生 — intern-s2-preview (默认) [UNVERIFIED]", baseUrl: "https://chat.intern-ai.org.cn", signupUrl: "https://chat.intern-ai.org.cn/" },
    // Verified by Vincent 2026-05-13 telegram 4227: bare hostname, no /anthropic.
    { key: "intern",     label: "上海 AI Lab 书生 — intern-s1-pro",            baseUrl: "https://chat.intern-ai.org.cn",          signupUrl: "https://chat.intern-ai.org.cn/" },
    { key: "minimax",    label: "MiniMax — 国内直连，低成本，速度快",        baseUrl: "https://api.minimaxi.com/anthropic",     signupUrl: "https://platform.minimaxi.com" },
    { key: "deepseek",   label: "DeepSeek — 代码 + 推理性价比高 [UNVERIFIED]", baseUrl: "https://api.deepseek.com/anthropic",     signupUrl: "https://platform.deepseek.com" },
    { key: "glm",        label: "GLM 智谱 — 中文理解强 [UNVERIFIED]",          baseUrl: "https://open.bigmodel.cn/anthropic",     signupUrl: "https://open.bigmodel.cn" },
    { key: "kimi",       label: "Kimi — 长文本 128K [UNVERIFIED]",             baseUrl: "https://api.moonshot.cn/anthropic",      signupUrl: "https://platform.moonshot.cn" },
    { key: "mimo",       label: "小米 MiMo — V2.5 [UNVERIFIED]",               baseUrl: "https://api.xiaomimimo.com/anthropic",   signupUrl: "https://platform.xiaomimimo.com" },
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
      // Intern presets: force http-api runtime (claude-agent-sdk ↔ intern
      // endpoint hangs, #98 root-cause) and pin the model id. intern-s2-preview
      // is [UNVERIFIED] — pending real-call verify once Vincent supplies a key.
      if (cfg.key === "intern-s2-preview") {
        opts.runtime = "http-api";
        opts.model = "intern-s2-preview";
      } else if (cfg.key === "intern") {
        opts.runtime = "http-api";
        opts.model = "intern-s1-pro";
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
    let commandArgs = agentArgs;
    try { execSync("which agent-node", { stdio: "pipe" }); } catch {
      cmd = "npx";
      commandArgs = ["-y", "@sleep2agi/agent-node@preview", ...agentArgs];
    }
    const child = spawn(cmd, commandArgs, { env, stdio: "inherit" });
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

    if (!profile.session) {
      profile.session = randomUUID();
      saveProfile(nodeId, profile);
    }

    let launchedWithResume = false;
    const supportsSessionId = claudeSupportsSessionId();
    if (!supportsSessionId) {
      console.warn(`[anet] ⚠ Your Claude Code CLI does not advertise --session-id. Upgrade @anthropic-ai/claude-code to avoid first-run resume drift.`);
      claudeArgs.push("--resume", profile.session);
      launchedWithResume = true;
    } else if (forceNewSession) {
      profile.session = randomUUID();
      saveProfile(nodeId, profile);
      claudeArgs.push("--session-id", profile.session);
    } else if (sessionFileExists(profile.session)) {
      claudeArgs.push("--resume", profile.session);
      launchedWithResume = true;
    } else {
      claudeArgs.push("--session-id", profile.session);
    }

    claudeArgs.push("-n", displayName);

    const child = spawn("claude", claudeArgs, { env, stdio: "inherit" });
    const pidFile = join(nodesDir(), nodeId, ".pid");
    if (child.pid) writeFileSync(pidFile, String(child.pid));
    child.on("exit", (code) => {
      try { rmSync(pidFile, { force: true }); } catch {}
      if (forceNewSession) {
        console.log(`\n[anet] New Claude Code session saved: ${profile.session?.slice(0, 8)}...`);
      } else if (!launchedWithResume) {
        console.log(`\n[anet] Claude Code session pinned: ${profile.session?.slice(0, 8)}...`);
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
    const devOpen = opts["dev-open"] === "true";
    let tokenSource: "flag" | "env" | "dev-open" | "none" = devOpen ? "dev-open" : "none";
    let token = "";
    if (serverAuthTokenFromConfig(sc)) {
      console.warn(`[anet] ⚠ ~/.anet/server/config.json auth_token is deprecated and ignored in v0.8. See RFC-001.`);
    }
    if (!devOpen) {
      if (opts.token) { token = opts.token; tokenSource = "flag"; }
      else if (process.env.COMMHUB_AUTH_TOKEN) { token = process.env.COMMHUB_AUTH_TOKEN; tokenSource = "env"; }
      if (token) console.warn(`[anet] ⚠ COMMHUB_AUTH_TOKEN / --token is deprecated and will be removed in v1.0. See RFC-001.`);
    }
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
        ...(devOpen ? { COMMHUB_DEV_OPEN: "1" } : token ? { COMMHUB_AUTH_TOKEN: token } : {}),
      };
      // Pin to a specific version to defeat bunx caching of older versions.
      // Bump this whenever commhub-server is updated. (bunx with @preview will
      // cache the first-resolved version and may not refetch even when the
      // tag points at something newer; specifying the exact version forces
      // a fresh install whenever this string changes.)
      // A `latest` agent-network release must pin a *stable* commhub-server —
      // 0.8.0 is the published latest and supersedes 0.8.0-preview.2.
      const PINNED_SERVER_VERSION = "0.8.0";
      const serverArgs = ["--bun", `@sleep2agi/commhub-server@${PINNED_SERVER_VERSION}`];
      if (devOpen) serverArgs.push("--dev-open");
      child = spawn("bunx", serverArgs, { env, stdio: "pipe" });

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
      if (devOpen) {
        console.log(`  ⚠️  DEV OPEN MODE`);
      } else {
        console.log(`  🔒 secured`);
      }
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

    // Save hub URL + launch config. Do NOT touch gc.token here — that's owned by login.
    gc.hub = hubUrl;
    saveServerConfig({ ...sc, port, host });
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
    // Skip the whole register flow if admin-utok.json already exists —
    // re-running `anet hub start` should be idempotent.
    const existingAdmin = loadAdminUtok();
    let defaultUser = opts.username || opts.user || "";
    let defaultPass = opts.password || opts.pass || "";
    let defaultAccountReady = false;
    let skippedBootstrap = false;
    if (existingAdmin.token) {
      skippedBootstrap = true;
      defaultAccountReady = true;
      defaultUser = existingAdmin.username || defaultUser;
      console.log(`  ✅ Admin already exists (admin-utok.json found, user=${existingAdmin.username || "?"})`);
    } else {
      // Quick-start defaults: admin / anethub. User is expected to rotate the
      // password via `anet passwd` after first login. Override with
      // --username / --password flags.
      if (!defaultUser) defaultUser = "admin";
      if (!defaultPass) defaultPass = "anethub";
    }
    if (!skippedBootstrap) {
      try {
        const reg = await fetch(`${hubUrl}/api/auth/register`, {
          method: "POST",
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
          body: JSON.stringify({ username: defaultUser, password: defaultPass }),
        }).then(r => r.json() as any);
        if (reg.ok) {
          defaultAccountReady = true;
          if (reg.token) {
            saveAdminUtok({
              username: reg.user?.username || defaultUser,
              user_id: reg.user?.user_id,
              token: reg.token,
              created_at: new Date().toISOString(),
            });
          }
          console.log(`  ✅ Admin account created`);
          console.log(`     username: ${defaultUser}`);
          console.log(`     password: ${defaultPass}`);
          console.log(`     Store this password now; it will not be shown again.`);
          if (reg.token) console.log(`     Admin token saved to ~/.anet/server/admin-utok.json`);
        } else if (reg.error?.includes("already taken")) {
          defaultAccountReady = true;
          console.log(`  ℹ  Admin account "${defaultUser}" already exists`);
        } else {
          console.log(`  ⚠  Could not bootstrap admin account: ${reg.error}`);
        }
      } catch (e: any) {
        console.log(`  ⚠  Admin account bootstrap skipped: ${e.message}`);
      }
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

    const loginHint = (defaultAccountReady && defaultPass)
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

  } else if (sub === "admin" && args[2] === "reset-user") {
    const opts = parseOpts();
    const username = opts.username || opts.user;
    if (!username) {
      console.error("Usage: anet hub admin reset-user --username <user>");
      return;
    }
    const dbPath = commhubDbPath();
    if (!existsSync(dbPath) && opts["i-am-on-the-hub-host"] !== "true") {
      console.error(`[anet] Refusing reset-user: local hub DB not found at ${dbPath}`);
      console.error(`[anet] Run this on the hub host, or pass --i-am-on-the-hub-host if COMMHUB_DB points to the DB.`);
      return;
    }
    const script = `
      import { Database } from "bun:sqlite";
      const db = new Database(process.env.COMMHUB_DB);
      const username = process.env.RESET_USERNAME;
      const user = db.query("SELECT user_id, username FROM users WHERE username = ?1").get(username);
      if (!user) { console.log(JSON.stringify({ ok: false, error: "user not found" })); process.exit(0); }
      const hashPassword = (p) => new Bun.CryptoHasher("sha256").update("anet:" + p).digest("hex");
      const hashToken = (t) => new Bun.CryptoHasher("sha256").update(t).digest("hex");
      const id = (prefix) => prefix + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const password = "anet-" + crypto.randomUUID().replace(/-/g, "").slice(0, 18);
      const token = "utok_" + crypto.randomUUID().replace(/-/g, "");
      const tokenId = id("tok");
      db.run("UPDATE users SET password_hash = ?1, updated_at = datetime('now') WHERE user_id = ?2", [hashPassword(password), user.user_id]);
      const revoked = db.run("DELETE FROM api_tokens WHERE user_id = ?1 AND network_id IS NULL", [user.user_id]).changes;
      db.run("INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, NULL, 'admin-reset', 'user')", [tokenId, hashToken(token), user.user_id]);
      db.run("INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail) VALUES (?1, ?2, 'password_reset_by_admin', 'user', ?3, 'local cli reset-user')", [user.user_id, user.username, user.user_id]);
      console.log(JSON.stringify({ ok: true, username: user.username, user_id: user.user_id, password, token, token_id: tokenId, revoked }));
    `;
    try {
      const out = execFileSync("bun", ["-e", script], {
        encoding: "utf-8",
        env: { ...process.env, COMMHUB_DB: dbPath, RESET_USERNAME: username },
      }).trim();
      const result = JSON.parse(out);
      if (!result.ok) {
        console.error(`[anet] reset-user failed: ${result.error}`);
        return;
      }
      console.log(`[anet] User password reset: ${result.username}`);
      console.log(`[anet] user_id: ${result.user_id}`);
      console.log(`[anet] new password: ${result.password}`);
      console.log(`[anet] new token: ${result.token}`);
      console.log(`[anet] revoked utok_: ${result.revoked}`);
      console.log(`[anet] Save this password now; it will not be shown again.`);
    } catch (e: any) {
      console.error(`[anet] reset-user failed: ${e.message}`);
    }

  } else if (sub === "config") {
    // anet server config — 显示/设置 server 配置
    const opts = parseOpts();
    const sc = loadServerConfig();
    if (opts.port) sc.port = opts.port;
    if (opts.host) sc.host = opts.host;
    if (opts.token) {
      console.warn(`[anet] ⚠ anet hub config --token is deprecated and ignored by v0.8 hub start. Use admin utok_ login instead.`);
      sc.auth_token = opts.token;
    }

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
    const adminUtok = loadAdminUtok();
    const fallbackMaster = process.env.COMMHUB_AUTH_TOKEN;
    const dashboardToken = adminUtok.token || fallbackMaster || "";
    if (dashboardToken) {
      if (adminUtok.token) console.log(`[anet] 🔒 Dashboard auth token loaded from admin-utok.json`);
      else console.warn(`[anet] ⚠ COMMHUB_AUTH_TOKEN fallback is deprecated and will be removed in v1.0. See RFC-001.`);
    } else {
      console.warn(`[anet] Could not auto-read admin utok. If hub is on another machine, login in the Dashboard UI or pass COMMHUB_AUTH_TOKEN=<hub's token> temporarily.`);
    }

    const env: Record<string, string> = {
      ...process.env as any,
      PORT: dashPort,
      HOSTNAME: dashHost,
      NEXT_PUBLIC_COMMHUB_URL: hubUrl,
      COMMHUB_URL: hubUrl,
      ...(dashboardToken ? { COMMHUB_AUTH_TOKEN: dashboardToken } : {}),
    };

    // Match dashboard release channel to anet channel (see #61 + dashboardReleaseTag).
    const tag = dashboardReleaseTag();
    cleanStaleNpxDashboardTemp(); // #89 — self-heal npx cache before spawn
    console.log(`[anet] spawning dashboard @${tag} (anet ${getAnetVersion() || "unknown"})`);
    const dashChild = spawn("npx", ["-y", `@sleep2agi/agent-network-dashboard@${tag}`], { env, stdio: "inherit" });
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
  --token <token>    Legacy master token (deprecated; prefer user/ntok auth)
  --dev-open         Disable hub auth for local development only

Options:
  --port <port>      Port (default: 9200 for server, 3000 for dashboard)
  --username <user>  Bootstrap admin username
  --password <pass>  Bootstrap admin password (default: anethub)

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
  anet channel add telegram 指挥室 --bot-token 123:ABC --allow <your-numeric-uid>
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
    if (!allowId) allowId = await ask("Allow User ID (发 @userinfobot 获取数字ID)", "");
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
      const child = spawn(forkScript, [], { stdio: "inherit", detached: true });
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
    execFileSync("npm", ["install", "-g", "@sleep2agi/agent-node@latest"], { stdio: "inherit" });
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

    const classifyStatus = (s: any) => {
      const raw = String(s?.status || "").toLowerCase();
      if (raw === "offline") return "offline";
      if (["working", "blocked", "error", "waiting_input", "running", "busy"].includes(raw)) return "working";
      return "idle";
    };
    const summary = statusRes.summary || sessions.reduce((acc: any, s: any) => {
      acc[classifyStatus(s)]++;
      acc.total++;
      return acc;
    }, { idle: 0, working: 0, offline: 0, total: 0 });
    const idle = sessions.filter((s: any) => classifyStatus(s) === "idle");
    const working = sessions.filter((s: any) => classifyStatus(s) === "working");
    const offline = sessions.filter((s: any) => classifyStatus(s) === "offline");

    console.log(`\n  CommHub: ${hub}`);
    console.log(`  Agents: ${summary.idle || 0} idle, ${summary.working || 0} working, ${summary.offline || 0} offline`);
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
  const username = opts.username || opts.user || await ask("Username");
  const password = opts.password || opts.pass || await ask("Password (min 6)");
  const email = opts.email || ((opts.username || opts.user) ? "" : await ask("Email (optional)"));
  closeRL();

  if (!username || !password) { console.error("Username and password required."); return; }

  // Auto-include server auth token for registration
  const serverToken = serverAuthTokenFromConfig(sc) || getToken();
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
  const username = opts.username || opts.user || await ask("Username");
  const password = opts.password || opts.pass || await ask("Password");
  closeRL();

  if (!username || !password) { console.error("Username and password required."); return; }

  let res: any;
  try {
    res = await fetch(`${hub}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }).then(r => r.json() as any);
  } catch (e: any) {
    // Network / DNS / connection error — show the friendly hint, not the
    // first-time-login guidance (auth-fail guidance below is for 401 only).
    console.error(`❌ Cannot reach hub: ${friendlyError(e)}`);
    return;
  }

  if (!res?.ok) {
    const serverErr = String(res?.error || "unknown");
    console.error(`❌ Login failed: ${serverErr}`);
    // Only show first-time-login guidance for auth-fail errors. Skip for
    // rate-limit / hub-internal / network-mid-flight server errors so
    // users don't get pointed at `anet register` when retry is what they
    // actually need (#58, Vincent 4339-4350 chain).
    const looksLikeAuthFail = /invalid|password|unauthor|credential|not found/i.test(serverErr);
    if (looksLikeAuthFail) {
      console.error("");
      console.error(`👉 首次用这个 hub? 试一下:`);
      console.error(`     anet register                              # 在 hub 上建新账号`);
      console.error("");
      console.error(`👉 自己刚起的本地 hub? 默认 admin:`);
      console.error(`     anet login --username admin --password anethub`);
      console.error("");
      console.error(`👉 自己 hub 忘了密码? 在 hub host 上跑:`);
      console.error(`     # 必须在 hub server 那台机器上跑 (--i-am-on-the-hub-host 是 safety flag, 防误删别人 DB):`);
      console.error(`     anet hub admin reset-user --username admin --i-am-on-the-hub-host true`);
    }
    return;
  }
  // res.ok === true from here — login succeeded.
  try {
    gc.token = res.token;
    gc.user = res.user;
    console.log(`✅ Logged in as ${res.user.username}`);

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
    if (gc.network_name) console.log(`   network: ${gc.network_name}`);
    console.log(`   token saved to ~/.anet/config.json`);
    console.log(`✅ Login successful — next: anet status / anet node create my-agent`);
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
  const oldPw = opts["old-password"] || opts.old || await ask("Current password");
  const scriptedNew = opts["new-password"] || opts["new"];
  const newPw = scriptedNew || await ask("New password (min 8)");
  if (!scriptedNew) {
    const confirmPw = await ask("Confirm new password");
    if (newPw !== confirmPw) {
      closeRL();
      console.error("[anet] Failed: passwords do not match");
      return;
    }
  }
  closeRL();

  if (!oldPw || !newPw) { console.error("Both passwords required."); return; }

  try {
    const res = await fetch(`${hub}/api/auth/password`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
    }).then(r => r.json() as any);

    if (res.ok) {
      if (res.token) {
        gc.token = res.token;
        saveGlobal(gc);
      }
      console.log("[anet] Password changed successfully.");
      if (res.token) console.log("[anet] Login token rotated and saved.");
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
    case "pr-review":
      args.splice(1, 1);
      return await demoPrReviewCommand();
    case "sci-team":
      args.splice(1, 1);
      return await demoSciTeamCommand();
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

  [32m●[0m pr-review       代码 PR 审查室 — 4 agent (安全/性能/风格 3 reviewer 并行 + judge), ~2 min
                  anet demo pr-review --diff path/to/change.diff
                  anet demo pr-review --pr https://github.com/owner/repo/pull/N
                  anet demo pr-review --ref origin/main

  [32m●[0m sci-team    科研军团 — 1 leader + N-1 worker (默认 10, 5-50 可调) 跑书生模型, Phase 1 scaffold
                  anet demo sci-team
                  anet demo sci-team --count 20 --dir ~/intern-s --intern-api $KEY
                  anet demo sci-team --stop / --restart / --cleanup

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
    killTmuxSession(sessName);
    try {
      startNodeTmuxSession(sessName, alias);
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
      killTmuxSession(sessName);
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
    killTmuxSession(sessName);
    try {
      startNodeTmuxSession(sessName, alias);
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
      killTmuxSession(sessName);
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

// ── demo: pr-review ──
// 4-agent PR review room: 3 reviewers (security / performance / style) fan-out
// in parallel from the CLI, then a judge consolidates their replies at a
// barrier. Output is a markdown PR review with a LGTM / Request Changes /
// Comment verdict. Spec: docs/demos/pr-review-room-proposal.md (refs #25).

const PR_REVIEW_ROLES = ["reviewer-security", "reviewer-performance", "reviewer-style", "judge"] as const;

const PR_REVIEW_PROMPTS: Record<string, () => string> = {
  "reviewer-security": () => `你是**安全审查员**，专注代码 diff 里的安全风险。

收到任务（附 PR diff）时:
- 检查这些维度: 注入 / 凭据泄露 / 权限绕过 / SSRF / 反序列化 / 命令注入 / 不安全反射 / 越权访问
- 每条 issue 输出格式: "- [严重度: 严重/中/低] file:line — 问题描述（一句话） — 建议改法"
- 没问题就写 "无安全问题。"
- 末尾另起一段写 "## 安全 issue 数: <N>"

要求:
- 只看 diff，不脑补 diff 外内容
- 不写客套话，不重复 reviewer 自我介绍
- 输出 markdown，250-500 字`,

  "reviewer-performance": () => `你是**性能审查员**，专注代码 diff 里的性能与资源使用问题。

收到任务（附 PR diff）时:
- 检查这些维度: N+1 查询 / O(n²) / 不必要 IO / 阻塞 await / 大对象 / 内存泄漏 / 锁粒度 / 缓存缺失
- 每条 issue 输出格式: "- [严重度: 严重/中/低] file:line — 问题描述（一句话） — 建议改法"
- 没问题就写 "无性能问题。"
- 末尾另起一段写 "## 性能 issue 数: <N>"

要求:
- 只看 diff，不脑补 diff 外内容
- 不写客套话，不重复 reviewer 自我介绍
- 输出 markdown，250-500 字`,

  "reviewer-style": () => `你是**代码风格审查员**，专注可读性与可维护性。

收到任务（附 PR diff）时:
- 检查这些维度: 命名 / 注释 / 抽象层级 / 死代码 / 复杂度 / 重复 / 类型签名
- 每条 issue 输出格式: "- [严重度: 严重/中/低] file:line — 问题描述（一句话） — 建议改法"
- 没问题就写 "无风格问题。"
- 末尾另起一段写 "## 风格 issue 数: <N>"

要求:
- 只看 diff，不脑补 diff 外内容
- 不写客套话，不重复 reviewer 自我介绍
- 输出 markdown，250-500 字`,

  "judge": () => `你是**终审 judge**，负责整合 3 份维度审查（安全/性能/风格）输出最终 PR review。

收到任务（附 PR diff 摘要 + 3 份 reviewer markdown）时:
- 先按 (file:line) 二元组去重重叠 issue
- 按严重度排序: 严重 > 中 > 低
- 输出一份最终 markdown:
  - 顶部一行 "**决议：** LGTM" 或 "**决议：** Request Changes" 或 "**决议：** Comment"
    - 任一 reviewer 报"严重"→ Request Changes
    - 全部 reviewer 0 issue → LGTM
    - 其它情况 → Comment
  - 第二行 "**统计：** 安全 N 处 / 性能 N 处 / 风格 N 处"
  - 然后三段 "## 安全" / "## 性能" / "## 风格"，每段列去重后的 issue
  - 最后一段 "## 终审说明" 用 100-200 字解释你判 LGTM / Request Changes / Comment 的核心理由

要求:
- 必须含 "**决议：**" 字段（CLI 用 regex 解析）
- 不重复 reviewer 原文，去重后呈现
- 输出 markdown，500-1200 字`,
};

// fetchPrDiff: 3 入口拿 PR diff
// - --diff <file>: local file readFileSync
// - --ref <ref>:   git diff <ref>..HEAD
// - --pr <url>:    gh CLI fallback (需要 user 装了 gh)
async function fetchPrDiff(opts: Record<string, string>): Promise<{ diff: string; source: string }> {
  if (opts.diff) {
    const p = opts.diff;
    if (!existsSync(p)) throw new Error(`--diff 文件不存在: ${p}`);
    return { diff: readFileSync(p, "utf-8"), source: `local file ${p}` };
  }
  if (opts.ref) {
    const ref = opts.ref;
    try {
      const out = execSync(`git diff ${ref}..HEAD`, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      if (!out.trim()) throw new Error(`git diff ${ref}..HEAD 输出为空 (无 diff 或 ref 不存在)`);
      return { diff: out, source: `git diff ${ref}..HEAD` };
    } catch (e: any) {
      throw new Error(`git diff 失败: ${e.message}`);
    }
  }
  if (opts.pr) {
    // tier 2: gh CLI fallback
    try {
      execSync("command -v gh", { stdio: "ignore" });
    } catch {
      throw new Error(`--pr 需要本地装 gh CLI (https://cli.github.com)，或改用 --diff <file> / --ref <ref>`);
    }
    const url = opts.pr;
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) throw new Error(`--pr 不是合法 GitHub PR URL: ${url}`);
    const [, owner, repo, num] = m;
    try {
      const out = execSync(`gh api repos/${owner}/${repo}/pulls/${num} -H "Accept: application/vnd.github.v3.diff"`, {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return { diff: out, source: `${owner}/${repo}#${num} (gh api)` };
    } catch (e: any) {
      throw new Error(`gh api 拉 PR diff 失败: ${e.message}`);
    }
  }
  throw new Error(`需要 --diff <file> / --ref <ref> / --pr <github-url> 之一`);
}

async function demoPrReviewCommand() {
  const opts = parseOpts();
  const help = args.includes("--help") || args.includes("-h");
  if (help) {
    console.log(`
  anet demo pr-review — 代码 PR 审查室 demo (4 agent: 3 reviewer 并行 + judge)

  Usage:
    anet demo pr-review [--diff <file> | --ref <ref> | --pr <github-url>] \\
                        [--key <minimax-key>] [--out <path>] [--keep] \\
                        [--step-timeout <s>] [--suffix <s>] \\
                        [--no-network | --network <id>]

  Diff 入口 (三选一):
    --diff <file>     本地 .diff / .patch 文件
    --ref <ref>       'git diff <ref>..HEAD' 自动拿当前 branch 的 patch (e.g. --ref origin/main)
    --pr <url>        GitHub PR URL，用 gh CLI 拉 .diff (需本地装 gh)

  其它:
    --key <key>       MiniMax API key (默认 \$MINIMAX_KEY 或 \$ANTHROPIC_AUTH_TOKEN)
    --out <path>      评审输出 (默认 ./pr-review-<id>-<ts>.md)
    --keep            跑完不删 4 agent + network (默认会清掉)
    --step-timeout    单 reviewer/judge 超时秒数 (默认 180)
    --suffix          自定义 alias 后缀 (默认随机 4 hex)
    --no-network      跑在当前/default network 内
    --network <id>    指定已存在的 network

  Examples:
    anet demo pr-review --diff ./my-pr.diff
    anet demo pr-review --ref origin/main
    anet demo pr-review --pr https://github.com/sleep2agi/agent-network/pull/40
    anet demo pr-review --diff ./my-pr.diff --keep --suffix demo01

  需要:
    - 已 anet login 到 hub
    - MiniMax key (Token Plan 至少有 MiniMax-M* 配额)
    - --pr 需要本地装 gh CLI (https://cli.github.com)

  完整 spec: docs/demos/pr-review-room-proposal.md
`);
    return;
  }

  const gc = loadGlobal();
  const hub = gc.hub;
  if (!hub) { console.error("  ❌ 没有 hub. 先 'anet init' 或 'anet hub start'."); return; }
  if (!gc.token) { console.error("  ❌ 没有 token. 先 'anet login'."); return; }

  // 1. Resolve diff source
  let diff = "";
  let diffSource = "";
  try {
    const r = await fetchPrDiff(opts);
    diff = r.diff;
    diffSource = r.source;
  } catch (e: any) {
    console.error(`  ❌ ${e.message}`);
    return;
  }
  const diffBytes = Buffer.byteLength(diff, "utf-8");
  const diffKb = (diffBytes / 1024).toFixed(1);
  if (diffBytes > 30 * 1024) {
    console.log(`  ⚠️  diff 大小 ${diffKb} KB > 30 KB，可能超 model context。建议用 'gh api -X GET repos/.../files' 先筛关键文件。继续...`);
  }

  const minimaxKey = opts.key || process.env.MINIMAX_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
  if (!minimaxKey) {
    console.error("  ❌ 需要 MiniMax key. 用 --key 或 export MINIMAX_KEY=sk-cp-...");
    return;
  }

  const stepTimeout = parseInt(opts["step-timeout"] || "180", 10) * 1000;
  const keep = args.includes("--keep");
  const suffix = opts.suffix || Math.random().toString(16).slice(2, 6);
  const outPath = opts.out || `./pr-review-${suffix}-${Date.now()}.md`;

  // Network selection: same convention as demo debate (default = create
  // dedicated `pr-review-<suffix>` network; --no-network = use default;
  // --network <id> = use given existing network).
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
    const netName = `pr-review-${suffix}`;
    console.log(`  ⏳ 正在创建独立 network: ${netName}...`);
    try {
      const r = await fetch(`${hub}/api/networks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gc.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: netName, description: `Auto-created for anet demo pr-review: ${diffSource}` }),
      }).then(r => r.json() as any);
      if (!r?.ok || !r.network_id) {
        console.error(`  ❌ 创建 network 失败: ${r?.error || "unknown"}. 用 --no-network 退到 default 或 --network <id> 指定.`);
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
  for (const r of PR_REVIEW_ROLES) roleAliases[r] = `${r}-${suffix}`;

  console.log(`\n  🔍 PR diff: ${diffSource}`);
  console.log(`  📏 Size:   ${diffKb} KB`);
  console.log(`  📡 Hub:    ${hub}`);
  console.log(`  📂 Net:    ${networkLabel}`);
  console.log(`  🆔 Run:    ${suffix}\n`);

  // 2. Create 4 agents
  const origNetworkId = gc.network_id || "";
  const origNetworkName = gc.network_name || "";
  if (createdNetworkId) {
    saveGlobal({ ...gc, network_id: createdNetworkId, network_name: `pr-review-${suffix}` });
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

  process.env.ANET_INTERNAL_KEEP_PROCESS = "1";
  try {
    console.log(`  [1/6] 创建 4 个 agent (alias 后缀 -${suffix})...`);
    const nodesRoot = nodesDir();
    for (const role of PR_REVIEW_ROLES) {
      const alias = roleAliases[role];
      if (!existsSync(join(nodesRoot, alias, "config.json"))) {
        const createArgs = ["create", alias,
          "--runtime", "claude-agent-sdk",
          "--model", "MiniMax-M2.7",
          "--env", `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`,
          "--env", `ANTHROPIC_AUTH_TOKEN=${minimaxKey}`,
          "--env", `ANTHROPIC_MODEL=MiniMax-M2.7`,
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
      cfg.systemPrompt = PR_REVIEW_PROMPTS[role]();
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    }
    console.log(`        ✓ 创建/更新 4 个 agent`);
  } finally {
    restoreNetwork();
    delete process.env.ANET_INTERNAL_KEEP_PROCESS;
  }

  // 3. Start each in tmux + wait SSE
  console.log(`  [2/6] 启动 4 个 agent (tmux session)...`);
  for (const role of PR_REVIEW_ROLES) {
    const alias = roleAliases[role];
    const sessName = `pr-review-${suffix}-${alias}`;
    killTmuxSession(sessName);
    try {
      startNodeTmuxSession(sessName, alias);
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
      const allUp = PR_REVIEW_ROLES.every(r => sse[roleAliases[r]] >= 1);
      if (allUp) { console.log(`        ✓ 4 agent 全部 SSE connected`); break; }
    } catch {}
  }

  // 4. Helpers: post task + wait reply
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

  type ReviewSection = { role: string; alias: string; text: string; durationMs: number };
  const reviewerOutputs: ReviewSection[] = [];
  let judgeOutput = "";
  const reviewerRoles = ["reviewer-security", "reviewer-performance", "reviewer-style"];
  const t0Run = Date.now();

  try {
    // 5. Parallel fan-out to 3 reviewers
    console.log(`  [3/6] 广播 review task 给 3 reviewer (parallel)...`);
    const reviewerTask = `请审查以下 diff（按你专精的维度）：\n\n\`\`\`diff\n${diff}\n\`\`\``;
    const t0Fanout = Date.now();
    const fanouts = reviewerRoles.map(async role => {
      const alias = roleAliases[role];
      const t0 = Date.now();
      const msgId = await postTask(alias, reviewerTask);
      const reply = await waitReply(msgId, alias, stepTimeout);
      const dt = Date.now() - t0;
      console.log(`        ✓ ${alias.padEnd(28)} ${Math.round(dt / 1000).toString().padStart(3)}s, ${reply.length} 字`);
      return { role, alias, text: reply, durationMs: dt };
    });
    const results = await Promise.all(fanouts);
    reviewerOutputs.push(...results);
    const fanoutDt = Date.now() - t0Fanout;
    const serialEstimate = results.reduce((s, r) => s + r.durationMs, 0);
    console.log(`        ─ 并行总耗时 ${Math.round(fanoutDt / 1000)}s (估串行 ${Math.round(serialEstimate / 1000)}s, 节省 ~${Math.max(0, Math.round((serialEstimate - fanoutDt) / 1000))}s)`);

    // 6. Barrier → judge
    console.log(`  [4/6] barrier 收齐 3 份 review，整包派给 judge...`);
    const judgePackage = [
      `## diff 摘要`,
      `- 来源: ${diffSource}`,
      `- 大小: ${diffKb} KB`,
      ``,
      `## reviewer-security 输出`,
      reviewerOutputs.find(o => o.role === "reviewer-security")?.text || "(无)",
      ``,
      `## reviewer-performance 输出`,
      reviewerOutputs.find(o => o.role === "reviewer-performance")?.text || "(无)",
      ``,
      `## reviewer-style 输出`,
      reviewerOutputs.find(o => o.role === "reviewer-style")?.text || "(无)",
    ].join("\n");

    console.log(`  [5/6] judge 整合 + 终审...`);
    const judgeAlias = roleAliases["judge"];
    const t0Judge = Date.now();
    const judgeMsgId = await postTask(judgeAlias, `请整合三份 review 输出最终 PR review：\n\n${judgePackage}`);
    judgeOutput = await waitReply(judgeMsgId, judgeAlias, stepTimeout);
    console.log(`        ✓ ${judgeAlias} ${Math.round((Date.now() - t0Judge) / 1000)}s, ${judgeOutput.length} 字`);
  } catch (e: any) {
    console.error(`\n  ❌ 流程失败: ${e.message}`);
    if (!keep) console.log(`     (--keep 未指定,稍后会清理 agent)`);
  }

  // 7. Write output markdown
  console.log(`  [6/6] 写入 review: ${outPath}`);
  const finalMd = [
    `# PR Review`,
    ``,
    `**来源**: ${diffSource}`,
    `**大小**: ${diffKb} KB`,
    `**时间**: ${new Date().toLocaleString()}`,
    `**Run**: ${suffix}`,
    `**总耗时**: ${Math.round((Date.now() - t0Run) / 1000)}s`,
    ``,
    judgeOutput || "(judge 没输出，看上面错误)",
    ``,
    `---`,
    `## 附：3 reviewer 原始输出`,
    ``,
    ...reviewerOutputs.flatMap(o => [`### ${o.role} (${o.alias}, ${Math.round(o.durationMs / 1000)}s)`, ``, o.text, ``]),
  ].join("\n");
  writeFileSync(outPath, finalMd);
  console.log(`        ✓ ${finalMd.length} 字写入 ${outPath}`);

  // 8. Cleanup unless --keep
  if (!keep) {
    console.log(`\n  🧹 清理 4 个 agent (用 --keep 跳过)...`);
    for (const role of PR_REVIEW_ROLES) {
      const alias = roleAliases[role];
      const sessName = `pr-review-${suffix}-${alias}`;
      killTmuxSession(sessName);
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
    console.log(`\n  📌 已保留 4 个 agent (alias 后缀 -${suffix})。手动清理:`);
    console.log(`     tmux kill-session -t pr-review-${suffix}-*`);
    console.log(`     anet node delete ${PR_REVIEW_ROLES.map(r => `${r}-${suffix}`).join(" ")}`);
    if (createdNetworkId) {
      console.log(`     anet network delete ${createdNetworkId}`);
    }
  }

  // Hint user how to use the output
  console.log(`\n  🏁 完成！review: ${outPath}`);
  console.log(`\n     下一步建议:`);
  console.log(`       1. 查看: less ${outPath}`);
  if (opts.pr) {
    const m = opts.pr.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (m) console.log(`       2. 贴到 GitHub PR: gh pr comment ${m[3]} --repo ${m[1]}/${m[2]} -F ${outPath}`);
  } else {
    console.log(`       2. 贴到 GitHub PR: gh pr comment <PR-N> --repo <owner>/<repo> -F ${outPath}`);
  }
  console.log();
}

// ── demo: sci-team ──
// Phase 1 scaffold per issue #51: batch-create N claude-agent-sdk agents
// (1 leader + N-1 workers) under a team directory, each in its own subdir
// with its own .anet/nodes/<alias>/config.json. Phase 1 wires up wizard +
// creation + launch + stop/restart/cleanup lifecycle. Leader fan-out and
// aggregation logic is deferred to Phase 2 (waiting on RFC-008) — the
// systemPrompts here are intentionally placeholders.
//
// Verified vendor values (per Vincent telegram 4227, commit 1bc03c0):
//   runtime: http-api   (claude-agent-sdk ↔ intern endpoint hangs — #98 root-cause)
//   model:   intern-s1-pro
//   baseUrl: https://chat.intern-ai.org.cn   (bare hostname, no /anthropic)
//   token:   ANTHROPIC_AUTH_TOKEN injected from user-supplied Intern API key
//
// Note: each node lives under <dir>/node<i>, so we briefly process.chdir()
// before save so nodesDir()/saveProfile() drops files in the right place.
// The original cwd is always restored in a finally clause.

const SCI_TEAM_DIRECTIONS = [
  { value: "comprehensive", label: "全面 AI" },
  { value: "infra",         label: "AI Infra (训练 / 推理 / 部署)" },
  { value: "llm-arch",      label: "LLM 架构" },
  { value: "unified-gen",   label: "统一生成 (multi-modal)" },
  { value: "rlhf",          label: "RLHF / Alignment" },
  { value: "ai-safety",     label: "AI Safety" },
  { value: "custom",        label: "自定义 (wizard 再问主题)" },
];

function sciTeamPrompt(role: "leader" | "worker", index: number, teamSize: number, direction: string): string {
  if (role === "leader") {
    const workers = teamSize - 1;
    const workerList = Array.from({ length: workers }, (_, i) => `研究员${i + 1}号`).join(" / ");
    return [
      `你是科研军团的 leader (alias=研究Leader)，带 ${workers} 个研究员 (${workerList}) 协作完成 AI 综述。`,
      `主攻方向：${direction}。`,
      ``,
      `你的工具:`,
      `  - commhub_send_task(alias, task)        派 sub-task 给指定研究员`,
      `  - commhub_get_inbox(alias?, limit?)     查研究员的 reply`,
      `  - commhub_get_all_status()              看团队在线状态`,
      `  - commhub_send_reply(target, message)   回复用户`,
      ``,
      `接到用户任务后的工作流（自主决策，不是 echo 占位）:`,
      `  1. 分析任务 — 识别 AI sub-direction (e.g. Infra / LLM 架构 / 统一生成 / RLHF / AI Safety / Reasoning 等)，按方向切分子主题`,
      `  2. Fan-out — 用 commhub_send_task 把每个 sub-area 派给一个研究员 (可以 1 人 1 area，也可以 2-3 人协作 1 area)。每条 task 写清楚研究员该 cover 什么、输出格式要求`,
      `  3. 收集 reply — 通过 commhub_get_inbox 等研究员 reply (sub-area findings)；等齐才进下一步`,
      `  4. 整合 — dedup + 按 sub-area 排序，出最终 markdown 综述，再 commhub_send_reply 给用户`,
      ``,
      `你是真在做研究 + 协作，**不是** echo 占位。Sub-direction 切分 + fan-out + aggregate 全部自主决策。`,
    ].join("\n");
  }
  return [
    `你是科研军团研究员 ${index} 号 (alias=研究员${index}号)，向 leader (研究Leader) 汇报。`,
    `团队主攻方向：${direction}。`,
    ``,
    `收到 leader 派的 sub-task 后，独立完成调研：`,
    `  1. 调研指定 AI sub-area (优先用 WebSearch 拿最新 trends / papers，结合你自己的 AI knowledge)`,
    `  2. 出 ~300-500 字 sub-area summary，markdown 格式，含: key insights / 代表性 papers 或 systems / open problems / 跟其它 sub-area 的边界`,
    `  3. 用 commhub_send_task 把 summary 当 task content reply 给 leader (alias=研究Leader)`,
    ``,
    `要真做调研 + 出有信息密度的 summary，**不是** echo 占位。`,
  ].join("\n");
}

async function demoSciTeamCommand() {
  const opts = parseOpts();
  const help = args.includes("--help") || args.includes("-h");
  if (help) {
    console.log(`
  anet demo sci-team — Phase 1 scaffold: batch-create N 研究 agent (1 leader + N-1 worker)

  Usage:
    anet demo sci-team [--count N] [--dir <path>] [--intern-api <key>] [--direction <key>]
    anet demo sci-team --stop      # kill 所有 sci-team tmux session
    anet demo sci-team --restart   # --stop 然后 hint 重跑创建
    anet demo sci-team --cleanup   # --stop + 删 node 子目录 + rm -rf 工作目录

  Wizard fields (任一可用 --flag 跳过 prompt):
    --intern-api <key>   书生 API key (Anthropic-compatible Intern)
    --count <N>          军团人数 (5-50, 默认 10)
    --dir <path>         工作目录 (默认 ~/intern-s)
    --direction <key>    综述方向 (comprehensive/infra/llm-arch/unified-gen/rlhf/ai-safety/custom)

  Vendor values (Vincent verified per commit 1bc03c0):
    runtime  = http-api   (claude-agent-sdk ↔ intern endpoint hangs — #98)
    model    = intern-s1-pro
    baseUrl  = https://chat.intern-ai.org.cn   (no /anthropic suffix)
    token    = \$ANTHROPIC_AUTH_TOKEN (= 你的 Intern API key)

  Phase 1 scope (scaffold only):
    - Wizard + 批量 mkdir <dir>/node1..nodeN (每个 node 独立 cwd)
    - 每个 node 写 config.json + Intern preset + placeholder systemPrompt
    - Auto register/login (default admin/anethub if no token) + ntok_ per alias
    - Launch all nodes via tmux

  Phase 2+ defer:
    - Leader 智能 fan-out / sub-area assignment / aggregate 综述 (待 RFC-008)
    - Dashboard team 聚合视图 (issue #50)
    - 真实学术 systemPrompts

  Spec: issue #51
`);
    return;
  }

  // ── Lifecycle flags first (so --stop/--cleanup don't trigger wizard) ──
  const isStop    = args.includes("--stop");
  const isRestart = args.includes("--restart");
  const isCleanup = args.includes("--cleanup");
  const lifecycleDir = opts.dir || join(home, "intern-s");
  if (isStop || isRestart || isCleanup) {
    const flag = isStop ? "--stop" : isRestart ? "--restart" : "--cleanup";
    const verb = isStop ? "stop" : isRestart ? "restart" : "cleanup";
    console.warn(`[deprecated] 'anet demo sci-team ${flag}' is deprecated; use 'anet batch ${verb} sci-team' (will remove in next major).`);
    return sciTeamLifecycle({ dir: lifecycleDir, restart: isRestart, cleanup: isCleanup });
  }

  // ── Wizard prompts ──
  const gc = loadGlobal();
  if (!gc.hub) {
    console.error("[anet] 未找到 CommHub Server。先运行 'anet hub start' 或 'anet init --hub <url>'");
    return;
  }

  const internApiKey = opts["intern-api"] || opts["api-key"] || process.env.INTERN_API_KEY || await ask("书生 (Intern) API key");
  if (!internApiKey) {
    closeRL();
    console.error("[anet] 需要 Intern API key. 申请页: https://chat.intern-ai.org.cn/");
    return;
  }

  const countStr = opts.count || await ask("军团人数 (5-50)", "10");
  const countRaw = parseInt(countStr, 10);
  const count = Math.max(5, Math.min(50, Number.isFinite(countRaw) ? countRaw : 10));
  if (count !== countRaw) {
    console.log(`  [anet] 人数 ${countRaw} → 钳到合法区间 [5,50] = ${count}`);
  }

  const targetDir = opts.dir || await ask("工作目录", join(home, "intern-s"));

  let direction = opts.direction || "";
  if (!direction) {
    direction = await askChoice("综述方向", SCI_TEAM_DIRECTIONS.map(d => ({ label: d.label, value: d.value })));
  }
  if (direction === "custom") {
    direction = await ask("自定义方向 (一句话描述)", "通用研究");
  }
  closeRL();

  // ── Auto register/login (default admin/anethub) ──
  if (!gc.token || !gc.user) {
    console.log(`\n[anet] 没有 user token，自动用 default admin/anethub 登录...`);
    const loginRes = await fetch(`${gc.hub}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "anethub" }),
    }).then(r => r.json() as any).catch(() => null);
    if (!loginRes?.ok) {
      console.error(`[anet] 自动登录失败: ${loginRes?.error || "unknown"}. 先 'anet register' 创账号。`);
      return;
    }
    gc.token = loginRes.token;
    gc.user = loginRes.user;
    const nets = await fetch(`${gc.hub}/api/networks`, { headers: { Authorization: `Bearer ${loginRes.token}` } }).then(r => r.json() as any).catch(() => ({ networks: [] }));
    if (nets.networks?.length > 0) {
      gc.network_id = nets.networks[0].network_id;
      gc.network_name = nets.networks[0].network_name;
    }
    saveGlobal(gc);
    console.log(`        ✓ 登录: ${loginRes.user.username}`);
  }

  // ── Plan + create ──
  console.log(`\n[anet] 创建科研军团:`);
  console.log(`        工作目录:  ${targetDir}`);
  console.log(`        节点数:    ${count} (1 leader + ${count - 1} worker)`);
  console.log(`        综述方向:  ${direction}`);
  console.log(`        Runtime:   http-api + intern-s1-pro\n`);

  // sci-team is now a preset wrapper over the generic batch primitive
  // (issue #55). The Intern URL + model + active-fan-out sciTeamPrompt
  // template all stay locked here; createBatch handles the per-node
  // mkdir + ensureNodeToken + saveProfile + tmux launch loop.
  const result = await createBatch({
    prefix: "研究员",
    count,
    workdir: targetDir,
    workdirMode: "separate",
    runtime: "http-api",
    model: "intern-s1-pro",
    baseUrl: "https://chat.intern-ai.org.cn",
    apiKey: internApiKey,
    systemPrompt: (role, index, total) => sciTeamPrompt(role, index, total, direction),
    team: "sci-team",
    leaderAlias: "研究Leader",
  });

  if (result.createdAliases.length === 0) {
    console.error("\n[anet] 没有任何 node 创建成功，退出。");
    return;
  }

  console.log(`\n[anet] 🏁 科研军团 ready.`);
  console.log(`        Dashboard:    anet hub dashboard  (or open ${gc.hub.replace(":9200", ":3000")})`);
  console.log(`        派任务:       commhub_send_task --alias 研究Leader --task "<研究 prompt>"`);
  console.log(`        Phase 1 note: leader 只是 placeholder echo, RFC-008 Phase 2 接入智能 fan-out`);
  console.log(`        Stop:         anet batch stop sci-team`);
  console.log(`        Cleanup:      anet batch cleanup sci-team --workdir ${targetDir}`);
  console.log();
}

// Wrapper preserved for the `anet demo sci-team --stop|--restart|--cleanup`
// flag path (deprecated, see warning in demoSciTeamCommand). New users should
// use `anet batch <verb> sci-team` (the canonical lifecycle command). The
// implementation now delegates to batchLifecycle() so behavior stays in sync.
function sciTeamLifecycle(opts: { dir: string; restart: boolean; cleanup: boolean }) {
  const { dir, restart, cleanup } = opts;
  if (restart) {
    return batchLifecycle({ prefix: "sci-team", verb: "restart", workdir: dir });
  }
  if (cleanup) {
    return batchLifecycle({ prefix: "sci-team", verb: "cleanup", workdir: dir });
  }
  return batchLifecycle({ prefix: "sci-team", verb: "stop", workdir: dir });
}

// ── Batch primitive (issue #55) ──
//
// `createBatch` is the generic N-node spawn primitive that both
// `anet create --batch` (user-facing wizard) and `anet demo sci-team`
// (preset wrapper) call into. It abstracts the pattern PR #53 first wired
// up for sci-team: per-node mkdir + Profile build + ensureNodeToken +
// saveProfile + tmux session launch, with the original cwd restored in a
// finally block.
//
// Vendor presets must stay in sync with the Vincent-verified list at
// cli.ts L1116+ (1bc03c0 chain): adding a new preset here requires
// per-vendor verify-with-real-call, not byte-copy (see
// [[feedback_vendor_verify_before_hardcode]]).

interface BatchOptions {
  prefix: string;                // alias 前缀, e.g. "工程师" → 工程师1号..工程师N号
  count: number;                 // node 数 (caller pre-clamps to spec range)
  workdir: string;               // 父目录 (absolute path), e.g. /home/u/anet-team
  workdirMode: "separate" | "shared";  // separate: workdir/node{i}/.anet/nodes/<alias>  | shared: workdir/.anet/nodes/<alias>
  runtime: string;               // claude-agent-sdk / codex-sdk / claude-code-cli / http-api
  model?: string;                // e.g. intern-s1-pro / MiniMax-M2.7 / claude-sonnet-4-6
  baseUrl?: string;              // ANTHROPIC_BASE_URL value (omit for Anthropic native)
  apiKey?: string;               // ANTHROPIC_AUTH_TOKEN value (or runtime-specific token)
  authTokenEnvName?: string;     // env var name for the auth token (default ANTHROPIC_AUTH_TOKEN)
  systemPrompt?: string | ((role: "leader" | "worker", index: number, total: number) => string);
  team?: string;                 // profile.team field + tmux session prefix (defaults to prefix)
  leaderAlias?: string;          // 设了 → i=1 = leader role with this alias; i>1 = `${prefix}${i-1}号` worker. 没设 → all i = `${prefix}${i}号` workers.
  printSummary?: boolean;        // default true
}

interface BatchResult {
  workdir: string;
  createdAliases: string[];
  failedAliases: string[];
  tmuxPrefix: string;            // for downstream lifecycle ops
}

function batchAliasFor(opts: BatchOptions, i: number): { alias: string; role: "leader" | "worker"; workerIndex: number } {
  if (opts.leaderAlias && i === 1) {
    return { alias: opts.leaderAlias, role: "leader", workerIndex: 0 };
  }
  const workerIndex = opts.leaderAlias ? i - 1 : i;
  return { alias: `${opts.prefix}${workerIndex}号`, role: "worker", workerIndex };
}

function batchNodeDirFor(opts: BatchOptions, i: number): string {
  return opts.workdirMode === "separate" ? join(opts.workdir, `node${i}`) : opts.workdir;
}

async function createBatch(opts: BatchOptions): Promise<BatchResult> {
  // Validate every user-controllable string that lands in a filesystem path
  // or a tmux session name. Single-node createCommand calls validateNodeName
  // for the same reason (cli.ts:1233, also :1079); without it here a
  // `--prefix '../bad'` would escape `.anet/nodes/` via saveProfile()'s
  // `join(nodesDir(), id, "config.json")` write — caught by 通信牛 review of PR #60.
  if (!opts.prefix || opts.prefix.length === 0) {
    console.error("Error: batch prefix is required (got empty).");
    process.exit(1);
  }
  validateNodeName(opts.prefix);
  if (opts.team) validateNodeName(opts.team);
  if (opts.leaderAlias) {
    if (opts.leaderAlias.length === 0) {
      console.error("Error: --leader-alias is empty; pass a name or drop the flag.");
      process.exit(1);
    }
    validateNodeName(opts.leaderAlias);
  }

  const tmuxPrefix = opts.team || opts.prefix;
  const gc = loadGlobal();
  mkdirSync(opts.workdir, { recursive: true });
  const origCwd = process.cwd();
  const created: string[] = [];
  const failed: string[] = [];

  try {
    for (let i = 1; i <= opts.count; i++) {
      const { alias, role, workerIndex } = batchAliasFor(opts, i);
      // Defense-in-depth: the prefix/leaderAlias entry-level validation above
      // should already guarantee a safe alias here, but re-check so a bug in
      // batchAliasFor() can never silently escape `.anet/nodes/`.
      validateNodeName(alias);
      const nodeDir = batchNodeDirFor(opts, i);
      mkdirSync(nodeDir, { recursive: true });
      process.chdir(nodeDir);

      const envMap: Record<string, string> = {};
      if (opts.baseUrl) envMap.ANTHROPIC_BASE_URL = opts.baseUrl;
      if (opts.apiKey) envMap[opts.authTokenEnvName || "ANTHROPIC_AUTH_TOKEN"] = opts.apiKey;

      // #93 — per-node identity. The function form (sci-team) already bakes the
      // alias into its template; a plain string --description is shared by every
      // node and carries no identity, so prepend `你是 <alias>。` — without it
      // agent-node's own `你是 ${ALIAS}` fallback is suppressed (it only fires
      // when systemPrompt is absent) and every node thinks it is <prefix>1号.
      // No description → leave undefined so that agent-node fallback still fires.
      let promptText: string | undefined;
      if (typeof opts.systemPrompt === "function") {
        promptText = opts.systemPrompt(role, workerIndex, opts.count);
      } else if (opts.systemPrompt) {
        promptText = `你是 ${alias}。\n\n${opts.systemPrompt}`;
      }

      const profile: Profile = {
        anet_version: "0.1.0",
        node_id: generateNodeId(),
        node_name: alias,
        alias,
        runtime: opts.runtime,
        ...(opts.model ? { model: opts.model } : {}),
        ...(gc.network_id ? { network_id: gc.network_id } : {}),
        channels: ["server:commhub"],
        env: envMap,
        flags: { dangerouslySkipPermissions: true },
        ...(promptText ? { systemPrompt: promptText } : {}),
        ...(opts.team ? { team: opts.team } : {}),
        ...(opts.leaderAlias ? { role } : {}),
      };

      try {
        await ensureNodeToken(profile, alias);
      } catch (e: any) {
        console.error(`        ❌ ${alias.padEnd(14)} ntok_ 请求失败: ${e.message}`);
        failed.push(alias);
        continue;
      }
      saveProfile(alias, profile);
      created.push(alias);
      if (opts.printSummary !== false) {
        const roleTag = opts.leaderAlias ? ` (${role.padEnd(7)})` : "";
        console.log(`        ✓ ${alias.padEnd(14)}${roleTag}  ${nodeDir}`);
      }
    }
  } finally {
    process.chdir(origCwd);
  }

  // Launch via tmux. We launch in a second pass so a partial config failure
  // doesn't leave half-started tmux sessions running with no config.
  if (created.length > 0) {
    if (opts.printSummary !== false) {
      console.log(`\n[anet] 启动 ${created.length} 个 tmux session...`);
    }
    try {
      for (let idx = 0; idx < created.length; idx++) {
        const alias = created[idx];
        // Map created[idx] back to its original i — index in `created` may be
        // gappy if some entries went into `failed`. We track that by scanning.
        // For workdir-separate mode we need the matching nodeK dir.
        let nodeI = -1;
        for (let i = 1; i <= opts.count; i++) {
          if (batchAliasFor(opts, i).alias === alias) { nodeI = i; break; }
        }
        const nodeDir = nodeI > 0 ? batchNodeDirFor(opts, nodeI) : opts.workdir;
        const sessName = `${tmuxPrefix}-${alias}`;
        killTmuxSession(sessName);
        try {
          process.chdir(nodeDir);
          startNodeTmuxSession(sessName, alias);
          if (opts.printSummary !== false) console.log(`        ✓ ${sessName}`);
        } catch (e: any) {
          console.error(`        ❌ tmux ${alias}: ${e.message}`);
        }
      }
    } finally {
      process.chdir(origCwd);
    }
  }

  return { workdir: opts.workdir, createdAliases: created, failedAliases: failed, tmuxPrefix };
}

// Batch lifecycle (issue #55 #6 "能够 restart all" + extended verbs):
//   - start    re-launch tmux for all `${prefix}-*` configs (skips already-running)
//   - stop     kill any tmux session matching `${prefix}-*`
//   - restart  stop + start (best-effort; relies on saved .anet/nodes/ configs)
//   - cleanup  stop + rm -rf <workdir>/node*  + remove empty <workdir>
//   - list     enumerate distinct `<prefix>` groups currently active in tmux

function batchLifecycle(opts: { prefix: string; verb: "start" | "stop" | "restart" | "cleanup" | "list"; workdir?: string }) {
  const { prefix, verb, workdir } = opts;

  if (verb === "list") {
    let sessions: string[] = [];
    try {
      const out = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null || true", { encoding: "utf-8" });
      sessions = out.split("\n").filter(s => s && s.includes("-"));
    } catch {}
    const groups = new Map<string, string[]>();
    for (const sess of sessions) {
      const idx = sess.indexOf("-");
      const p = sess.slice(0, idx);
      const alias = sess.slice(idx + 1);
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p)!.push(alias);
    }
    if (groups.size === 0) {
      console.log("[anet] No batch tmux sessions found.");
      return;
    }
    console.log(`[anet] Active batch groups (${groups.size}):`);
    for (const [p, aliases] of groups) {
      console.log(`  ${p.padEnd(20)} (${aliases.length} node)`);
      for (const a of aliases.slice(0, 5)) console.log(`    - ${a}`);
      if (aliases.length > 5) console.log(`    ... +${aliases.length - 5} more`);
    }
    return;
  }

  // stop/restart/cleanup share a "kill matching tmux sessions" pass.
  let killedCount = 0;
  try {
    const out = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null || true", { encoding: "utf-8" });
    const sessions = out.split("\n").filter(s => s.startsWith(`${prefix}-`));
    for (const sess of sessions) {
      killTmuxSession(sess);
      killedCount++;
    }
  } catch {}
  console.log(`[anet] killed ${killedCount} tmux session(s) matching ${prefix}-*`);

  if (verb === "stop") return;

  if (verb === "cleanup") {
    const dir = workdir;
    if (!dir) {
      console.error("[anet] cleanup 需要 --workdir <path> 指明清理目录。");
      return;
    }
    if (!existsSync(dir)) {
      console.error(`[anet] 工作目录不存在: ${dir}`);
      return;
    }
    const subdirs = readdirSync(dir).filter(name => name.startsWith("node") && statSync(join(dir, name)).isDirectory());
    for (const sub of subdirs) {
      rmSync(join(dir, sub), { recursive: true, force: true });
    }
    try {
      const remaining = readdirSync(dir);
      if (remaining.length === 0) rmSync(dir, { recursive: true, force: true });
    } catch {}
    console.log(`[anet] 清理完成: ${dir}`);
    // Phase 1 limitation: cleanup only handles `--workdir-mode separate` (each
    // node has its own `<workdir>/node{i}/.anet/nodes/...` tree). For
    // `--workdir-mode shared`, configs live under `<workdir>/.anet/nodes/${prefix}*号`
    // and need a manual `rm -rf` (no registry yet to know which aliases this
    // batch owns vs. other batches that may share the same dir). Phase 2 will
    // add a `~/.anet/batches.json` marker registry to make shared-mode cleanup
    // safe; until then surfacing the gap loudly per 通信牛 PR #60 review.
    if (subdirs.length === 0 && existsSync(join(dir, ".anet", "nodes"))) {
      console.warn(`[anet] ⚠ shared workdir-mode 限制: no node*/ subdirs to remove. Configs under`);
      console.warn(`        ${join(dir, ".anet", "nodes")}/${prefix}*号/  remain on disk. Phase 1 cleanup`);
      console.warn(`        only handles separate workdir-mode. Manual: rm -rf '${join(dir, ".anet", "nodes")}'/${prefix}*号`);
    }
    return;
  }

  if (verb === "restart" || verb === "start") {
    // Phase 1: restart/start in-place is not yet wired (would need to walk
    // saved .anet/nodes/<alias>/config.json under <workdir>/node*/ and
    // re-launch tmux). For now, hint the user to re-run the create wizard.
    console.log(`[anet] '${verb}' in-place not yet implemented (Phase 1 scaffold). Re-run:`);
    console.log(`         anet create --batch    # generic`);
    console.log(`         anet demo sci-team     # sci-team preset`);
    return;
  }
}

// ── batch wizard (anet create --batch) ──
//
// Verified preset list — must stay in sync with the auth-fail flow (cli.ts
// L1116+) and the `anet demo sci-team` preset (Vincent commit 1bc03c0 chain).
// New presets only after per-vendor verify-with-real-call (per
// [[feedback_vendor_verify_before_hardcode]]).

const BATCH_PRESETS: Array<{
  value: string;
  label: string;
  runtime: string;
  model?: string;
  baseUrl?: string;
}> = [
  // intern-s2-preview = default model (Vincent 4644+4645) — listed first so the
  // batch picker preselects it. [UNVERIFIED] — pending real-call verify, intern
  // key 待 Vincent 提供后验. runtime http-api: claude-agent-sdk ↔ intern endpoint
  // hangs (#98 root-cause); no intern preset may stay on a runtime that hangs.
  { value: "intern-s2-preview",  label: "http-api + intern-s2-preview (书生 Intern, 默认, https://chat.intern-ai.org.cn) [UNVERIFIED]",
    runtime: "http-api",         model: "intern-s2-preview", baseUrl: "https://chat.intern-ai.org.cn" },
  { value: "intern-s1-pro",      label: "http-api + intern-s1-pro (书生 Intern, https://chat.intern-ai.org.cn)",
    runtime: "http-api",         model: "intern-s1-pro",     baseUrl: "https://chat.intern-ai.org.cn" },
  { value: "MiniMax-M2.7",       label: "claude-agent-sdk + MiniMax-M2.7 (https://api.minimaxi.com/anthropic)",
    runtime: "claude-agent-sdk", model: "MiniMax-M2.7",      baseUrl: "https://api.minimaxi.com/anthropic" },
  { value: "claude-sonnet-4-6",  label: "claude-agent-sdk + claude-sonnet-4-6 (Anthropic default)",
    runtime: "claude-agent-sdk", model: "claude-sonnet-4-6" },
  { value: "claude-opus-4-6",    label: "claude-agent-sdk + claude-opus-4-6 (Anthropic default)",
    runtime: "claude-agent-sdk", model: "claude-opus-4-6" },
  { value: "claude-haiku-4-5",   label: "claude-agent-sdk + claude-haiku-4-5 (Anthropic default)",
    runtime: "claude-agent-sdk", model: "claude-haiku-4-5" },
  { value: "__custom__",         label: "Custom — 自行输入 runtime / base URL / model",
    runtime: "" },
];

async function createBatchWizardCommand() {
  const opts = parseOpts();
  const help = args.includes("--help") || args.includes("-h");
  if (help) {
    console.log(`
  anet create --batch — 批量创建 N 个 agent (issue #55)

  Usage:
    anet create --batch [--preset <key>] [--api-key <key>] [--workdir <path>]
                        [--workdir-mode separate|shared] [--prefix <name>]
                        [--count <N>] [--description <text>]
                        [--leader-alias <name>]

  Wizard fields (任一可用 --flag 跳过):
    --preset <key>        intern-s2-preview (默认) / intern-s1-pro / MiniMax-M2.7 /
                          claude-sonnet-4-6 / claude-opus-4-6 / claude-haiku-4-5 /
                          __custom__
    --api-key <key>       runtime auth token (ANTHROPIC_AUTH_TOKEN or 等价)
    --workdir <path>      父目录, default ~/anet-team
    --workdir-mode        separate (default, <workdir>/node{i}) | shared (单 dir)
    --prefix <name>       alias 前缀, e.g. 工程师 → 工程师1号..工程师N号
    --count <N>           1-50
    --description <text>  systemPrompt 内容 (空 → no systemPrompt)
    --leader-alias <name> 设了 → i=1 = leader with this alias, i>1 workers

  Lifecycle (issue #55 #6 "能够 restart all"):
    anet batch start  <prefix>   # launch (Phase 1: hint re-run create)
    anet batch stop   <prefix>   # kill all matching tmux
    anet batch list              # all active batch groups
    anet batch cleanup <prefix> [--workdir <path>]   # stop + rm -rf <workdir>/node*/
    anet batch restart <prefix>  # stop + start (Phase 1 hint)

  Phase 1 cleanup limitation: only --workdir-mode separate is fully cleaned
  (rm <workdir>/node*). For --workdir-mode shared, configs at
  <workdir>/.anet/nodes/<prefix>*号/ stay on disk — manual rm needed
  (registry-based safe cleanup is Phase 2).

  Vendor presets are Vincent-verified (commit 1bc03c0). For codex / other
  vendors not yet verified, use --preset __custom__ and paste your own
  runtime / baseUrl / model values.

  Spec: issue #55 / RFC-008 (multi-agent team convention)
`);
    return;
  }

  const gc = loadGlobal();
  if (!gc.hub) {
    console.error("[anet] 未找到 CommHub Server。先运行 'anet hub start' 或 'anet init --hub <url>'");
    return;
  }

  // 1. Preset
  let presetKey = opts.preset || "";
  if (!presetKey) {
    presetKey = await askChoice("Model preset", BATCH_PRESETS.map(p => ({ label: p.label, value: p.value })));
  }
  const preset = BATCH_PRESETS.find(p => p.value === presetKey);
  if (!preset) {
    closeRL();
    console.error(`[anet] Unknown preset: ${presetKey}. Use --help to see verified list.`);
    return;
  }

  let runtime = preset.runtime;
  let model = preset.model;
  let baseUrl = preset.baseUrl;
  if (preset.value === "__custom__") {
    const customRuntime = await ask("Runtime (claude-agent-sdk / codex-sdk / claude-code-cli / http-api)", "claude-agent-sdk");
    runtime = normalizeRuntime(customRuntime);
    const customBase = await ask("ANTHROPIC_BASE_URL (空白=Anthropic default)", "");
    if (customBase) baseUrl = customBase;
    const customModel = await ask("Model id", "");
    if (customModel) model = customModel;
  }

  // 2. API key
  const apiKey = opts["api-key"] || opts.key || process.env.ANET_BATCH_API_KEY || await ask("API key (ANTHROPIC_AUTH_TOKEN)");
  if (!apiKey) {
    closeRL();
    console.error("[anet] API key required.");
    return;
  }

  // 3. Workdir
  const workdir = opts.workdir || await ask("Workdir", join(home, "anet-team"));
  const workdirMode = (opts["workdir-mode"] || "separate") as "separate" | "shared";
  if (workdirMode !== "separate" && workdirMode !== "shared") {
    closeRL();
    console.error(`[anet] --workdir-mode must be 'separate' or 'shared', got: ${workdirMode}`);
    return;
  }

  // 4. Prefix + count
  const prefix = opts.prefix || await ask("Node prefix (e.g. 工程师)", "工程师");
  const countRaw = parseInt(opts.count || await ask("Count (1-50)", "5"), 10);
  const count = Math.max(1, Math.min(50, Number.isFinite(countRaw) ? countRaw : 5));
  if (count !== countRaw) {
    console.log(`  [anet] Count ${countRaw} → clamped to [1,50] = ${count}`);
  }
  if (count > 20) {
    console.warn(`  [anet] Warning: count=${count} > 20 may exceed memory/ulimit on a developer laptop. Recommended ≤ 20 unless tested.`);
  }

  // 5. Description (systemPrompt)
  // parseOpts maps a valueless/empty `--description` (e.g. `--description ""`)
  // to the sentinel string "true"; treat that as "not provided" (#93).
  const descFlag = opts.description === "true" ? "" : opts.description;
  const description = descFlag || await ask("Description / system prompt (空 → no prompt)", "");

  const leaderAlias = opts["leader-alias"] || "";
  closeRL();

  // Auto-login if no user token (same admin/anethub pattern as demo sci-team)
  if (!gc.token || !gc.user) {
    console.log(`\n[anet] 没有 user token，自动用 default admin/anethub 登录...`);
    const loginRes = await fetch(`${gc.hub}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "anethub" }),
    }).then(r => r.json() as any).catch(() => null);
    if (!loginRes?.ok) {
      console.error(`[anet] 自动登录失败: ${loginRes?.error || "unknown"}. 先 'anet register' 创账号。`);
      return;
    }
    gc.token = loginRes.token;
    gc.user = loginRes.user;
    const nets = await fetch(`${gc.hub}/api/networks`, { headers: { Authorization: `Bearer ${loginRes.token}` } }).then(r => r.json() as any).catch(() => ({ networks: [] }));
    if (nets.networks?.length > 0) {
      gc.network_id = nets.networks[0].network_id;
      gc.network_name = nets.networks[0].network_name;
    }
    saveGlobal(gc);
    console.log(`        ✓ 登录: ${loginRes.user.username}`);
  }

  console.log(`\n[anet] Creating batch '${prefix}' × ${count} in ${workdir}/...`);
  console.log(`        Preset:        ${preset.label}`);
  console.log(`        Workdir mode:  ${workdirMode}`);
  if (leaderAlias) console.log(`        Leader alias:  ${leaderAlias}`);
  console.log();

  const result = await createBatch({
    prefix,
    count,
    workdir,
    workdirMode,
    runtime,
    model,
    baseUrl,
    apiKey,
    systemPrompt: description || undefined,
    leaderAlias: leaderAlias || undefined,
  });

  if (result.createdAliases.length === 0) {
    console.error(`\n[anet] No nodes created.`);
    return;
  }
  console.log(`\n[anet] 🏁 Batch '${prefix}' ready. ${result.createdAliases.length} node launched.`);
  if (result.failedAliases.length > 0) {
    console.log(`        ⚠ ${result.failedAliases.length} 失败: ${result.failedAliases.join(", ")}`);
  }
  console.log(`        Stop:    anet batch stop ${result.tmuxPrefix}`);
  console.log(`        List:    anet batch list`);
  console.log(`        Cleanup: anet batch cleanup ${result.tmuxPrefix} --workdir ${workdir}`);
  console.log();
}

// ── batch top-level subcommand: anet batch <verb> ──

async function batchCommand() {
  const sub = args[1];
  if (!sub || sub === "-h" || sub === "--help" || sub.startsWith("-")) {
    console.log(`
  anet batch <verb> <prefix>   # batch lifecycle ops (issue #55)

  Verbs:
    start <prefix>                        re-launch (Phase 1: hint re-run create)
    stop <prefix>                         kill all tmux matching <prefix>-*
    restart <prefix>                      stop + start
    cleanup <prefix> --workdir <path>     stop + rm -rf <workdir>/node*/
                                          (shared workdir-mode leaves configs
                                          under <workdir>/.anet/nodes/; needs
                                          manual rm — registry is Phase 2)
    list                                  list all active batch groups
                                          (Phase 1: also catches non-anet tmux
                                          sessions whose names contain '-')

  See also: anet create --batch  (batch create wizard)
`);
    return;
  }
  const verb = sub;
  const validVerbs = ["start", "stop", "restart", "cleanup", "list"] as const;
  if (!(validVerbs as readonly string[]).includes(verb)) {
    console.error(`[anet] Unknown batch verb '${verb}'. Valid: ${validVerbs.join(" / ")}`);
    return;
  }

  if (verb === "list") {
    return batchLifecycle({ prefix: "", verb: "list" });
  }

  const prefix = args[2];
  if (!prefix) {
    console.error(`[anet] Usage: anet batch ${verb} <prefix>`);
    return;
  }
  const opts = parseOpts();
  const workdir = opts.workdir;
  return batchLifecycle({ prefix, verb: verb as "start" | "stop" | "restart" | "cleanup", workdir });
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

  // Probe each ntok_ against hub; auto-reissue any that hub rejects with 401.
  // This handles "hub DB was wiped / token revoked" — the node config is
  // otherwise valid, only the token string is stale. We patch only the token
  // field, preserving session_id / channels / runtime / everything else.
  if (fix && gc.hub && gc.token && gc.network_id) {
    // Probe ALL nodes with ntok_, regardless of other issues — the migrateNode
    // pass above only re-issues when token is missing / utok_ / atok_ /
    // untyped; a hub-rejected ntok_ slips past it (Vincent reported this).
    const staleNtokNodes: string[] = [];
    for (const id of ids) {
      const p = loadProfile(id);
      if (!p?.token?.startsWith("ntok_")) continue;
      try {
        const r = await fetch(`${gc.hub}/api/auth/me`, {
          headers: { Authorization: `Bearer ${p.token}` },
        });
        if (r.status === 401 || r.status === 403) staleNtokNodes.push(id);
      } catch { /* network error — skip, don't false-alarm */ }
    }
    if (staleNtokNodes.length) {
      console.log(`\n  ⚙  Probing ntok_ ... ${staleNtokNodes.length} node(s) rejected by hub. Re-issuing...`);
      for (const id of staleNtokNodes) {
        const p = loadProfile(id);
        if (!p) continue;
        const nodeName = p.node_name || p.name || p.alias || id;
        try {
          const r = await fetch(`${gc.hub}/api/auth/node-token`, {
            method: "POST",
            headers: { Authorization: `Bearer ${gc.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ network_id: gc.network_id, node_name: nodeName }),
          });
          const body = await r.json() as any;
          if (body?.ok && body.token) {
            p.token = body.token;
            saveProfile(id, p);
            console.log(`     ✅ ${id}: ntok_ re-issued (…${body.token.slice(-6)}), session/channels/role preserved`);
            ok++;
          } else {
            console.log(`     ❌ ${id}: re-issue failed: ${body?.error || r.status}`);
            fail++;
          }
        } catch (e: any) {
          console.log(`     ❌ ${id}: re-issue threw: ${e.message}`);
          fail++;
        }
      }
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
  case "batch": await batchCommand(); break;
  case "logs": logsCommand(); break;
  case "info": await infoCommand(); break;
  case "config": configShowCommand(); break;
  case "login": await loginCommand(); break;
  case "register": await registerCommand(); break;
  case "quickstart": {
    // Removed per issue #45. Print migration help and exit non-zero so users
    // notice the breakage instead of silently failing.
    console.error(`[anet] ⚠ 'anet quickstart' 已删除（per #45）。改用现代命令组合:
  anet hub start          # 起 CommHub Server
  anet setup              # 装 runtime deps + 选 runtime (wizard)
  anet register           # 创建账号
  anet login              # 登录
  anet node create <name> # 创建 agent

或一键 demo: cd demos/hello-world && docker compose up`);
    process.exit(1);
  }
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
