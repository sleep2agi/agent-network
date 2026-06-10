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

import { chmodSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, rmSync, cpSync } from "fs";
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
  // #117 helper used by `anet project up/restart` + the debate/social/PR-review
  // demos. Spawns a detached tmux session that runs `anet node start <alias>`
  // (which since #136 defaults to foreground — no auto-tmux nesting).
  execFileSync("tmux", ["new-session", "-d", "-s", sessionName, `anet node start ${shellQuote(alias)}`], { stdio: "pipe" });
}
function tmuxSessionRunning(name: string): boolean {
  try { execFileSync("tmux", ["has-session", "-t", name], { stdio: "pipe" }); return true; }
  catch { return false; }
}
// #122 — gate auto-tmux on tmux actually being installed. The CLI never
// hard-depends on tmux (a fresh dev box without it should still get a working
// foreground start), so this is best-effort with a short-circuit cache.
let tmuxAvailableCache: boolean | null = null;
function tmuxAvailable(): boolean {
  if (tmuxAvailableCache !== null) return tmuxAvailableCache;
  try { execFileSync("tmux", ["-V"], { stdio: "pipe" }); tmuxAvailableCache = true; }
  catch { tmuxAvailableCache = false; }
  return tmuxAvailableCache;
}

// Pin commhub-server to a specific version to defeat bunx caching of older
// versions (bunx with @preview caches the first-resolved version and may not
// refetch). A `latest` agent-network release must pin a *stable* server.
// `anet upgrade` (#88) surfaces this constant in its plan output so users
// understand global-install version != version anet hub start actually runs.
const PINNED_SERVER_VERSION = "0.8.5";
function sessionFileExists(uuid: string, cwd: string = process.cwd()): boolean {
  if (!uuid) return false;
  return existsSync(join(homedir(), ".claude", "projects", encodeCwd(cwd), `${uuid}.jsonl`));
}

function claudeProjectDir(cwd: string = process.cwd()): string {
  return join(homedir(), ".claude", "projects", encodeCwd(cwd));
}

interface ClaudeSessionInfo { id: string; mtimeMs: number; sizeBytes: number; summary: string; }

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B`
    : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)}KB`
    : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatAge(mtimeMs: number): string {
  const min = (Date.now() - mtimeMs) / 60000;
  if (min < 60) return `${Math.max(1, Math.round(min))}m ago`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Best-effort one-line label for a session: prefer a `summary` entry, else the
// first user message. Reads only the head of the file (sessions can be huge).
function parseSessionSummary(jsonlPath: string): string {
  try {
    const head = readFileSync(jsonlPath, "utf-8").slice(0, 16384);
    const lines = head.split("\n").filter(Boolean).slice(0, 12);
    let firstUser = "";
    for (const line of lines) {
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj?.type === "summary" && typeof obj.summary === "string") {
        return `(summary) ${obj.summary}`.replace(/\s+/g, " ").slice(0, 60);
      }
      if (!firstUser && obj?.type === "user") {
        const c = obj.message?.content;
        const text = typeof c === "string" ? c
          : Array.isArray(c) ? (c.find((x: any) => x?.type === "text")?.text || "") : "";
        if (text) firstUser = text;
      }
    }
    return firstUser ? firstUser.replace(/\s+/g, " ").slice(0, 60) : "(no preview)";
  } catch {
    return "(no preview)";
  }
}

// #149 (Vincent 5448) + #156 (Vincent 5531) — codex-sdk runtime fast/yolo
// posture. agent-node's processWithCodex already hardcodes these defaults,
// but writing them to config.json makes the permission posture visible to
// the user and overridable per-node. Source of truth for both single-node
// (createProfileFromOpts) and batch (createBatch) creation paths — adding
// a fifth yolo here propagates to every path automatically (was the v0.10.6
// gap that caused #156: batch path only wrote 1/4 because it didn't share
// the single-node inline construction).
//
// `--no-yolo` opt-out is for CI / scripted users who need explicit
// permission posture (returns empty so caller's `dangerouslySkipPermissions:
// true` is the only yolo-ish flag landing in config).
function codexSdkYoloFlags(noYolo?: boolean): Record<string, string | boolean> {
  if (noYolo) return {};
  return {
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
    skipGitRepoCheck: true,
  };
}

// Scan ~/.claude/projects/<cwd-key>/*.jsonl — the Claude Code sessions that
// belong to this directory. Newest first. Shared by `anet session ls` and the
// `anet node create` resume picker (#115).
function listClaudeSessions(cwd: string = process.cwd()): ClaudeSessionInfo[] {
  const dir = claudeProjectDir(cwd);
  if (!existsSync(dir)) return [];
  const out: ClaudeSessionInfo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const full = join(dir, f);
    let st;
    try { st = statSync(full); } catch { continue; }
    out.push({
      id: f.replace(/\.jsonl$/, ""),
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      summary: parseSessionSummary(full),
    });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// #115 — `anet node create` resume picker. Returns a session id to bind, or
// null for "fresh session". TTY-only; callers guard on process.stdin.isTTY.
async function pickClaudeSession(alias: string, cwd: string = process.cwd()): Promise<string | null> {
  const sessions = listClaudeSessions(cwd);
  if (sessions.length === 0) return null; // nothing to resume — silently fresh
  const mode = await select({
    message: `Claude session for "${alias}":`,
    choices: [
      { value: "__fresh__", name: "新开 session (fresh)" },
      { value: "__resume__", name: `Resume 已有 session… (${sessions.length} available)` },
    ],
  });
  if (mode === "__fresh__") return null;
  return await select({
    message: "选择要绑定的 session:",
    choices: sessions.map(s => ({
      value: s.id,
      name: `${s.id.slice(0, 8)}…  ${formatAge(s.mtimeMs).padEnd(8)} ${formatSize(s.sizeBytes).padStart(7)}  ${s.summary}`,
    })),
  });
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

// #204 preview.5 — shared resolver + refresher for `.anet/node-server.js`. The
// MCP channel plugin file lives at `<cwd>/.anet/node-server.js`; we previously
// only wrote it when missing (`anet init project`) which let stale copies
// linger across upgrades. Vincent's grok-build-acp UAT hit "serde error
// expected value at line 1 column 2" when Grok ACP spawned an outdated
// node-server.js that wrote non-JSON-RPC bytes to stdout. The refresher now
// overwrites on demand (called from launchAgent before grok-build-acp
// spawn) so the file matches the currently-installed agent-network version.
function findBundledNodeServerJs(): string | null {
  const here = new URL(".", import.meta.url).pathname;
  const candidates = [
    join(here, "..", "..", "dist", "src", "node-server.js"),  // installed npm package layout
    join(here, "..", "src", "node-server.js"),
    join(here, "..", "..", "src", "node-server.ts"),
    join(process.argv[1], "..", "..", "dist", "src", "node-server.js"),
    join(process.argv[1], "..", "..", "src", "node-server.ts"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function refreshNodeServerJsAt(targetPath: string, opts: { overwrite: boolean }): "wrote" | "exists" | "no-source" {
  const exists = existsSync(targetPath);
  if (exists && !opts.overwrite) return "exists";
  const src = findBundledNodeServerJs();
  if (!src) return "no-source";
  // Read+write rather than copyFile so .ts sources get content-substituted
  // verbatim (we're writing to a .js path either way; bun runs .ts content
  // under a .js extension fine, per the legacy candidates).
  writeFileSync(targetPath, readFileSync(src, "utf-8"));
  return "wrote";
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

type RuntimeName = "claude-code-cli" | "codex-sdk" | "claude-agent-sdk" | "grok-build-acp";

function normalizeRuntime(profileOrRuntime?: Profile | string): RuntimeName {
  if (typeof profileOrRuntime === "string") {
    if (profileOrRuntime === "codex" || profileOrRuntime === "codex-sdk") return "codex-sdk";
    if (profileOrRuntime === "grok" || profileOrRuntime === "grok-build" || profileOrRuntime === "grok-build-acp") return "grok-build-acp";
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

// #173 — boolean (no-value) flags must NOT swallow the following token as a
// value. parseOpts's heuristic ("--flag" + non-"--" token → that token is the
// value) would otherwise read `anet node start --all foo` as all="foo".
const BOOLEAN_FLAGS = new Set(["--all", "--tmux", "--new-session"]);

// #173 — extract the bare positional operands from an argv slice, mirroring
// parseOpts's flag/value consumption, so `--all`'s mutual exclusion with a
// positional <alias> can be detected reliably.
function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--channel" || a === "--env") { i++; continue; }  // multi-value flags
    if (a.startsWith("--")) {
      if (!BOOLEAN_FLAGS.has(a) && argv[i + 1] && !argv[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
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
  prerelease?: string;  // #192 — optional `-preview.N` / `-rc.0` etc. for display only
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
  // #192 — capture optional prerelease (`-preview.N` etc.) so `anet -v`
  // Components shows the full installed version, not just major.minor.patch.
  // compareSemver still ignores prerelease (intentional — preview ≡ release
  // for the upgrade-check at cli.ts:4202/4321), so adding the field is
  // display-only and does not regress the upgrade-needed logic.
  const match = text.match(/(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?(?:[^0-9]|$)/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    ...(match[4] ? { prerelease: match[4] } : {}),
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
      version: `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? `-${parsed.prerelease}` : ""}`,  // #192
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
      version: `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? `-${parsed.prerelease}` : ""}`,  // #192
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
        name: `grok-build-acp — Grok Build ACP${isInstalled(versions.agentNode) ? "（需要 agent-node + grok CLI）" : "（需要安装 agent-node + grok CLI）"}`,
        value: "grok-build-acp",
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
  if (runtimeSelections.includes("grok-build-acp") && !isInstalled(versions.agentNode)) {
    addPackage("@sleep2agi/agent-node");
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
  if (runtimeSelections.includes("codex-sdk") || runtimeSelections.includes("claude-agent-sdk") || runtimeSelections.includes("grok-build-acp")) {
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
  if (runtimeSelections.includes("grok-build-acp")) {
    console.log(`  ⚠ grok 需要安装并登录: grok auth login 或 x.ai CLI 认证缓存`);
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
  if (runtime === "grok-build-acp" && !commandExists("grok")) {
    console.warn(`[anet] Warning: grok CLI not found in PATH.`);
    console.warn(`[anet] Install/login Grok Build first: https://x.ai/cli`);
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
  anet node start --all          Start every node in cwd (= anet project up)
  anet node stop <name>          Stop a running node
  anet node resume <name>        Resume interrupted session
  anet node delete <name>        Delete node and config
  anet node rename <ref> <new>   Rename a node
  anet node ls                   List all nodes
  anet info <name>              Detailed node info + server status
  anet status                   Network overview (agents + tasks)
  anet tasks [status]           Query tasks (replied/failed/delivered)
  anet goal list [node]          List local scheduled goals
  anet goal show <node> <id>     Show one goal in detail (progress log)
  anet goal edit <node> <id> ... Edit a goal's interval / text / status
  anet goal cancel <node> <id>   Mark a scheduled goal cancelled

Project (cwd-wide):
  anet project up                Start every node in cwd (skip already-running)
  anet project restart           Kill existing tmux + start fresh (every node)
  anet project down              Stop every node + notify hub offline
  --stagger <s>                  Delay between nodes (default: 3, 0 disables)
  --only a,b / --exclude x,y     Filter by alias or node id

Session:
  anet node create <name> --resume <id>  Bind an existing Claude session
  anet node create <name> --resume-latest  Bind the latest Claude session
  anet node start <name>                 Start in this terminal (foreground, default)
  anet node start <name> --tmux          Start in a new tmux session + attach
  anet node start <name> --new-session   Start with fresh Claude session
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
  anet upgrade                  Upgrade all anet packages (channel-aware)
  anet upgrade --channel preview|latest --dry-run --self  (see flags)

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

  // 1. Write node-server.ts (uses shared resolver below)
  const serverTs = join(anetDir, "node-server.js");
  const refreshed = refreshNodeServerJsAt(serverTs, { overwrite: false });
  if (refreshed === "wrote")        console.log(`  ✅ .anet/node-server.js`);
  else if (refreshed === "exists")  console.log("  Channel plugin: exists");
  else {
    console.log(`  ❌ Cannot find node-server.js source`);
    console.log(`  Fix: cp $(npm root -g)/@sleep2agi/agent-network/src/node-server.ts .anet/node-server.js`);
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
  const defaultModel = runtime === "codex-sdk" ? "gpt-5.5" : undefined;

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
      // #149/#156 — codex-sdk fast/yolo flags via shared helper (was inline
      // here only; #156 batch path missed it because of duplication).
      ...(runtime === "codex-sdk" ? codexSdkYoloFlags(opts["no-yolo"] === "true") : {}),
    },
    ...(opts.session || runtime === "claude-code-cli" ? { session: opts.session || randomUUID() } : {}),
  };
  return profile;
}

// #125 fix (preview.3) — share one resolver between the two launchAgent paths
// (claude-agent-sdk runtime + claude-code-cli runtime). Earlier preview.2
// inlined `v.replace(/^~/, home)` at each spawn site, which crashed when v was
// an envRef object instead of a string. The resolver now: (a) returns the
// string verbatim with ~ expansion, (b) resolves envRef objects from
// process.env and FATAL-fails the parent CLI when the referenced var is
// missing — same UX as agent-node's own resolver, just earlier in the chain
// so we don't fork into a crashing child.
function resolveProfileEnv(profileEnv: Record<string, any> | undefined, home: string, dotenvMap?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!profileEnv || typeof profileEnv !== "object") return out;
  for (const [k, v] of Object.entries(profileEnv)) {
    if (typeof v === "string") {
      out[k] = v.replace(/^~/, home);
      continue;
    }
    if (v && typeof v === "object" && typeof (v as any)._envRef === "string") {
      const refName = (v as any)._envRef;
      // #193 envRef Option A — priority: explicit shell env > per-node
      // .anet/nodes/<id>/.env file. Closes the wizard-create-then-start
      // deadlock without forcing the user to manually `export` before start;
      // existing shell env still wins, so prior-working setups don't change.
      const refVal = process.env[refName] ?? dotenvMap?.[refName];
      if (refVal === undefined || refVal === "") {
        console.error(`[anet] FATAL: config.json env.${k} references env var "${refName}" but it is not set in this shell or in .anet/nodes/<id>/.env.`);
        console.error(`[anet]        Fix: export ${refName}=<your-value>  then re-run anet node start`);
        console.error(`[anet]        (or restore .anet/nodes/<id>/.env from your secrets manager)`);
        process.exit(1);
      }
      out[k] = refVal;
      continue;
    }
    // Any other shape is ignored — env values must be string or envRef object.
  }
  return out;
}

// #193 envRef Option A — read a node's per-node secret store from
// .anet/nodes/<id>/.env (mode 600, gitignored). Parses KEY=VALUE lines, one
// per line, no quotes, no shell expansion. Returns {} if the file is missing
// or unreadable. Caller logs the *key count* — never the values.
function loadNodeDotenv(nodeId: string): Record<string, string> {
  const path = join(nodesDir(), nodeId, ".env");
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1);  // do NOT trim — token values are taken verbatim after the first `=`
      if (key) out[key] = val;
    }
    return out;
  } catch { return {}; }
}

// #193 envRef Option A — ensure the user's project-level `.anet/.gitignore`
// covers per-node .env secret stores. Idempotent: appends the rule only when
// missing; never touches existing rules.
function ensureNodeDotenvGitignore(): void {
  try {
    const anetDir = join(process.cwd(), ".anet");
    if (!existsSync(anetDir)) return;  // no .anet/ yet — nothing to protect
    const gi = join(anetDir, ".gitignore");
    const rule = "nodes/*/.env";
    let content = "";
    if (existsSync(gi)) content = readFileSync(gi, "utf-8");
    if (content.split("\n").some(l => l.trim() === rule)) return;
    const sep = content && !content.endsWith("\n") ? "\n" : "";
    writeFileSync(gi, content + sep + rule + "\n");
  } catch {}
}

function saveCreatedNode(id: string, profile: Profile) {
  // #125 fix: rewrite plain-secret env values to the envRef shape **at create
  // time**, before the config first hits disk. Keeps secrets out of git
  // history, dashboard, anet ls -v, etc. User sees a banner with `export …`
  // lines so they know what to drop into ~/.bashrc.
  rewritePlainSecretsToEnvRef(id, profile);
  writeLegacyProjectAlias(profile.node_name || id);
  saveProfile(id, profile);
}

// #125 — extracted helper so create + migrate-token-to-envref + (future)
// batch.ts share one definition of "what counts as a secret" and one derivation
// rule for the env-var name. Mutates profile.env in place.
function rewritePlainSecretsToEnvRef(nodeId: string, profile: Profile): void {
  const env: any = (profile as any).env;
  if (!env || typeof env !== "object") return;
  const SECRET_KEY_RX = /(_TOKEN|_KEY|_SECRET|AUTH)$/i;
  const SECRET_VAL_RX = /^(sk-|utok_|ntok_|atok_|ak-|gsk_|key-|Bearer\s)/i;
  const nodeIdShort = ((profile as any).node_id || nodeId).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 16);
  const rewrites: { key: string; refName: string; value: string }[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue; // already envRef
    if (!(SECRET_KEY_RX.test(k) || SECRET_VAL_RX.test(v))) continue;
    const refName = `${k}_${nodeIdShort}`.toUpperCase();
    rewrites.push({ key: k, refName, value: v });
    env[k] = { _envRef: refName };
    // Also surface the value in the *current* process.env so this very
    // session's downstream (e.g. spawning the agent right after create) can
    // start without the user having to re-`export`. Persistent storage is
    // still the user's responsibility (.bashrc / secrets manager).
    if (!process.env[refName]) process.env[refName] = v;
  }
  if (rewrites.length === 0) return;

  // #193 envRef Option A — persist the secrets to a per-node mode-600 .env
  // file alongside the config so `anet node start` self-sources them on a
  // fresh shell. Closes the wizard-create-then-start deadlock without
  // forcing the user to manually `export`. Idempotent: merges with any
  // existing keys; .gitignore is ensured so the file never leaks via git.
  try {
    const nodeDir = join(nodesDir(), nodeId);
    mkdirSync(nodeDir, { recursive: true });
    const dotenvPath = join(nodeDir, ".env");
    const merged = loadNodeDotenv(nodeId);
    for (const { refName, value } of rewrites) merged[refName] = value;
    const body = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    writeFileSync(dotenvPath, body, { mode: 0o600 });
    ensureNodeDotenvGitignore();
  } catch (e: any) {
    console.warn(`[anet] ⚠ could not write per-node .env: ${e?.message || e} — fall back to manual export only.`);
  }

  console.log(`\n[anet] 🔐 ${rewrites.length} secret value(s) in env moved out of config.json (envRef shape, #125).`);
  console.log(`[anet]    Persisted to .anet/nodes/${nodeId}/.env (mode 600, gitignored) — \`anet node start\` auto-loads it.`);
  console.log(`[anet]    For cross-machine / cross-shell portability, also append to ~/.bashrc / ~/.zshrc:`);
  console.log("");
  for (const { refName, value } of rewrites) {
    const safe = value.replace(/'/g, `'\\''`);
    console.log(`    export ${refName}='${safe}'`);
  }
  console.log("");
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

// ── Unified vendor registry (issue #104-B) ──
//
// Single source of truth for vendor → model → runtime/baseUrl wiring. This
// consolidated the previously-scattered MODEL_PRESETS / PROVIDER_CHOICES /
// BATCH_PRESETS / inline Path-A picker — all three create flows now use
// selectVendorAndModel() (B2) and the old structures were removed (B3).
// Vincent 4677+4679: "先选供应商，然后再选模型" — the create wizard is vendor-first.
//
// Every entry's baseUrl + model ids are verified-with-real-call before
// landing (feedback_vendor_verify_before_hardcode). Unverified providers
// (DeepSeek / GLM / Kimi) are intentionally NOT in this list — the `custom`
// vendor is the honest home for not-yet-verified Anthropic-compatible APIs
// (通信龙 decision on #104-B design pass).

type VendorEnvKey = "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";

interface VendorModel {
  id: string;        // exact API model id (case-sensitive — the vendor's /v1/models is authoritative)
  label?: string;    // display label in the model picker; defaults to id
  default?: boolean; // preselected in the model picker
}

interface Vendor {
  key: string;                  // stable key — also accepted by --preset for back-compat
  label: string;                // vendor picker label
  runtime: RuntimeName;         // claude-agent-sdk | codex-sdk | claude-code-cli
  baseUrl?: string;             // ANTHROPIC_BASE_URL value (omit = Anthropic-native / not applicable)
  envKey?: VendorEnvKey;        // which env var the API key goes into
  signupUrl?: string;           // "where to get a key" hint
  requiresAuth?: "claude" | "codex"; // runtime needs an external login instead of an API key
  models: VendorModel[];        // [] = freeform: ask the user for a model id (custom), or none (claude-code)
  freeformBaseUrl?: boolean;    // custom only: ask the user for the base URL
}

const VENDORS: Vendor[] = [
  {
    // bare hostname, no /anthropic suffix (Vincent verified 2026-05-13 telegram 4227).
    // intern-s2-preview verified by 通信测试马 real-call 2026-05-14.
    key: "intern", label: "上海 AI Lab 书生 (Intern)",
    runtime: "claude-agent-sdk", baseUrl: "https://chat.intern-ai.org.cn",
    envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://chat.intern-ai.org.cn/",
    models: [
      { id: "intern-s2-preview", label: "intern-s2-preview (默认)", default: true },
      { id: "intern-s1-pro" },
    ],
  },
  {
    key: "minimax", label: "MiniMax (国内直连，低成本)",
    runtime: "claude-agent-sdk", baseUrl: "https://api.minimaxi.com/anthropic",
    envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://platform.minimaxi.com",
    models: [{ id: "MiniMax-M2.7", default: true }],
  },
  {
    // /anthropic suffix; verified by 通信SDK马 real-call 2026-05-15 (#104).
    key: "mimo", label: "小米 MiMo",
    runtime: "claude-agent-sdk", baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
    envKey: "ANTHROPIC_AUTH_TOKEN", signupUrl: "https://platform.xiaomimimo.com",
    models: [
      { id: "mimo-v2.5-pro", label: "mimo-v2.5-pro (默认)", default: true },
      { id: "mimo-v2.5" },
      { id: "mimo-v2-pro" },
      { id: "mimo-v2-omni" },
      { id: "mimo-v2.5-tts-voicedesign" },  // #193 — included in Vincent text-callable list (TTS family kept Phase 2)
    ],
  },
  {
    key: "anthropic", label: "Anthropic Claude (官方 API)",
    runtime: "claude-agent-sdk", envKey: "ANTHROPIC_API_KEY",
    signupUrl: "https://console.anthropic.com",
    models: [
      { id: "claude-sonnet-4-6", default: true },
      { id: "claude-opus-4-6" },
      { id: "claude-haiku-4-5" },
    ],
  },
  {
    key: "codex", label: "Codex / GPT (海外，需 codex auth login)",
    runtime: "codex-sdk", requiresAuth: "codex",
    models: [
      { id: "gpt-5.5", default: true },
      { id: "o3" },
    ],
  },
  {
    // claude-code-cli uses the Claude Code subscription's model; no model picker.
    key: "claude-code", label: "Claude Code CLI (需 Claude Pro/Team/Max 订阅)",
    runtime: "claude-code-cli", requiresAuth: "claude",
    models: [],
  },
  {
    // honest home for any not-yet-verified Anthropic-compatible API.
    key: "custom", label: "自定义 — 任何 Anthropic 兼容 API (DeepSeek/GLM/Kimi/OpenRouter/自建)",
    runtime: "claude-agent-sdk", envKey: "ANTHROPIC_AUTH_TOKEN",
    freeformBaseUrl: true,
    models: [],
  },
];

interface VendorSelection {
  vendorKey: string;
  runtime: RuntimeName;
  model?: string;
  baseUrl?: string;
  envKey?: VendorEnvKey;
  signupUrl?: string;
  requiresAuth?: "claude" | "codex";
}

// Resolve a vendor + model selection from a known vendor key (used by both the
// interactive helper below and the --preset / --runtime / --model flag path in
// B2). `modelOverride` lets a flag pin a specific model id without prompting.
function resolveVendorSelection(vendorKey: string, modelOverride?: string): VendorSelection | null {
  const vendor = VENDORS.find(v => v.key === vendorKey);
  if (!vendor) return null;
  const defaultModel = vendor.models.find(m => m.default)?.id || vendor.models[0]?.id;
  return {
    vendorKey: vendor.key,
    runtime: vendor.runtime,
    model: modelOverride || defaultModel,
    baseUrl: vendor.baseUrl,
    envKey: vendor.envKey,
    signupUrl: vendor.signupUrl,
    requiresAuth: vendor.requiresAuth,
  };
}

// Resolve a model id back to its vendor. Used by the --preset flag back-compat
// path (B2.3): the old --preset values were model ids (intern-s1-pro,
// MiniMax-M2.7, mimo-v2.5-pro, claude-sonnet-4-6, ...), not vendor keys.
function findVendorByModel(modelId: string): VendorSelection | null {
  for (const vendor of VENDORS) {
    if (vendor.models.some(m => m.id === modelId)) {
      return {
        vendorKey: vendor.key,
        runtime: vendor.runtime,
        model: modelId,
        baseUrl: vendor.baseUrl,
        envKey: vendor.envKey,
        signupUrl: vendor.signupUrl,
        requiresAuth: vendor.requiresAuth,
      };
    }
  }
  return null;
}

// Unified vendor-first interactive selection (issue #104-B): pick vendor →
// pick that vendor's model → runtime + baseUrl resolved from the registry.
// All three create flows migrate to this in B2. Returns null when the
// interactive picker is unavailable (non-TTY / inquirer load failure) so
// callers can fall back to their existing default-runtime behavior.
async function selectVendorAndModel(): Promise<VendorSelection | null> {
  let vendorKey: string;
  try {
    const { select: sel } = await import("@inquirer/prompts");
    vendorKey = await sel({
      message: "选择供应商 (vendor):",
      choices: VENDORS.map(v => ({ value: v.key, name: v.label })),
    });
  } catch (e: any) {
    console.log(`[anet] ⚠ Vendor selector unavailable: ${e?.message || e}`);
    return null;
  }
  const vendor = VENDORS.find(v => v.key === vendorKey);
  if (!vendor) return null;

  let baseUrl = vendor.baseUrl;
  if (vendor.freeformBaseUrl) {
    baseUrl = await ask("ANTHROPIC_BASE_URL (e.g. https://your-host/anthropic)") || "";
  }

  let model: string | undefined;
  if (vendor.models.length === 1) {
    model = vendor.models[0].id;
  } else if (vendor.models.length > 1) {
    // default-marked model sorted first so the picker preselects it.
    const ordered = [...vendor.models].sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0));
    model = await askChoice(`选择 ${vendor.label} 模型:`,
      ordered.map(m => ({ label: m.label || m.id, value: m.id })));
  } else if (!vendor.requiresAuth) {
    // freeform model (custom): ask the user for an exact model id.
    model = (await ask("Model id")) || undefined;
  }
  // vendor.models.length === 0 && requiresAuth (claude-code) → no model picker.

  return {
    vendorKey: vendor.key,
    runtime: vendor.runtime,
    model,
    baseUrl,
    envKey: vendor.envKey,
    signupUrl: vendor.signupUrl,
    requiresAuth: vendor.requiresAuth,
  };
}

function maskSecretEnv(env: Record<string, any>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const isSecret = /TOKEN|KEY|SECRET|PASSWORD/i.test(key);
    // #135 v3 — env values can be envRef objects since #125 (e.g.
    // `{_envRef:"FOO"}`); render those as the indirection target so users
    // can see what env var they need to set, and never call .slice() on
    // an object (which threw TypeError before this defensive type check).
    if (value && typeof value === "object" && typeof value._envRef === "string") {
      masked[key] = `→ $${value._envRef}`;
      continue;
    }
    if (typeof value !== "string") {
      masked[key] = String(value);
      continue;
    }
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
  - runtime: claude-code-cli / codex-sdk / claude-agent-sdk / grok-build-acp
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

  // #133 runtime-first wizard (Vincent 5101 实测 catch): pick runtime first;
  // only claude-agent-sdk goes through the vendor picker (it's the only
  // runtime that supports arbitrary OpenAI/Anthropic-compat vendors). Other
  // runtimes (claude-code-cli / codex-sdk) reuse their CLI's existing auth
  // and skip vendor selection entirely.
  const opts = parseOpts();
  let pickedRuntime: RuntimeName | null = null;
  try {
    const { select: sel } = await import("@inquirer/prompts");
    pickedRuntime = await sel({
      message: "选择 runtime:",
      choices: [
        { value: "claude-agent-sdk", name: "claude-agent-sdk — 任意 OpenAI/Anthropic-compat vendor (intern / MiniMax / Claude / GLM / ...)" },
        { value: "claude-code-cli",  name: "claude-code-cli  — Anthropic Claude (Max/Pro plan), 复用 `claude` CLI 登录态" },
        { value: "codex-sdk",        name: "codex-sdk        — OpenAI Codex, 复用 `codex auth login` 登录态" },
        { value: "grok-build-acp",   name: "grok-build-acp   — Grok Build ACP, 复用 `grok` CLI 登录态" },
      ],
    }) as any;
  } catch (e: any) {
    console.log(`[anet] ⚠ Runtime selector unavailable: ${e?.message || e} — defaulting to claude-agent-sdk`);
    pickedRuntime = "claude-agent-sdk";
  }

  if (pickedRuntime === "claude-code-cli") {
    opts.runtime = "claude-code-cli";
    console.log(`[anet] 请确保已安装 Claude Code CLI 并登录: claude auth login`);
  } else if (pickedRuntime === "codex-sdk") {
    opts.runtime = "codex-sdk";
    console.log(`[anet] 请确保已执行: codex auth login`);
  } else if (pickedRuntime === "grok-build-acp") {
    opts.runtime = "grok-build-acp";
    console.log(`[anet] 请确保已安装并登录 Grok Build CLI: grok auth login`);
  } else {
    // claude-agent-sdk — flow continues into vendor + model picker.
    const sel = await selectVendorAndModel();
    if (sel) {
      opts.runtime = sel.runtime;
      if (sel.model) opts.model = sel.model;
      if (sel.baseUrl) opts._envs.push(`ANTHROPIC_BASE_URL=${sel.baseUrl}`);
      if (sel.envKey) {
        console.log(`
API key:
  Paste the API key/token for the selected vendor.${sel.signupUrl ? `
  📋 注册 / 拿 API Key: ${sel.signupUrl}` : ""}`);
        // #138 fix — same inquirer-stdin issue as Telegram prompts; use
        // inquirer input() to keep stdin handling uniform with the select()
        // call inside selectVendorAndModel above.
        let token: string;
        try {
          const { input: inquirerInput } = await import("@inquirer/prompts");
          token = (await inquirerInput({ message: sel.envKey })).trim();
        } catch {
          token = await ask(sel.envKey);
        }
        if (token) opts._envs.push(`${sel.envKey}=${token}`);
      }
      if (sel.requiresAuth === "codex") {
        console.log(`[anet] 请确保已执行: codex auth login`);
      } else if (sel.requiresAuth === "claude") {
        console.log(`[anet] 请确保已安装 Claude Code CLI 并登录: claude auth login`);
      }
    } else {
      // Non-TTY / inquirer unavailable — fall back to the default runtime so the
      // node is still created; the API key can be added later via config.json.
      console.log(`[anet] ⚠ vendor selector unavailable — defaulting to claude-agent-sdk runtime (add API key to config.json env later)`);
      opts.runtime = "claude-agent-sdk";
    }
  }

  const profile = await ensureNodeToken(createProfileFromOpts(id, opts), id);

  // #138 fix — @inquirer/prompts select() cleanup leaves process.stdin in a
  // state where the subsequent readline `ask()` doesn't keep the event loop
  // alive — process exits cleanly with code 0 mid-prompt before the user
  // can answer (zsh shows `%` artifact). Switch to inquirer `input()` for
  // the post-select() prompts so stdin handling is uniform with select().
  let addTelegram: string;
  try {
    const { input: inquirerInput } = await import("@inquirer/prompts");
    addTelegram = (await inquirerInput({
      message: "Add Telegram channel? (y/n)",
      default: "n",
    })).trim() || "n";
  } catch {
    // Non-TTY / inquirer unavailable — fall back to legacy readline ask().
    addTelegram = await ask("Add Telegram channel? (y/n)", "n");
  }
  let telegramConfig: { botToken: string; allowId: string } | null = null;
  if (/^y(es)?$/i.test(addTelegram)) {
    console.log(`
Telegram setup:
  1. Open Telegram and talk to @BotFather.
  2. Create a bot and copy the bot token.
  3. Talk to @userinfobot to get your numeric user ID.
`);
    // #138 fix — same inquirer-stdin issue as Add Telegram prompt above.
    let botToken: string;
    let allowId: string;
    try {
      const { input: inquirerInput } = await import("@inquirer/prompts");
      botToken = (await inquirerInput({ message: "Telegram Bot Token" })).trim();
      allowId = (await inquirerInput({ message: "Allow User ID (numeric ID from @userinfobot)", default: "" })).trim();
    } catch {
      botToken = await ask("Telegram Bot Token");
      allowId = await ask("Allow User ID (numeric ID from @userinfobot)", "");
    }
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
  // #135 v2 fix — let the dispatch-end exit handle clean shutdown (see top
  // of switch block at end of file). The preview.1 inline `process.exit(0)`
  // here was counterproductive: process.exit inside an async function leaves
  // the outer `await createCommand()` chain unsettled in a different way,
  // which is what Node v24 ESM strict mode actually warns about.
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
    console.error("Usage: anet node create <node-name> [--runtime claude-code-cli|codex-sdk|claude-agent-sdk|grok-build-acp] [--model ...] [--tools ...]");
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

  // #133 runtime-first wizard (Vincent 5101 实测 catch): the old vendor-first
  // selector only enumerated claude-agent-sdk vendors, leaving users who want
  // claude-code-cli (Anthropic Max plan) or codex-sdk (OpenAI auth login)
  // implicitly stuck — they had to know to pass `--runtime codex-sdk` on the
  // CLI to skip the vendor picker. New flow: ask runtime first, then route:
  //   claude-agent-sdk → existing selectVendorAndModel() vendor picker
  //   claude-code-cli  → skip vendor entirely, print login hint
  //   codex-sdk        → skip vendor entirely, print login hint
  // Backward-compatible with explicit --runtime flag (skips the picker).
  const envFlagHasAuth = (opts._envs || []).some((e: string) =>
    e.startsWith("ANTHROPIC_AUTH_TOKEN=") || e.startsWith("ANTHROPIC_API_KEY=")
  );
  const credAlreadyProvided = !!process.env.ANTHROPIC_AUTH_TOKEN
    || !!process.env.ANTHROPIC_API_KEY || envFlagHasAuth;
  const explicitRuntime = opts.runtime ? normalizeRuntime(opts.runtime) : undefined;
  const runtimeAlreadyExplicit = explicitRuntime === "codex-sdk" || explicitRuntime === "claude-code-cli" || explicitRuntime === "grok-build-acp";
  const skipInteractive = credAlreadyProvided || runtimeAlreadyExplicit;

  // #133 selectRuntime — runtime-first, exported as a helper so create paths
  // (interactive single / batch wizard / sci-team demo) can share the picker.
  const selectRuntime = async (): Promise<RuntimeName | null> => {
    try {
      const { select: sel } = await import("@inquirer/prompts");
      const picked = await sel({
        message: "选择 runtime:",
        choices: [
          { value: "claude-agent-sdk", name: "claude-agent-sdk — 任意 OpenAI/Anthropic-compat vendor (intern / MiniMax / Claude / GLM / ...)" },
          { value: "claude-code-cli",  name: "claude-code-cli  — Anthropic Claude (Max/Pro plan), 复用 `claude` CLI 登录态" },
          { value: "codex-sdk",        name: "codex-sdk        — OpenAI Codex, 复用 `codex auth login` 登录态" },
          { value: "grok-build-acp",   name: "grok-build-acp   — Grok Build ACP, 复用 `grok` CLI 登录态" },
        ],
      });
      return picked as any;
    } catch (e: any) {
      console.log(`[anet] ⚠ Runtime selector unavailable: ${e?.message || e}`);
      return null;
    }
  };

  if (!skipInteractive && process.stdin.isTTY) {
    const runtime = await selectRuntime();
    if (runtime) opts.runtime = runtime;
  } else if (explicitRuntime) {
    opts.runtime = explicitRuntime;
  }

  // Per-runtime branching: vendor picker only for claude-agent-sdk; others skip.
  if (opts.runtime === "claude-code-cli") {
    console.log("[anet] 请确保已安装 Claude Code CLI 并登录: claude auth login");
  } else if (opts.runtime === "codex-sdk") {
    console.log("[anet] 请确保已执行: codex auth login");
  } else if (opts.runtime === "grok-build-acp") {
    console.log("[anet] 请确保已安装并登录 Grok Build CLI: grok auth login");
  } else {
    // Either claude-agent-sdk (explicit / picker-default) or undefined runtime
    // — fall through to vendor selection. credAlreadyProvided also skips since
    // demo paths pre-inject the env.
    if (!credAlreadyProvided && process.stdin.isTTY) {
      const sel = await selectVendorAndModel();
      if (sel) {
        opts.runtime = sel.runtime;
        if (sel.model) opts.model = sel.model;
        opts._envs = opts._envs || [];
        if (sel.baseUrl) opts._envs.push(`ANTHROPIC_BASE_URL=${sel.baseUrl}`);
        if (sel.envKey) {
          if (sel.signupUrl) console.log(`[anet] 没有 Key？去 ${sel.signupUrl} 注册并创建 API Key`);
          const key = await ask(`输入 API Key (${sel.vendorKey})`);
          if (key) opts._envs.push(`${sel.envKey}=${key}`);
        }
        if (sel.requiresAuth === "codex") {
          console.log("[anet] 请确保已执行: codex auth login");
        } else if (sel.requiresAuth === "claude") {
          console.log("[anet] 请确保已安装 Claude Code CLI 并登录: claude auth login");
        }
      } else {
        console.log(`[anet] ⚠ vendor selector unavailable — defaulting to claude-agent-sdk runtime`);
        opts.runtime = "claude-agent-sdk";
      }
    }
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

  // #115 — bind an existing Claude session at create time (claude-code-cli only).
  // --resume <id> / --resume-latest for non-TTY scripts; interactive picker
  // otherwise. The chosen id goes into opts.session, which createProfileFromOpts
  // already consumes (`session: opts.session || randomUUID()`) — no schema change.
  if (normalizeRuntime(opts.runtime || "claude-agent-sdk") === "claude-code-cli" && !opts.session) {
    const wantLatest = opts["resume-latest"] === "true";
    const wantId = opts.resume && opts.resume !== "true" ? opts.resume : "";
    if (wantId && wantLatest) {
      console.error("[anet] --resume <id> 和 --resume-latest 不能同时使用");
      process.exit(1);
    }
    if (wantId) {
      if (!sessionFileExists(wantId)) {
        console.error(`[anet] ❌ session "${wantId}" 不在当前目录的 Claude project 里`);
        console.error(`[anet]    查看可用 session: anet session ls`);
        process.exit(1);
      }
      opts.session = wantId;
      console.log(`[anet] 绑定已有 Claude session: ${wantId.slice(0, 8)}…`);
    } else if (wantLatest) {
      const latest = listClaudeSessions()[0];
      if (!latest) {
        console.error("[anet] ❌ 当前目录没有可 resume 的 Claude session");
        process.exit(1);
      }
      opts.session = latest.id;
      console.log(`[anet] 绑定最近的 Claude session: ${latest.id.slice(0, 8)}… (${formatAge(latest.mtimeMs)})`);
    } else if (process.stdin.isTTY) {
      const picked = await pickClaudeSession(id);
      if (picked) {
        opts.session = picked;
        console.log(`[anet] 绑定已有 Claude session: ${picked.slice(0, 8)}…`);
      }
    }
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
  // #101 user warning — surface the resolved toolset + dangerouslySkipPermissions
  // implication on every node create so users see what the agent can do before
  // they hand it real work. The earlier behavior printed only the flags warning
  // and left tools opaque.
  const toolsArr = Array.isArray(profile.tools) ? profile.tools : [];
  const toolsLabel = toolsArr.length
    ? `[${toolsArr.join(", ")}] (explicit allowlist)`
    : `all (Claude Code preset — WebFetch / WebSearch / Bash / Read / Write / Edit / Glob / Grep / Task / ...)`;
  console.log(`\n[anet] ⚠ Node created with default tool set:`);
  console.log(`[anet]    Built-in: ${toolsLabel}`);
  console.log(`[anet]    MCP:      commhub_send_task / send_message / send_reply / get_all_status / ...`);
  console.log(`[anet]    Flags:    dangerouslySkipPermissions=true (no per-call confirmation), teammateMode enabled`);
  console.log(`[anet]`);
  console.log(`[anet]    The agent can read/write files, run shell commands, and access the network.`);
  console.log(`[anet]    Make sure this is what you want for this agent's role.`);
  console.log(`[anet]`);
  console.log(`[anet]    Restrict tools:        edit .anet/nodes/${id}/config.json → "tools": ["Read","Bash",...]`);
  console.log(`[anet]    Disable auto-skip:     edit .anet/nodes/${id}/config.json → "flags.dangerouslySkipPermissions": false`);
  console.log(`[anet]    Inspect current set:   anet info ${id}`);
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

  // Fix 1 (#146 / RFC-018) — ensure node_id is persisted in the raw config.
  // resume_id is derived from node_id (agent-node: sdk-<node_id>; claude-code-
  // cli: COMMHUB_RESUME_ID=cc-<node_id>, set in the claude branch below).
  // normalizeStoredProfile fills a missing node_id in memory only — a legacy
  // raw config without it would let the value drift (legacyNodeId is keyed on
  // the dir name, which a rename changes). Persist the canonical id once.
  try {
    const rawCfgPath = join(nodesDir(), nodeId, "config.json");
    const rawCfg = JSON.parse(readFileSync(rawCfgPath, "utf-8"));
    if (!rawCfg.node_id && profile.node_id) {
      saveProfile(nodeId, profile);
      console.log(`[anet] persisted canonical node_id ${profile.node_id} (legacy config had none).`);
    }
  } catch {}

  if (runtime === "codex-sdk" || runtime === "claude-agent-sdk" || runtime === "grok-build-acp") {
    // spawn agent-node
    const agentArgs = [
      "--config", join(nodesDir(), nodeId, "config.json"),
      "--alias", displayName,
      "--runtime", runtime,
    ];
    if (forceNewSession) agentArgs.push("--new-session", "true");

    // #204 preview.5 — refresh `.anet/node-server.js` from the *currently
    // installed* agent-network bundle on every start. The grok-build-acp
    // runtime spawns this file as the commhub MCP server via ACP injection
    // (see agent-node `processWithGrok`), and a stale copy from an old
    // `anet init project` can write non-JSON-RPC bytes to stdout, surfacing
    // as Grok's `serde error expected value at line 1 column 2`. Cheap
    // (read+write a few KB) and only fires for these three runtimes.
    if (runtime === "grok-build-acp") {
      try {
        const anetDir = join(process.cwd(), ".anet");
        if (!existsSync(anetDir)) mkdirSync(anetDir, { recursive: true });
        const target = join(anetDir, "node-server.js");
        const status = refreshNodeServerJsAt(target, { overwrite: true });
        if (status === "wrote") {
          console.log(`[anet] refreshed .anet/node-server.js for grok-build-acp (#204)`);
        } else if (status === "no-source") {
          console.warn(`[anet] ⚠ #204 — could not locate a bundled node-server.js to refresh; ` +
            `commhub MCP for Grok may fail if the existing file is stale.`);
        }
      } catch (e: any) {
        console.warn(`[anet] ⚠ #204 — refresh node-server.js failed: ${e?.message || e}`);
      }
    }

    const hub = profile.hub || loadGlobal().hub || "";
    // #203 defense — explicitly set COMMHUB_ALIAS in the agent-node spawn env
    // (mirrors what the claude-code-cli branch below already does). Without
    // this, agent-node's child paths that fall back to process.env.COMMHUB_ALIAS
    // could inherit a stale value from the parent shell (e.g. left over from a
    // previous `anet node start <oldNode>` in the same terminal), causing
    // outbound send_task/send_message to attribute to the wrong alias.
    // `displayName` is the same value we pass as --alias above, so the two
    // sources agree.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      COMMHUB_ALIAS: displayName,
      ...(token ? { COMMHUB_TOKEN: token } : {}),
      ...(hub ? { COMMHUB_URL: hub } : {}),
    };
    // #125 fix (preview.3) — resolve envRef before spawn so the child gets a
    // plain string in env; the child's own envRef-resolver would otherwise
    // never run (parent crashes on `.replace()` of an object first).
    // #193 envRef Option A — also self-source the per-node .env (mode 600,
    // gitignored) so a wizard-create-then-start in a fresh shell works
    // without the user having to manually export the secret first. Priority
    // is process.env (explicit shell) > dotenv file (see resolveProfileEnv).
    const _dotenvSDK = loadNodeDotenv(nodeId);
    if (Object.keys(_dotenvSDK).length > 0) {
      console.log(`[anet] loaded ${Object.keys(_dotenvSDK).length} key(s) from .anet/nodes/${nodeId}/.env`);
    }
    Object.assign(env, resolveProfileEnv(profile.env as any, home, _dotenvSDK));

    // Try agent-node from PATH, fallback to npx
    let cmd = "agent-node";
    let commandArgs = agentArgs;
    try { execSync("which agent-node", { stdio: "pipe" }); } catch {
      cmd = "npx";
      commandArgs = ["-y", "@sleep2agi/agent-node@preview", ...agentArgs];
    }
    // #138 fix — same fa08eb4 (#135) regression as the claude-code-cli
    // branch below: parent must stay alive while child runs, otherwise
    // main() resolves, fa08eb4 wrap fires process.exit(0), and the agent-
    // node child is orphaned mid-spawn.
    await new Promise<void>((resolve) => {
      const child = spawn(cmd, commandArgs, { env, stdio: "inherit" });
      const pidFile = join(nodesDir(), nodeId, ".pid");
      if (child.pid) writeFileSync(pidFile, String(child.pid));
      child.on("exit", (code) => {
        try { rmSync(pidFile, { force: true }); } catch {}
        if (code && code !== 0) process.exit(code);
        resolve();
      });
      child.on("error", (err) => {
        try { rmSync(pidFile, { force: true }); } catch {}
        console.error(`[anet] ❌ spawn ${cmd} failed: ${err.message || err}`);
        resolve();
      });
    });
  } else {
    // spawn claude CLI
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      COMMHUB_ALIAS: profile.alias,
      // #115 — suppress Claude Code's "Resume from summary / full session"
      // interactive prompt so restarting a batch of nodes is zero-interaction.
      // The prompt is gated by a session-age threshold (default 70min); a very
      // high value disables it → resumes the full session as-is. Per-spawn,
      // no ~/.claude/settings.json pollution. Respects an explicit user override.
      CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: process.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES || "999999999",
      ...(token ? { COMMHUB_TOKEN: token } : {}),
    };
    // #125 fix (preview.3) — same envRef resolution as the agent-node spawn
    // path above, just for the claude-code-cli runtime branch.
    // #193 envRef Option A — also self-source the per-node .env.
    const _dotenvCC = loadNodeDotenv(nodeId);
    if (Object.keys(_dotenvCC).length > 0) {
      console.log(`[anet] loaded ${Object.keys(_dotenvCC).length} key(s) from .anet/nodes/${nodeId}/.env`);
    }
    Object.assign(env, resolveProfileEnv(profile.env as any, home, _dotenvCC));
    // Fix 1 (#146 / RFC-018) — pin the commhub MCP server's resume_id to a
    // stable per-node value (node-server.ts:75 otherwise falls through to
    // randomUUID() at every start, orphaning the old session row on any
    // restart). cc-<node_id> mirrors agent-node's sdk-<node_id>; the env is
    // inherited by the commhub MCP stdio child the same way COMMHUB_ALIAS is.
    // Set AFTER the envRef merge so a user config.env COMMHUB_RESUME_ID cannot
    // clobber the stable-identity invariant (#146 double-review nit N1).
    if (profile.node_id) env.COMMHUB_RESUME_ID = `cc-${profile.node_id}`;
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

    // #138 fix — fa08eb4 (#135) wrap calls `process.exit(0)` the moment
    // main() resolves. The previous fire-and-forget `child.on("exit")` lets
    // launchAgent return immediately, main() resolves, parent dies before
    // the spawned claude child can claim the TTY foreground process group.
    // On macOS the kernel is strict: orphaned child calling setRawMode on
    // the now-relinquished TTY → EIO (errno 5). On Linux the kernel is more
    // forgiving and the bug usually only manifests as a missing session
    // banner. Fix: await child exit so parent stays alive while child holds
    // the TTY; main() unwinds naturally only after claude actually exits.
    await new Promise<void>((resolve) => {
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
        // Use the child's exit code as the parent's exit code via the
        // fa08eb4 wrap's natural process.exit(0) path. For non-zero exits,
        // surface explicitly so callers see the failure code.
        if (code && code !== 0) process.exit(code);
        resolve();
      });
      child.on("error", (err) => {
        try { rmSync(pidFile, { force: true }); } catch {}
        console.error(`[anet] ❌ spawn claude failed: ${err.message || err}`);
        resolve();
      });
    });
  }
}

// ── start (new session) ──

async function startCommand() {
  // #173 — `anet node start --all` starts every node under cwd's .anet/nodes/
  // (skip already-running, staggered, auto-resume). It delegates to the
  // `anet project up` implementation (projectUp) so the two stay in lockstep
  // and share the --stagger / --only / --exclude flags + spawn model — no new
  // detached-tmux TTY surface beyond project up's existing #311 follow-up.
  if (args.includes("--all")) {
    const stray = positionalArgs(args.slice(1));  // args[0] is the "start" subcommand token
    if (stray.length > 0) {
      console.error(`[anet] ❌ \`anet node start --all\` starts every node and takes no <alias> (got "${stray[0]}").`);
      console.error(`[anet]    Use either:  anet node start --all          (every node in cwd)`);
      console.error(`[anet]            or:  anet node start ${shellQuote(stray[0])}   (just that one node)`);
      process.exit(1);
    }
    await projectUp("anet node start --all");
    return;
  }

  const id = args[1];
  if (!id) { showProfiles("start"); return; }
  const opts = parseOpts();
  const forceNewSession = !!opts["new-session"];

  // #136 (Vincent telegram 5158/5159/5161) — revert #122 default auto-wrap.
  // The detached-tmux-by-default path triggered `setRawMode errno 5` on
  // macOS bun (bun's claude-code-cli wants to call setRawMode on a real PTY
  // and the detached tmux child's stdio doesn't satisfy that). Default is
  // now plain foreground; users who want a tmux session opt in with
  // `--tmux`. The `--tmux` path uses `tmux new -As <alias>` ATTACHED
  // (foreground enter, not -d / not detached) — attached mode keeps the
  // PTY chain intact so setRawMode works on every platform. Users can
  // detach with `Ctrl-B D` per normal tmux behavior.
  const wantTmux = opts.tmux === "true";

  if (!wantTmux) {
    // Default: spawn the agent runtime in this terminal.
    await launchAgent(id, forceNewSession);
    return;
  }

  // --tmux path: resolve alias for the tmux session name + inner cmd.
  const resolved = resolveNodeRef(id);
  if (!resolved) {
    console.error(`Node "${id}" not found. Create it first: anet node create ${id}`);
    process.exit(1);
  }
  const alias = nodeDisplayName(resolved.id, resolved.profile);

  if (!tmuxAvailable()) {
    console.error(`[anet] ❌ --tmux requested but tmux is not installed.`);
    console.error(`[anet]    Install tmux (e.g. \`brew install tmux\` / \`apt-get install tmux\`) and retry,`);
    console.error(`[anet]    or run \`anet node start ${shellQuote(alias)}\` (without --tmux) to start in this terminal.`);
    process.exit(1);
  }

  // `tmux new -As <alias>`:
  //   -A  attach if the session already exists (handles the rerun case)
  //   -s  session name (= alias for discoverability)
  //   -c  start in cwd
  //   <cmd> the agent runtime, foreground (no flag — default is foreground)
  // stdio: 'inherit' makes the parent terminal a tmux client; setRawMode
  // sees a real PTY through the tmux client/server pair.
  const inner = forceNewSession
    ? `anet node start ${shellQuote(alias)} --new-session`
    : `anet node start ${shellQuote(alias)}`;
  const tmuxArgs = ["new", "-As", alias, "-c", process.cwd(), inner];
  try {
    const child = spawn("tmux", tmuxArgs, { stdio: "inherit" });
    child.on("exit", code => process.exit(code || 0));
  } catch (e: any) {
    console.error(`[anet] ❌ tmux launch failed: ${e.message || e}`);
    console.error(`[anet]    Fall back to: anet node start ${shellQuote(alias)}`);
    process.exit(1);
  }
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
  // #101 user warning — verbose mode (`anet ls -v` / `--verbose`) prints a
  // second line per node with the resolved toolset + flag set so users can
  // see at a glance what each agent in the network is empowered to do.
  const verbose = args.includes("-v") || args.includes("--verbose");

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
      if (verbose && p) {
        // #101 verbose — second line shows tools + flags. Width-matched to the
        // header so it lines up under NAME.
        const toolsArr = Array.isArray(p.tools) ? p.tools : [];
        const toolsLabel = toolsArr.length ? `[${toolsArr.join(",")}]` : "all (preset)";
        const flags = (p as any).flags || {};
        const flagLabel = flags.dangerouslySkipPermissions === false ? "permGate=on" : "permGate=off";
        console.log(`  ${" ".repeat(20)} tools=${toolsLabel}  ${flagLabel}`);
      }
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

// #199/#200 — find PIDs listening on a given TCP port (lsof-based). Used by
// `anet hub stop` / `anet hub status` to identify the running commhub-server
// process when the user doesn't have it in the foreground.
function findHubPids(port: string | number): number[] {
  try {
    const out = execFileSync("lsof", ["-t", "-i", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" }).toString().trim();
    if (!out) return [];
    return out.split(/\s+/).map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n));
  } catch { return []; }
}

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
      // Pin to a specific version (module-level constant) — see PINNED_SERVER_VERSION.
      const serverArgs = ["--bun", `@sleep2agi/commhub-server@${PINNED_SERVER_VERSION}`];
      if (devOpen) serverArgs.push("--dev-open");
      child = spawn("bunx", serverArgs, { env, stdio: "inherit" });

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

  } else if (sub === "stop") {
    // #200 — graceful stop: lsof -ti:<port> → SIGTERM each → 3s grace → SIGKILL leftovers.
    const opts = parseOpts();
    const sc = loadServerConfig();
    const port = String(opts.port || sc.port || "9200");
    const pids = findHubPids(port);
    if (pids.length === 0) {
      console.log(`[anet] No hub server listening on port ${port}.`);
      return;
    }
    console.log(`[anet] stopping hub (pid ${pids.join(", ")} on port ${port})...`);
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch (e: any) {
        console.warn(`[anet] ⚠ SIGTERM ${pid} failed: ${e?.message || e}`);
      }
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
      if (findHubPids(port).length === 0) {
        console.log(`[anet] ✅ Stopped.`);
        return;
      }
    }
    const leftover = findHubPids(port);
    for (const pid of leftover) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    await new Promise(r => setTimeout(r, 500));
    const remaining = findHubPids(port);
    if (remaining.length === 0) console.log(`[anet] ✅ Stopped (after SIGKILL).`);
    else console.error(`[anet] ⚠ Hub pid(s) ${remaining.join(", ")} still on port ${port}; check manually.`);

  } else if (sub === "status") {
    // #200 — show hub running state: pid(s) on the port + /health version.
    const opts = parseOpts();
    const sc = loadServerConfig();
    const port = String(opts.port || sc.port || "9200");
    const pids = findHubPids(port);
    if (pids.length === 0) {
      console.log(`[anet] Hub not running on port ${port}.`);
      console.log(`[anet]    Start: anet hub start`);
      return;
    }
    let healthy = false;
    let version = "?";
    try {
      const h = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json() as any);
      if (h.ok) { healthy = true; version = h.version || "?"; }
    } catch {}
    console.log(`[anet] hub: ${healthy ? "✅ running" : "⚠ port held but /health not OK"} on http://127.0.0.1:${port}`);
    console.log(`[anet]   pid(s):         ${pids.join(", ")}`);
    console.log(`[anet]   server version: ${version}`);

  } else {
    console.log(`
anet hub <command>

  start [options]    Start CommHub Server (bootstraps admin account; login separately)
  stop  [--port <p>] Stop the running CommHub Server (SIGTERM → 3s grace → SIGKILL)
  status [--port <p>] Show hub PID + port + /health version
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
    // Scan ~/.claude/projects/{project-key}/ for .jsonl files (#115: shared
    // helper with the `anet node create` resume picker).
    const cwd = process.cwd();
    const sessions = listClaudeSessions(cwd);

    if (sessions.length === 0) { console.log(`No sessions for ${cwd}`); return; }

    console.log(`\nSessions in ${cwd} (${sessions.length} total):\n`);
    console.log("  SESSION ID                             SIZE      MODIFIED");
    console.log("  ──────────────────────────────────────  ────────  ────────────────");

    for (const s of sessions) {
      const mtime = new Date(s.mtimeMs).toISOString().replace("T", " ").slice(0, 16);
      console.log(`  ${s.id}  ${formatSize(s.sizeBytes).padStart(8)}  ${mtime}`);
    }
    console.log();
  } else {
    console.log(`
anet session <command>

  ls    List Claude Code sessions in current project
`);
  }
}

// #146 R1 — read a node's recorded PID without mutating the pidfile. Pure
// read: renameCommand captures the OLD pid up-front so process-exit can be
// confirmed even though the pidfile is later removed with the old config dir.
function readNodePid(nodeId: string): number | null {
  try {
    const pidFile = join(nodesDir(), nodeId, ".pid");
    if (!existsSync(pidFile)) return null;
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch { return null; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return !pidAlive(pid);
}

// #146 R1 — terminate a node process and CONFIRM it exited. SIGTERM →
// bounded wait → (force only) SIGKILL → bounded wait. Returns true only when
// the process is verified dead. A surviving old process keeps heart-beating
// and commhub's ON CONFLICT(resume_id) upsert reverts the rename (SDK马
// Finding B), so renameCommand must NOT start the new alias if this is false.
async function terminateNodeProcess(pid: number, force: boolean): Promise<boolean> {
  if (!pidAlive(pid)) return true;
  try { process.kill(pid, "SIGTERM"); } catch {}
  if (await waitForPidExit(pid, 8000)) return true;
  if (force) {
    try { process.kill(pid, "SIGKILL"); } catch {}
    if (await waitForPidExit(pid, 3000)) return true;
  }
  return !pidAlive(pid);
}

// #146 / #180 — find a node's live agent process(es) by command line, NOT by a
// possibly-stale .pid. A stale .pid can point to a dead pid the OS later reused
// for an unrelated process — trusting it makes renameCommand SIGKILL an
// innocent process AND miss the real node (it stays a ghost). launchAgent
// always puts the node alias on the agent's argv (`claude -n <alias>` /
// `agent-node --alias <alias>`).
// Returns the matching pids, or `null` if the process table cannot be read —
// callers MUST fail closed on `null` (#180 R2), never treat it as "no match".
// #180 R3 caveat: alias tokenisation assumes node names conforming to
// validateNodeName() (no whitespace/quotes) — the entire current node
// population. A hand-edited legacy alias containing whitespace would not match.
function findNodeProcessesByAlias(...aliases: string[]): number[] | null {
  const wanted = new Set(aliases.filter(Boolean));
  if (wanted.size === 0) return [];
  let out = "";
  try {
    out = execFileSync("ps", ["-eww", "-o", "pid=", "-o", "args="], { encoding: "utf-8" }).toString();
  } catch { return null; }  // #180 R2 — process table unavailable; caller fails closed
  const pids = new Set<number>();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (isNaN(pid) || pid === process.pid) continue;
    const tok = m[2].split(/\s+/);
    // #180 R1 — genuine agent-process identity: an argv token must be the agent
    // executable itself (basename claude / agent-node) or its package path —
    // NOT a mere substring of the whole command line, which an unrelated
    // process could carry in a path/arg and then be wrongly killed.
    const isAgentProc = tok.some(x => {
      const base = x.split("/").pop() || x;
      return base === "claude" || base === "agent-node"
        || x.includes("@anthropic-ai/claude-code") || x.includes("@sleep2agi/agent-node");
    });
    if (!isAgentProc) continue;
    for (let i = 0; i < tok.length - 1; i++) {
      if ((tok[i] === "-n" || tok[i] === "--alias") && wanted.has(tok[i + 1])) { pids.add(pid); break; }
    }
  }
  return [...pids];
}

// #146 GOTCHA-2 — best-effort drain before a rename restart kills the agent.
// Polls commhub /api/status: returns true once the node is NOT actively
// running a task (idle / blocked / error / offline / fell off status), false
// on timeout (still working). Killing a working node drops the in-flight
// task with no reply (#168 silent-lost family) — `--force` is the user's
// acceptance that a stuck/long task may still be interrupted past this wait.
async function waitForNodeIdle(hub: string, token: string, networkId: string, alias: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let sawNode = false;
  const url = `${hub}/api/status?network_id=${encodeURIComponent(networkId)}`;  // #146 R6
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: authHeaders(token) }).then(r => r.json() as any);
      const node = (res.sessions || []).find((s: any) => s.alias === alias || s.node_name === alias);
      if (node) {
        sawNode = true;
        const st = String(node.status || "").toLowerCase();
        if (st !== "working" && st !== "busy" && st !== "running") return true;
      } else if (sawNode) {
        return true;  // node dropped off the status list — already down, safe to proceed
      }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

// #146 R2 — verify the restarted agent is genuinely live under the new alias.
// commitRename renames the hub row in place (keeps the old status/updated_at),
// so a plain "alias=new && status!=offline" check is a false positive — true
// even if the new process never started. Authoritative signal: the new node's
// `.pid` is present AND alive — only a real restarted process writes that
// pidfile; the hub row rename cannot fake a local pid. A fresh hub heartbeat
// (last_seen/updated_at past restartStartedAt) corroborates but only annotates.
async function verifyNodeRestarted(
  hub: string, token: string, networkId: string, newName: string,
  restartStartedAt: number, timeoutMs: number,
): Promise<{ ok: boolean; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  const url = `${hub}/api/status?network_id=${encodeURIComponent(networkId)}`;  // #146 R6
  while (Date.now() < deadline) {
    const pid = readNodePid(newName);
    if (pid !== null && pidAlive(pid)) {
      let fresh = false;
      try {
        const res = await fetch(url, { headers: authHeaders(token) }).then(r => r.json() as any);
        const node = (res.sessions || []).find((s: any) => s.alias === newName || s.node_name === newName);
        if (node) {
          const ts = Date.parse(node.last_seen_at || node.updated_at || "") || 0;
          fresh = ts >= restartStartedAt;
        }
      } catch {}
      return { ok: true, reason: fresh ? "new process pid alive + fresh hub heartbeat" : "new process pid alive (hub heartbeat still catching up)" };
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  return { ok: false, reason: `no live new-process pid within ${Math.round(timeoutMs / 1000)}s` };
}

// anet node rename — RFC-010 §4 multi-surface 2PC (issue #84 Phase 2).
// PHASE 1 (prepare) is fully rollback-safe: copy-not-move + rename.lock +
// commhub prepared rename_txn row, old node untouched. PHASE 2 (commit) is the
// non-rollbackable point: commhub routing switch → restart agent → delete old.
async function renameCommand() {
  const fromRef = args[1];
  const newName = args[2];
  const force = args.includes("--force");
  if (!fromRef || !newName) {
    console.log(`
anet node rename <node-id|node-name> <new-node-name> [--force]
  --force  required to rename a running node. A running node is restarted
           under the new alias (#146): the agent process is stopped (its
           exit is verified) and relaunched so it re-registers with commhub
           under the new name.
           - A best-effort 60s drain waits for any in-flight task to finish
             first; past that, --force means a long/stuck task may still be
             interrupted without a reply (the dispatcher's task stays open).
           - Auto-restart needs tmux. Without tmux the rename still commits,
             but the node is left stopped — start it with: anet node start.
`);
    return;
  }

  // ── 4.1 前置校验 ──
  validateNodeName(newName);
  const resolved = resolveNodeRef(fromRef);
  if (!resolved) {
    console.error(`Node "${fromRef}" not found.`);
    process.exit(1);
  }
  const oldId = resolved.id;
  if (oldId === newName) {
    console.error(`New name "${newName}" is the same as the current name.`);
    process.exit(1);
  }
  if (resolveNodeRef(newName)) {
    console.error(`Node name "${newName}" already exists locally.`);
    process.exit(1);
  }
  const oldDir = join(nodesDir(), oldId);
  const newDir = join(nodesDir(), newName);
  if (existsSync(newDir)) {
    console.error(`Target directory already exists: .anet/nodes/${newName}`);
    process.exit(1);
  }
  const lockPath = join(oldDir, "rename.lock");
  if (existsSync(lockPath)) {
    console.error(`Node "${oldId}" has an in-flight rename (.anet/nodes/${oldId}/rename.lock). Resolve it first.`);
    process.exit(1);
  }
  // state check: running node needs --force (RFC-010 §4.4 active rename).
  // #146 / #180 ship-blocker — DO NOT trust .pid for old-process identity. A
  // stale .pid (left by an agent that exited abnormally, its exit handler never
  // running) can point to a dead pid the OS later reused for an unrelated
  // process; renameCommand would then SIGKILL that innocent process and leave
  // the real node a ghost heart-beating under the old alias (Vincent UAT,
  // N站马). Authoritative detection: scan the live process table by command
  // line — launchAgent always puts the alias there.
  const oldDisplay = nodeDisplayName(oldId, resolved.profile);
  let oldSurvivors: number[] = [];  // #180 — set in C2: old agent pids that refused to die
  // #180 R2 — fail closed if the process table is unreadable: a rename that
  // cannot find/stop the old agent could ghost it or stop the wrong process.
  const oldProcs = findNodeProcessesByAlias(oldDisplay, oldId);
  if (oldProcs === null) {
    console.error(`[anet] ❌ cannot inspect the process table (\`ps\` failed) — refusing the rename.`);
    console.error(`[anet]    Rename must locate + stop the old agent; without \`ps\` it risks a ghost or stopping the wrong process.`);
    process.exit(1);
  }
  const running = oldProcs.length > 0;
  if (running && !force) {
    console.error(`Node "${oldId}" is running. Use --force to rename a running node (active rename, RFC-010 §4.4).`);
    process.exit(1);
  }
  // #146 R4 — a running node must be restarted under the new alias, which
  // needs tmux. If tmux is unavailable the rename still proceeds, but the node
  // ends up stopped and the user must restart it by hand — surface that
  // up-front so the success message later does not imply auto-recovery.
  const canAutoRestart = tmuxAvailable();
  if (running && !canAutoRestart) {
    console.warn(`[anet] ⚠ tmux not found — the renamed node cannot be auto-restarted.`);
    console.warn(`[anet]   The rename will still proceed; afterwards start it manually: anet node start ${shellQuote(newName)}`);
  }

  const gc = loadGlobal();
  const hub = resolved.profile.hub || gc.hub;
  const token = resolved.profile.token || gc.token;
  const networkId = resolved.profile.network_id || gc.network_id;
  if (!hub || !token || !networkId) {
    console.error(`[anet] rename needs hub + token + network_id — run 'anet login' first.`);
    process.exit(1);
  }
  const stored = loadStoredProfile(oldId) || resolved.profile;
  // #146 R3 — node_id must stay stable across the rename. loadStoredProfile →
  // normalizeStoredProfile already fills a missing node_id in memory with the
  // deterministic legacyNodeId(oldId), so `stored.node_id` is populated — but
  // the raw oldDir/config.json on disk may still lack the field. PHASE 1
  // cpSync copies that *raw* config; if node_id is absent there, the post-copy
  // loadStoredProfile(newName) re-derives legacyNodeId(newName) — a DIFFERENT
  // id — and resume_id (sdk-<node_id>) drifts across the rename (SDK马 Finding
  // B — breaks the session-row upsert + continuity). So persist the canonical
  // node_id back into the raw old config NOW, before cpSync, so the new dir
  // inherits the same id. (通信牛 R3 review — Minimal Patch A.)
  if (!stored.node_id) stored.node_id = generateNodeId();  // theoretical fallback — normalize always fills it
  saveProfile(oldId, stored);  // unconditional: bakes the canonical node_id into the raw config cpSync will copy
  console.log(`[anet] persisted canonical node_id ${stored.node_id} before rename.`);

  // ── PHASE 1: PREPARE (copy/prepare, old node untouched — fully rollbackable) ──
  writeFileSync(lockPath, JSON.stringify({ old: oldId, new: newName, phase: "prepare", ts: Date.now() }) + "\n");
  let txnId = "";
  try {
    // P2: copy (not move) old → new + update config.alias
    cpSync(oldDir, newDir, { recursive: true });
    const newLock = join(newDir, "rename.lock");
    if (existsSync(newLock)) rmSync(newLock, { force: true });  // lock belongs to oldDir only
    // #146 — cpSync also copies the old node's `.pid`; that PID belongs to the
    // OLD process and must not leak into the new dir (would mislead stopNode /
    // `running` detection for the new node). The new process writes its own
    // .pid on spawn.
    const newPid = join(newDir, ".pid");
    if (existsSync(newPid)) rmSync(newPid, { force: true });
    const newProfile = loadStoredProfile(newName) || { ...stored };
    newProfile.node_name = newName;
    newProfile.alias = newName;
    saveProfile(newName, newProfile);
    // P3: commhub prepare-rename
    const prep = await fetch(`${hub}/api/node-rename/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ network_id: networkId, old_alias: oldId, new_alias: newName }),
    }).then(r => r.json() as any);
    if (!prep.ok) throw new Error(`commhub prepare-rename: ${prep.error}`);
    txnId = prep.txn_id;
  } catch (e: any) {
    // ── PHASE 1 失败回滚: old 原封不动 ──
    console.error(`[anet] rename PHASE 1 failed: ${e.message} — rolling back`);
    if (existsSync(newDir)) rmSync(newDir, { recursive: true, force: true });
    if (txnId) {
      await fetch(`${hub}/api/node-rename/abort`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ txn_id: txnId }),
      }).catch(() => {});
    }
    if (existsSync(lockPath)) rmSync(lockPath, { force: true });
    console.error(`[anet] rollback complete — "${oldId}" unchanged.`);
    process.exit(1);
  }

  // ── PHASE 2: COMMIT (顺序敏感: commhub 路由 → tmux → 删 old) ──
  // C1: commhub commit-rename — C1 之前仍可回滚, C1 之后转 forward-fix
  const commit = await fetch(`${hub}/api/node-rename/commit`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ txn_id: txnId }),
  }).then(r => r.json() as any).catch((e: any) => ({ ok: false, error: String(e?.message || e) }));
  if (!commit.ok) {
    // C1 失败: commhub 路由未切, 仍可干净回滚
    console.error(`[anet] rename PHASE 2 C1 (commhub commit) failed: ${commit.error} — rolling back`);
    if (existsSync(newDir)) rmSync(newDir, { recursive: true, force: true });
    await fetch(`${hub}/api/node-rename/abort`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ txn_id: txnId }),
    }).catch(() => {});
    if (existsSync(lockPath)) rmSync(lockPath, { force: true });
    console.error(`[anet] rollback complete — "${oldId}" unchanged.`);
    process.exit(1);
  }

  // C2 (#146 Option B — RESTART, not tmux-rename): a running agent-node has
  // its alias frozen in a `const` at startup (agent-node/src/cli.ts:112, no
  // live-reload — confirmed by SDK马 agent-node-side audit). After the
  // commhub routing switch the old process keeps polling get_inbox, keeps
  // its SSE at /events/<old>, and keeps report_status under the OLD alias —
  // node goes orphan (invisible under the new name, no message delivery),
  // and its 3-min report_status can even revert the rename (SDK马 Finding
  // B). The earlier `tmux rename-session` only relabelled the window — it
  // left the stale-alias process alive, which IS the #146 bug.
  //
  // Fix: stop the old process (graceful SIGTERM → its shutdown handler
  // reports offline under the old alias, clearing the stale session) then
  // relaunch under the new alias. The new process re-reads newDir/config.json
  // — the `session` field was preserved by the PHASE 1 cpSync, so the
  // Claude / agent session resumes (no context loss). RFC-013 hot-reload
  // (zero-gap alias swap) stays the v0.12.0 path; for a P0 it is too heavy.
  let oldProcessConfirmedDead = !running;  // not running → nothing to kill, trivially "dead"
  if (running) {
    console.log(`[anet] node was running — restarting under new alias "${newName}" (#146 Option B)...`);

    // GOTCHA-2 (#146, #168 family) — best-effort drain. Killing a node
    // mid-task drops that task with no reply; wait (bounded 60s) for it to
    // go idle first. --force already signals the user accepts that a
    // stuck/long task may still be interrupted past this wait.
    const drained = await waitForNodeIdle(hub, token, networkId, oldId, 60000);
    if (!drained) {
      console.warn(`[anet] ⚠ "${oldId}" still running a task after 60s — proceeding with restart (--force).`);
      console.warn(`[anet]   An in-flight task may be interrupted without a reply (dispatcher's task stays open).`);
    }

    // #146 R1 / #180 — terminate every live agent process of the old node and
    // CONFIRM exit. A surviving old process keeps polling get_inbox + heart-
    // beating report_status under the OLD alias; commhub's ON CONFLICT(resume_id)
    // upsert then reverts the rename (SDK马 Finding B). Re-scan by command line
    // at kill time (reuse-proof — never trusts a stale .pid, never SIGKILLs an
    // unrelated recycled pid). Each: SIGTERM → 8s wait → SIGKILL (--force) → 3s.
    // #180 R2 — re-scan; if `ps` now fails fall back to the detection-time set
    // (never silently treat the old node as already stopped).
    const livePids = findNodeProcessesByAlias(oldDisplay, oldId) ?? oldProcs;
    for (const pid of livePids) {
      if (!(await terminateNodeProcess(pid, force))) {
        oldSurvivors.push(pid);
        console.error(`[anet] ✗ old agent process (pid ${pid}) did not exit after SIGTERM + SIGKILL.`);
      }
    }
    oldProcessConfirmedDead = oldSurvivors.length === 0;
    if (oldProcessConfirmedDead && livePids.length > 0) {
      console.log(`[anet] stopped old agent process(es): ${livePids.join(", ")}`);
    }
    if (tmuxSessionRunning(oldId)) killTmuxSession(oldId);
    // brief grace so the old SSE/heartbeat + final writebackSession() tear down
    await new Promise(r => setTimeout(r, 1500));

    // GOTCHA-1 (#146) — session resume staleness. newDir/config.json is the
    // PHASE-1 cpSync snapshot. If the old process ran a task between PHASE 1
    // and the kill, agent-node's writebackSession() updated the *old*
    // config's `session` UUID — not the copy. Now that the old process is
    // fully dead (no more writeback), re-sync the latest session from the
    // old config into the new one so the restart resumes the current
    // session (no context loss). oldDir still exists — C3 deletes it next.
    try {
      const oldCfgPath = join(oldDir, "config.json");
      const newCfgPath = join(newDir, "config.json");
      if (existsSync(oldCfgPath) && existsSync(newCfgPath)) {
        const oldCfg = JSON.parse(readFileSync(oldCfgPath, "utf-8"));
        const newCfg = JSON.parse(readFileSync(newCfgPath, "utf-8"));
        if (oldCfg.session && oldCfg.session !== newCfg.session) {
          newCfg.session = oldCfg.session;
          writeFileSync(newCfgPath, JSON.stringify(newCfg, null, 2) + "\n");
          console.log(`[anet] re-synced session ${String(oldCfg.session).slice(0, 8)}… from old config (post-task writeback) — context preserved.`);
        }
      }
    } catch (e: any) {
      console.warn(`[anet] ⚠ session re-sync skipped: ${e?.message || e} — restart may resume an earlier session.`);
    }
  }

  // C3: 原子切换本地 — 删 old 目录 (含其中 rename.lock)。在 restart 前删, 这样
  // 重启进程不会看到 stale old dir。
  try {
    rmSync(oldDir, { recursive: true, force: true });
  } catch (e: any) {
    console.warn(`[anet] ⚠ failed to remove old config dir .anet/nodes/${oldId}: ${e?.message || e} — rename is committed; clean up the stale dir manually.`);
  }
  writeLegacyProjectAlias(newName);

  // C4 (#146 R2): relaunch the renamed node + verify a *real new process*
  // came up. The restart only fires when the old process is confirmed dead
  // (R1 — else two processes would fight over the same resume_id) and tmux is
  // available (R4). verifyNodeRestarted keys on the new node's live .pid, not
  // on the hub row alone — commitRename renames that row in place, so an
  // alias-match check would pass even if the new process never started.
  let restartFired = false;
  let restartOutcome: { ok: boolean; reason: string } | null = null;
  if (running && oldProcessConfirmedDead && canAutoRestart) {
    const restartStartedAt = Date.now();
    try {
      startNodeTmuxSession(newName, newName);  // detached tmux: `anet node start <newName>`
      restartFired = true;
      // #176 / RFC-018 ③ — a claude-code-cli node restart hits Claude Code's
      // dev-channels confirmation prompt; auto-confirm it concurrently with
      // the liveness check so the rename stays zero-interaction.
      const [outcome] = await Promise.all([
        verifyNodeRestarted(hub, token, networkId, newName, restartStartedAt, 30000),
        autoConfirmDevChannels([{ id: newName, alias: newName, profile: stored }]),
      ]);
      restartOutcome = outcome;
    } catch (e: any) {
      console.warn(`[anet] ⚠ rename committed but auto-restart failed: ${e?.message || e}`);
    }
  }

  // #146 / RFC-018 Fix 4 — runtime-accurate identity note. For claude-code-cli
  // the commhub session row never carries node_id; its identity is the
  // resume_id (cc-<node_id>, pinned by Fix 1). The old unconditional
  // "node_id unchanged" line misled for that runtime (commhub shows
  // node_id=null), so branch the message on runtime.
  if (normalizeRuntime(stored) === "claude-code-cli") {
    console.log(`[anet] node_id ${stored.node_id} unchanged in local config; this runtime's commhub identity is resume_id cc-${stored.node_id} — also stable across the rename. ntok_ token still valid.`);
  } else {
    console.log(`[anet] node_id: ${stored.node_id} — unchanged (only the alias changed; ntok_ token still valid).`);
  }
  if (!running) {
    console.log(`[anet] ✅ Renamed "${oldId}" → "${newName}" (txn ${txnId}). Node was not running — next \`anet node start ${shellQuote(newName)}\` registers under the new alias.`);
  } else if (!oldProcessConfirmedDead) {
    // R1 — old process survived SIGTERM+SIGKILL. Starting the new alias now
    // would let two processes heart-beat the same resume_id and revert the
    // rename (Finding B). Stop here and hand the user a manual recovery path.
    console.error(`[anet] ⚠ Renamed "${oldId}" → "${newName}" (txn ${txnId}) — but old agent process(es) ${oldSurvivors.join(", ")} are still alive.`);
    console.error(`[anet]   Do NOT leave them running: the heartbeat can revert the rename. Recover manually:`);
    console.error(`[anet]     1) kill -9 ${oldSurvivors.join(" ")}`);
    console.error(`[anet]     2) anet node start ${shellQuote(newName)}`);
    process.exit(1);
  } else if (!canAutoRestart) {
    console.log(`[anet] ✅ Renamed "${oldId}" → "${newName}" (txn ${txnId}) — old process stopped. tmux unavailable: start the node manually: anet node start ${shellQuote(newName)}`);
  } else if (restartFired && restartOutcome?.ok) {
    console.log(`[anet] ✅ Renamed "${oldId}" → "${newName}" (txn ${txnId}) — agent restarted + verified live under the new alias (${restartOutcome.reason}).`);
  } else if (restartFired) {
    console.warn(`[anet] ⚠ Renamed "${oldId}" → "${newName}" (txn ${txnId}) — restart fired but a live new process could not be verified (${restartOutcome?.reason ?? "unknown"}).`);
    console.warn(`[anet]   Check: anet logs ${shellQuote(newName)}  |  anet status   — or restart: anet node start ${shellQuote(newName)}`);
  } else {
    console.warn(`[anet] ⚠ Renamed "${oldId}" → "${newName}" (txn ${txnId}) — old process stopped but auto-restart did not fire. Start manually: anet node start ${shellQuote(newName)}`);
  }
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
  // #122 — auto-tmux on start needs symmetric cleanup on stop. Kill the
  // tmux session first (idempotent — has-session check guards), then SIGTERM
  // the recorded PID and notify the hub. Order matters: killing tmux kills
  // any child processes too, which makes `stopNode` mostly a defensive op
  // when the PID file is stale.
  const tmuxKilled = tmuxSessionRunning(displayName);
  if (tmuxKilled) killTmuxSession(displayName);
  const killed = stopNode(resolved.id);
  // Always notify server — even if PID file missing, server may have stale session
  await notifyServerOffline(resolved.profile, resolved.id);
  if (killed || tmuxKilled) {
    const what = [tmuxKilled ? "tmux" : null, killed ? "process" : null].filter(Boolean).join(" + ");
    console.log(`[anet] Stopped "${displayName}" (${what} killed, server notified)`);
  } else {
    console.log(`[anet] "${displayName}" is not running locally (server notified offline)`);
  }
}

// ── project (#117) — cwd-wide node orchestration ─────────────────────
//
// Thin wrapper over `anet node start/stop` for every entry under
// .anet/nodes/. Each spawned node inherits #115's zero-interaction restart
// (CLAUDE_CODE_RESUME_THRESHOLD_MINUTES env injection inside launchAgent),
// so `anet project up` on 22 nodes is genuinely zero-keystroke.

interface ProjectNode { id: string; alias: string; profile: Profile | null; invalid?: string; }

function printProjectUsage() {
  console.log(`
anet project <up|restart|down> [options]

  up        Start every node under cwd's .anet/nodes/ (skip already-running)
  restart   Kill any existing tmux session and start fresh (every node)
  down      Stop every node (kill tmux + notify hub offline)

Options (shared):
  --stagger <seconds>   Delay between nodes (default: 3). 0 disables.
  --only a,b,c          Operate only on these aliases (or node ids)
  --exclude x,y         Skip these aliases (or node ids)

Examples:
  anet project up                       # 起所有，skip 已跑的
  anet project restart --stagger 1      # 全重启，1s 错峰
  anet project down --only commhub_1    # 只停一个
`);
}

function selectProjectNodes(): ProjectNode[] {
  const opts = parseOpts();
  const splitCsv = (s: string) => new Set(s.split(",").map(x => x.trim()).filter(Boolean));
  const only = opts.only && opts.only !== "true" ? splitCsv(opts.only) : null;
  const exclude = opts.exclude && opts.exclude !== "true" ? splitCsv(opts.exclude) : null;
  const out: ProjectNode[] = [];
  for (const id of listProfileIds()) {
    const profile = loadProfile(id);
    const alias = nodeDisplayName(id, profile);
    if (only && !only.has(alias) && !only.has(id)) continue;
    if (exclude && (exclude.has(alias) || exclude.has(id))) continue;
    // #174 — flag unstartable configs up-front. These are the cases
    // launchAgent hard-exits on before it can spawn an agent, so they must
    // be reported as `invalid` and never counted toward `up`.
    let invalid: string | undefined;
    if (!profile) {
      invalid = "config.json missing or not valid JSON";
    } else if (!profile.token) {
      invalid = "no token in config (run `anet doctor --fix`)";
    } else if (profile.token.startsWith("utok_") || profile.token.startsWith("atok_")) {
      invalid = `config has a ${profile.token.slice(0, 4)}_ token but a node needs ntok_ (run \`anet doctor --fix\`)`;
    }
    out.push({ id, alias, profile, invalid });
  }
  return out;
}

function parseStaggerMs(): number {
  const raw = parseOpts().stagger;
  if (raw === undefined) return 3000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[anet] ❌ --stagger must be a non-negative number (got "${raw}")`);
    process.exit(1);
  }
  return Math.round(n * 1000);
}

function printProjectSummary(
  total: number,
  up: number,
  failed: { alias: string; reason: string }[],
  invalid: { alias: string; reason: string }[] = [],
) {
  console.log("\n──────────────────────────────────────────────");
  const parts = [`${up}/${total} up`];
  if (invalid.length) parts.push(`${invalid.length} invalid`);
  if (failed.length) parts.push(`${failed.length} failed`);
  console.log(`  ${parts.join(" · ")}`);
  if (invalid.length > 0) {
    console.log("  Invalid config (not started):");
    for (const n of invalid) console.log(`    ⚠ ${n.alias} — ${n.reason}`);
  }
  if (failed.length > 0) {
    console.log("  Failed:");
    for (const f of failed) console.log(`    ✗ ${f.alias} — ${f.reason}`);
    console.log("    → debug: anet logs <alias>  |  anet info <alias>");
  }
  console.log();
}

// #174 — verify a project-spawned node actually came alive. startNodeTmuxSession
// only confirms tmux accepted the detached command; the inner `anet node start`
// can still fail immediately (bad config, spawn error) — that used to be
// miscounted as "up" (N/N up false report). launchAgent writes
// .anet/nodes/<id>/.pid right after it spawns the agent child and removes it
// when the child exits. So: poll for a live pid, then require it to survive a
// short settle window — a child that fails fast writes .pid then has it
// removed on exit. Pure-local, no hub dependency. (Callers clear any stale
// .pid before spawning, so a pid seen here belongs to the fresh process.)
async function verifyNodeUp(nodeId: string, timeoutMs: number): Promise<{ ok: boolean; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  const settleMs = 3000;
  let aliveSince = 0;
  while (Date.now() < deadline) {
    const pid = readNodePid(nodeId);
    if (pid !== null && pidAlive(pid)) {
      if (aliveSince === 0) aliveSince = Date.now();
      else if (Date.now() - aliveSince >= settleMs) return { ok: true, reason: `pid ${pid} alive` };
    } else {
      aliveSince = 0;  // not started yet, or started then died — restart the settle clock
    }
    await new Promise(r => setTimeout(r, 500));
  }
  const pid = readNodePid(nodeId);
  if (pid !== null && pidAlive(pid)) return { ok: true, reason: `pid ${pid} alive` };
  return {
    ok: false,
    reason: pid === null
      ? "no agent pid — inner `anet node start` exited before spawning (check config)"
      : "agent process died right after starting",
  };
}

// #174 — verify a batch of just-spawned nodes concurrently (so a slow/failed
// node does not serialize the whole project up/restart). Pushes failures into
// `failed`; returns the count that came up.
async function verifySpawnedNodes(spawned: ProjectNode[], failed: { alias: string; reason: string }[]): Promise<number> {
  if (spawned.length === 0) return 0;
  console.log(`\n[anet] verifying ${spawned.length} node(s) came up…`);
  const results = await Promise.all(spawned.map(n => verifyNodeUp(n.id, 20000)));
  let up = 0;
  spawned.forEach((n, i) => {
    if (results[i].ok) {
      console.log(`  ✅ ${n.alias}`);
      up++;
    } else {
      console.log(`  ✗  ${n.alias} — ${results[i].reason}`);
      failed.push({ alias: n.alias, reason: results[i].reason });
    }
  });
  return up;
}

// #176 — auto-confirm Claude Code's dev-channels prompt for a tmux-spawned
// claude-code-cli node. anet loads the commhub channel via
// `claude --dangerously-load-development-channels server:commhub`, which pops an
// interactive "WARNING: Loading development channels … (Enter to confirm)"
// prompt on every launch — breaking zero-interaction batch starts (#176). That
// prompt cannot be suppressed by any flag/env/settings in Claude Code 2.1.147.
// So: watch the tmux pane and, ONLY when the prompt's exact text is detected,
// send a single Enter to confirm it. Detection-gated — if the prompt never
// appears (non-claude node, already past it) nothing is ever sent, so a stray
// Enter can never land on a normal Claude UI. Best-effort.
async function dismissDevChannelPrompt(sessionName: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let pane = "";
    try {
      pane = execFileSync("tmux", ["capture-pane", "-p", "-t", sessionName], { encoding: "utf-8" }).toString();
    } catch {
      return false;  // session gone / tmux error — nothing to confirm
    }
    // Both markers are unique to this exact prompt — they cannot appear
    // incidentally in normal Claude Code UI or agent output.
    if (pane.includes("I am using this for local development") || pane.includes("Loading development channels")) {
      // Prompt is rendered and waiting. Settle briefly so Ink's input handler
      // is fully attached, then confirm with a single Enter.
      await new Promise(r => setTimeout(r, 700));
      try { execFileSync("tmux", ["send-keys", "-t", sessionName, "Enter"], { stdio: "ignore" }); } catch {}
      return true;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;  // prompt never appeared within the window
}

// #176 — concurrently auto-confirm the dev-channels prompt for the just-spawned
// claude-code-cli nodes (only those carry a `server:` channel and hit the
// prompt), so `node start --all` / `project up|restart` stay zero-interaction.
async function autoConfirmDevChannels(spawned: ProjectNode[]): Promise<void> {
  const claudeNodes = spawned.filter(n =>
    n.profile && normalizeRuntime(n.profile) === "claude-code-cli" &&
    !!n.profile.channels?.some(c => c.startsWith("server:")));
  if (claudeNodes.length === 0) return;
  await Promise.all(claudeNodes.map(n => dismissDevChannelPrompt(n.alias, 45000)));
}

async function projectCommand() {
  const sub = args[1];
  switch (sub) {
    case "up": return projectUp();
    case "restart": return projectRestart();
    case "down": return projectDown();
    default: printProjectUsage();
  }
}

async function projectUp(invokedAs = "anet project up") {
  const nodes = selectProjectNodes();
  if (nodes.length === 0) {
    console.log("[anet] No nodes match. Create some with: anet node create <name>");
    return;
  }
  const stagger = parseStaggerMs();
  console.log(`\n[anet] ${invokedAs} — ${nodes.length} node(s) in ${process.cwd()}`);

  // #174 — partition out invalid configs; they are never spawned or counted up.
  const invalid: { alias: string; reason: string }[] = [];
  const startable: ProjectNode[] = [];
  for (const n of nodes) {
    if (n.invalid) {
      console.log(`  ⚠  ${n.alias} — invalid config: ${n.invalid}`);
      invalid.push({ alias: n.alias, reason: n.invalid });
    } else {
      startable.push(n);
    }
  }

  let alreadyUp = 0;
  const failed: { alias: string; reason: string }[] = [];
  const spawned: ProjectNode[] = [];
  for (let i = 0; i < startable.length; i++) {
    const n = startable[i];
    if (tmuxSessionRunning(n.alias)) {
      console.log(`  ⏭  ${n.alias} — already running`);
      alreadyUp++;
      continue;
    }
    try {
      rmSync(join(nodesDir(), n.id, ".pid"), { force: true });  // clear stale pid so verify sees only the fresh process
      startNodeTmuxSession(n.alias, n.alias);
      console.log(`  ▶  ${n.alias} — starting…`);
      spawned.push(n);
    } catch (e: any) {
      const reason = (e?.stderr?.toString().trim() || e?.message || String(e)).slice(0, 200);
      console.log(`  ✗  ${n.alias} — ${reason}`);
      failed.push({ alias: n.alias, reason });
    }
    if (stagger > 0 && i < startable.length - 1) await new Promise(r => setTimeout(r, stagger));
  }

  // #174 — only count a node `up` once its agent pid is verified alive.
  // #176 — concurrently auto-confirm Claude Code's dev-channels prompt for any
  // claude-code-cli nodes so the batch start stays zero-interaction.
  const [started] = await Promise.all([
    verifySpawnedNodes(spawned, failed),
    autoConfirmDevChannels(spawned),
  ]);
  printProjectSummary(nodes.length, alreadyUp + started, failed, invalid);
}

async function projectRestart() {
  const nodes = selectProjectNodes();
  if (nodes.length === 0) {
    console.log("[anet] No nodes match.");
    return;
  }
  const stagger = parseStaggerMs();
  console.log(`\n[anet] anet project restart — ${nodes.length} node(s) in ${process.cwd()}`);

  // #174 — partition out invalid configs; never spawned or counted up.
  const invalid: { alias: string; reason: string }[] = [];
  const startable: ProjectNode[] = [];
  for (const n of nodes) {
    if (n.invalid) {
      console.log(`  ⚠  ${n.alias} — invalid config: ${n.invalid}`);
      invalid.push({ alias: n.alias, reason: n.invalid });
    } else {
      startable.push(n);
    }
  }

  const failed: { alias: string; reason: string }[] = [];
  const spawned: ProjectNode[] = [];
  for (let i = 0; i < startable.length; i++) {
    const n = startable[i];
    const wasRunning = tmuxSessionRunning(n.alias);
    if (wasRunning) killTmuxSession(n.alias);
    stopNode(n.id);
    try {
      rmSync(join(nodesDir(), n.id, ".pid"), { force: true });  // clear stale pid so verify sees only the fresh process
      startNodeTmuxSession(n.alias, n.alias);
      console.log(`  ${wasRunning ? "↻" : "▶"}  ${n.alias} — starting…`);
      spawned.push(n);
    } catch (e: any) {
      const reason = (e?.stderr?.toString().trim() || e?.message || String(e)).slice(0, 200);
      console.log(`  ✗  ${n.alias} — ${reason}`);
      failed.push({ alias: n.alias, reason });
    }
    if (stagger > 0 && i < startable.length - 1) await new Promise(r => setTimeout(r, stagger));
  }

  // #174 — only count a node `up` once its agent pid is verified alive.
  // #176 — concurrently auto-confirm Claude Code's dev-channels prompt for any
  // claude-code-cli nodes so the batch restart stays zero-interaction.
  const [started] = await Promise.all([
    verifySpawnedNodes(spawned, failed),
    autoConfirmDevChannels(spawned),
  ]);
  printProjectSummary(nodes.length, started, failed, invalid);
}

async function projectDown() {
  const nodes = selectProjectNodes();
  if (nodes.length === 0) {
    console.log("[anet] No nodes match.");
    return;
  }
  console.log(`\n[anet] anet project down — ${nodes.length} node(s) in ${process.cwd()}`);
  let stopped = 0, alreadyDown = 0;
  for (const n of nodes) {
    const tmuxAlive = tmuxSessionRunning(n.alias);
    if (tmuxAlive) killTmuxSession(n.alias);
    const localKilled = stopNode(n.id);
    if (n.profile) {
      // Hub may be down (the very scenario this command runs in) — cap notify
      // at 2s so a 22-node teardown isn't held hostage by 44 hung fetches.
      await Promise.race([
        notifyServerOffline(n.profile, n.id),
        new Promise<void>(r => setTimeout(r, 2000)),
      ]).catch(() => {});
    }
    if (tmuxAlive || localKilled) {
      console.log(`  ⏹  ${n.alias}`);
      stopped++;
    } else {
      console.log(`  ·  ${n.alias} — not running`);
      alreadyDown++;
    }
  }
  console.log(`\n  ${stopped}/${nodes.length} stopped${alreadyDown ? ` · ${alreadyDown} were not running` : ""}\n`);
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

// ── upgrade (#88) — multi-package + dual-channel + Node-check + dry-run ─

type ReleaseChannel = "preview" | "latest";

interface UpgradePlanRow {
  pkg: string;          // npm package name
  display: string;      // short human label
  current: string | null;
  target: string | null;
  action: "upgrade" | "up-to-date" | "lazy-skip" | "self-skip" | "lookup-failed";
  note?: string;
}

// preview if version carries a prerelease tag, otherwise latest. The same
// channel applies to every package — we don't want one package on latest and
// another on preview, that's how desyncs creep in.
function detectChannel(version: string): ReleaseChannel {
  return /-(preview|rc|alpha|beta|next)/i.test(version) ? "preview" : "latest";
}

// `npm view <pkg>@<channel> version` resolves a dist-tag to its current
// pinned version. 8s timeout — npm registry hiccups shouldn't hang upgrade.
// Returns null on any failure; callers degrade gracefully.
function fetchLatestVersion(pkg: string, channel: ReleaseChannel): string | null {
  try {
    const out = execFileSync("npm", ["view", `${pkg}@${channel}`, "version"], {
      encoding: "utf-8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

interface NodeCheck { ok: boolean; current: string; required: string; }
// Read the *full* installed version (including prerelease tag) of a globally-
// installed npm package. detectInstalledPackages strips the prerelease via
// parseSemver, which would make every preview install look "out of date"
// against the preview dist-tag in upgrade plans. Returns null if not installed.
function readGlobalPackageVersion(pkgName: string): string | null {
  try {
    const out = execFileSync("npm", ["ls", "-g", pkgName, "--depth=0", "--json"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    });
    const data = JSON.parse(out);
    return data?.dependencies?.[pkgName]?.version || null;
  } catch { return null; }
}

function checkNodeVersion(): NodeCheck {
  const required = "22.13.0";
  const current = process.versions.node;
  const [maj, min, patch] = current.split(".").map(n => parseInt(n) || 0);
  const [rMaj, rMin, rPatch] = required.split(".").map(n => parseInt(n) || 0);
  const ok = maj > rMaj
    || (maj === rMaj && min > rMin)
    || (maj === rMaj && min === rMin && patch >= rPatch);
  return { ok, current, required };
}

function printManualAnetUpgrade(channel: ReleaseChannel = "latest") {
  console.log("    Run manually after this command exits:");
  console.log(`      npm install -g @sleep2agi/agent-network@${channel}`);
  console.log("    Or run in a fresh shell:");
  console.log(`      sh -c 'npm install -g @sleep2agi/agent-network@${channel} && anet -v'`);
}

// Detach a self-upgrade child so the current `anet upgrade` process can exit
// cleanly before npm replaces its binary. stderr → /tmp/anet-self-upgrade.err
// gives users a recovery breadcrumb if the spawn fails silently after we exit.
function selfUpgradeDetached(channel: ReleaseChannel): never {
  const errLog = "/tmp/anet-self-upgrade.err";
  const cmd = `npm install -g @sleep2agi/agent-network@${channel} 2>${shellQuote(errLog)} && anet -v`;
  console.log(`\n[anet] ⚙️  auto self-upgrade: detaching npm install (this shell will exit).`);
  console.log(`[anet]   Log: ${errLog}`);
  console.log(`[anet]   When npm finishes, run \`anet --version\` in a NEW shell to verify ${channel}.`);
  console.log(`[anet]   (Use \`anet upgrade --no-auto-self\` next time if you prefer to manage the install yourself.)`);
  try {
    const child = spawn("sh", ["-c", cmd], { stdio: "ignore", detached: true });
    child.unref();
  } catch (e: any) {
    console.log(`[anet] ❌ Failed to detach self-upgrade: ${e.message}`);
    printManualAnetUpgrade(channel);
    process.exit(1);
  }
  process.exit(0);
}

function printUpgradePlan(plan: UpgradePlanRow[]) {
  console.log("\n  Plan:");
  for (const p of plan) {
    const cur = p.current || "not installed";
    const tgt = p.target || "(lookup failed)";
    let badge = "";
    switch (p.action) {
      case "upgrade":       badge = "→ upgrade"; break;
      case "up-to-date":    badge = "✓ up to date"; break;
      case "lazy-skip":     badge = "(lazy via npx, skipped)"; break;
      case "self-skip":     badge = "(self — see below)"; break;
      case "lookup-failed": badge = "⚠ npm registry lookup failed"; break;
    }
    console.log(`    ${p.display.padEnd(18)}  ${cur.padEnd(20)}  →  ${tgt.padEnd(20)}  ${badge}`);
    if (p.note) console.log(`      ${p.note}`);
  }
}

async function upgradeCommand() {
  const opts = parseOpts();
  // #154 (Vincent 5489+5490) — `--self` was opt-in via #151's Option A which
  // only printed verbiage. After Vincent hit the upgrade chicken-and-egg
  // deadlock twice (old CLI doesn't know about the new verbiage), Option B is
  // now the default: detached npm spawn runs automatically. `--no-auto-self`
  // opts out for CI / scriptable use cases that prefer to manage the upgrade
  // process themselves.
  const isAutoSelfOptedOut = opts["no-auto-self"] === "true";
  const isSelf = opts.self === "true" || !isAutoSelfOptedOut;
  const isDryRun = opts["dry-run"] === "true";
  const forkScript = opts["fork-script"];

  // ── 1. Resolve channel ──
  // NOTE: parseOpts special-cases `--channel <value>` into opts._channels
  // (for `anet node create --channel <plugin>` semantics). In the upgrade
  // context the same flag means release channel, so we read _channels[0].
  // This is unambiguous because `anet upgrade` doesn't use channel plugins.
  const anetVersion = getAnetVersion();
  const detected = detectChannel(anetVersion || "");
  const channelFlag = opts._channels[0];
  let channel: ReleaseChannel;
  if (channelFlag === "preview" || channelFlag === "latest") {
    channel = channelFlag;
  } else if (channelFlag) {
    console.error(`[anet] ❌ --channel must be "preview" or "latest" (got "${channelFlag}")`);
    process.exit(1);
  } else {
    channel = detected;
  }

  // ── 2. Node version sanity ──
  const node = checkNodeVersion();

  // ── 3. Header ──
  console.log("\n[anet] anet upgrade");
  const channelSrc = channelFlag ? "--channel override" : `detected from anet v${anetVersion}`;
  console.log(`  Channel: ${channel} (${channelSrc})`);
  if (node.ok) {
    console.log(`  Node:    v${node.current} ✓`);
  } else {
    console.log(`  Node:    v${node.current} ⚠  (anet requires >=${node.required})`);
    console.log(`           Continuing anyway, but agent-node preview.9+ may fail to start.`);
    console.log(`           Tip: nvm install ${node.required.split(".")[0]} && nvm use ${node.required.split(".")[0]}`);
  }

  // ── 4. Resolve targets + build plan ──
  console.log("\n  Resolving target versions from npm registry...");

  // For "current" versions we always use the full (prerelease-preserving)
  // version string. parseSemver strips "-preview.N" which would make every
  // preview install look stale; this matters for #88 channel-aware UX.
  const agentNodeCur = readGlobalPackageVersion("@sleep2agi/agent-node");
  const serverCur    = readGlobalPackageVersion("@sleep2agi/commhub-server");
  const dashboardCur = readGlobalPackageVersion("@sleep2agi/agent-network-dashboard");

  const [anetTarget, agentNodeTarget, serverTarget, dashboardTarget] = [
    fetchLatestVersion("@sleep2agi/agent-network", channel),
    fetchLatestVersion("@sleep2agi/agent-node", channel),
    fetchLatestVersion("@sleep2agi/commhub-server", channel),
    fetchLatestVersion("@sleep2agi/agent-network-dashboard", channel),
  ];

  const plan: UpgradePlanRow[] = [];

  // anet (self)
  plan.push({
    pkg: "@sleep2agi/agent-network",
    display: "anet (self)",
    current: anetVersion || null,
    target: anetTarget,
    action: !anetTarget ? "lookup-failed"
      : (anetVersion === anetTarget) ? "up-to-date"
      : isSelf ? "upgrade" : "self-skip",
    note: !isSelf && anetVersion !== anetTarget && anetTarget
      ? "(--no-auto-self set; use `anet upgrade --self` to detach, or follow manual instructions below)"
      : undefined,
  });

  // agent-node
  if (agentNodeCur) {
    plan.push({
      pkg: "@sleep2agi/agent-node",
      display: "agent-node",
      current: agentNodeCur,
      target: agentNodeTarget,
      action: !agentNodeTarget ? "lookup-failed"
        : (agentNodeCur === agentNodeTarget ? "up-to-date" : "upgrade"),
    });
  } else {
    plan.push({
      pkg: "@sleep2agi/agent-node",
      display: "agent-node",
      current: null,
      target: agentNodeTarget,
      action: "lazy-skip",
      note: "(not installed globally — lazy-fetched via npx by `anet node start`)",
    });
  }

  // commhub-server — always note the PINNED vs global drift
  if (serverCur) {
    plan.push({
      pkg: "@sleep2agi/commhub-server",
      display: "commhub-server",
      current: serverCur,
      target: serverTarget,
      action: !serverTarget ? "lookup-failed"
        : (serverCur === serverTarget ? "up-to-date" : "upgrade"),
      note: `(anet hub start uses pinned ${PINNED_SERVER_VERSION} — your global install is for direct CLI use only)`,
    });
  } else {
    plan.push({
      pkg: "@sleep2agi/commhub-server",
      display: "commhub-server",
      current: null,
      target: serverTarget,
      action: "lazy-skip",
      note: `(not installed globally — \`anet hub start\` lazy-fetches pinned ${PINNED_SERVER_VERSION} via npx)`,
    });
  }

  // dashboard
  if (dashboardCur) {
    plan.push({
      pkg: "@sleep2agi/agent-network-dashboard",
      display: "dashboard",
      current: dashboardCur,
      target: dashboardTarget,
      action: !dashboardTarget ? "lookup-failed"
        : (dashboardCur === dashboardTarget ? "up-to-date" : "upgrade"),
    });
  } else {
    plan.push({
      pkg: "@sleep2agi/agent-network-dashboard",
      display: "dashboard",
      current: null,
      target: dashboardTarget,
      action: "lazy-skip",
      note: "(not installed globally — `anet hub dashboard` lazy-fetches via npx)",
    });
  }

  // ── 5. Print plan ──
  printUpgradePlan(plan);

  // ── 6. Dry-run ──
  if (isDryRun) {
    console.log("\n[anet] --dry-run: no install actions performed.\n");
    return;
  }

  // ── 7. Execute upgrades (anet self is handled separately at end) ──
  let upgraded = 0, upToDate = 0, lazy = 0, failed = 0;
  for (const p of plan) {
    if (p.pkg === "@sleep2agi/agent-network") continue;  // self handled below
    if (p.action === "up-to-date") { upToDate++; continue; }
    if (p.action === "lazy-skip")  { lazy++; continue; }
    if (p.action === "lookup-failed") {
      console.log(`\n  ⚠ ${p.display}: registry lookup failed — skipping (try again later).`);
      failed++;
      continue;
    }
    if (p.action !== "upgrade") continue;
    console.log(`\n  ▶ Upgrading ${p.display} → ${p.target}...`);
    try {
      installGlobalPackage(`${p.pkg}@${channel}`);
      console.log(`  ✅ ${p.display} now at ${p.target}`);
      upgraded++;
    } catch (e: any) {
      console.log(`  ✗ ${p.display} failed: ${e.message || e}`);
      failed++;
    }
  }

  // ── 8. anet self ──
  const selfPlan = plan.find(p => p.pkg === "@sleep2agi/agent-network")!;
  if (forkScript) {
    // Back-compat: legacy `--fork-script <path>` is still honored but
    // superseded by `--self`. Document removal target in CHANGELOG.
    try {
      const child = spawn(forkScript, [], { stdio: "inherit", detached: true });
      child.unref();
      console.log(`\n  ▶ Spawned legacy --fork-script: ${forkScript}`);
    } catch (e: any) {
      console.log(`\n  ⚠ --fork-script failed: ${e.message}`);
      printManualAnetUpgrade(channel);
    }
  } else if (isSelf && selfPlan.action === "upgrade") {
    selfUpgradeDetached(channel);  // process.exit
  } else if (selfPlan.action === "self-skip") {
    console.log(`\n  anet (self): ⚠️ NEEDS MANUAL UPGRADE — ${selfPlan.current} → ${selfPlan.target}`);
    console.log("    (skipped to avoid replacing the running CLI mid-execution)");
    printManualAnetUpgrade(channel);
  } else if (selfPlan.action === "up-to-date") {
    console.log("\n  anet (self): up to date.");
  } else if (selfPlan.action === "lookup-failed") {
    console.log("\n  anet (self): registry lookup failed — try later.");
    failed++;
  }

  // ── 9. Post-upgrade hints ──
  // #151 (Vincent 5462) — `Done.` previously misled users when anet itself was
  // self-skipped: they saw `0 upgraded, 2 up-to-date, 1 lazy` and assumed they
  // were on the new version, then ran `anet node create --batch` and still hit
  // the old behavior because the running CLI hadn't been swapped. The summary
  // line now explicitly flags the self-skip state.
  const selfSkipped = selfPlan.action === "self-skip";
  const summary = `${upgraded} upgraded, ${upToDate} up-to-date, ${lazy} lazy${failed ? `, ${failed} failed` : ""}${selfSkipped ? ", 1 NEEDS MANUAL UPGRADE (anet self)" : ""}`;
  console.log(`\n[anet] Done. ${summary}.`);
  if (selfSkipped) {
    console.log(`\n  ⚠️ anet CLI itself was NOT upgraded. Run this in a fresh shell:`);
    console.log(`      npm install -g @sleep2agi/agent-network@${channel}`);
    console.log(`      anet --version    # verify upgrade landed`);
    console.log(`  Without this, new features (e.g. updated vendor presets) won't apply.`);
  }
  if (upgraded > 0) {
    console.log("\n  Restart any running nodes to pick up the new versions:");
    console.log("    anet project restart   # (cwd-wide, see #117)");
  }
  console.log();
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

// ── goal (local scheduled goal management) ──

type GoalStatus = "active" | "paused" | "complete" | "failed" | "cancelled";
interface LocalGoal {
  goal_id: string;
  text: string;
  status: GoalStatus;
  interval_ms: number;
  next_wake_at?: string;
  last_wake_at?: string;
  last_report_at?: string;
  parent_task_id?: string;
  report_to?: string;
  runtime?: string;
  created_at?: string;
  updated_at?: string;
  progress_log?: Array<{ ts?: string; status?: string; summary?: string }>;
}
interface LocalGoalsFile { version: 1; goals: LocalGoal[]; }

function goalPathForNodeId(nodeId: string): string {
  return join(nodesDir(), nodeId, "goals.json");
}

function loadGoalsFile(nodeId: string): { path: string; file: LocalGoalsFile } {
  const path = goalPathForNodeId(nodeId);
  if (!existsSync(path)) return { path, file: { version: 1, goals: [] } };
  let raw = "";
  try {
    raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.goals)) {
      throw new Error("unsupported goals.json schema");
    }
    return { path, file: parsed };
  } catch (e: any) {
    throw new Error(`cannot read ${path}: ${e.message}`);
  }
}

function saveGoalsFile(path: string, file: LocalGoalsFile) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  renameSync(tmp, path);
}

function formatGoalInterval(ms: number): string {
  const min = Math.round(ms / 60000);
  if (!Number.isFinite(min) || min <= 0) return "?";
  if (min % 1440 === 0) return `${min / 1440}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}min`;
}

function formatGoalDue(nextWakeAt?: string): string {
  if (!nextWakeAt) return "-";
  const ms = new Date(nextWakeAt).getTime();
  if (!Number.isFinite(ms)) return nextWakeAt;
  const delta = ms - Date.now();
  const abs = Math.abs(delta);
  const unit = abs < 3600000 ? `${Math.max(1, Math.round(abs / 60000))}m` :
    abs < 86400000 ? `${Math.round(abs / 3600000)}h` : `${Math.round(abs / 86400000)}d`;
  return delta <= 0 ? `due ${unit} ago` : `in ${unit}`;
}

function isNodeProbablyRunning(nodeId: string, profile: Profile): boolean {
  const display = nodeDisplayName(nodeId, profile);
  if (tmuxSessionRunning(display) || tmuxSessionRunning(nodeId)) return true;
  const pidPath = join(nodesDir(), nodeId, ".pid");
  if (!existsSync(pidPath)) return false;
  try { process.kill(parseInt(readFileSync(pidPath, "utf-8"), 10), 0); return true; }
  catch { return false; }
}

// #191 Phase 1 Pillar A — parse a `--interval` flag value (CLI side, kept
// in lockstep with agent-node/src/goals/parser.ts INTERVAL_PATTERNS so the
// edit UX matches what a node accepts in `/goal`/`/loop`). Returns ms or
// null when the input is empty / unrecognised / sub-minute.
const GOAL_MIN_INTERVAL_MS = 60_000;
function parseGoalIntervalFlag(input: string | undefined): number | null {
  if (!input || typeof input !== "string") return null;
  const body = input.trim();
  if (!body) return null;
  if (/\d+\s*(?:seconds|second|secs|sec|s)\b/i.test(body) || /\d+\s*秒/.test(body)) return null;
  const patterns: Array<{ re: RegExp; toMs: (m: RegExpExecArray) => number }> = [
    { re: /^\s*hourly\s*$/i, toMs: () => 60 * 60_000 },
    { re: /^\s*daily\s*$/i, toMs: () => 24 * 60 * 60_000 },
    { re: /^\s*每\s*小时\s*$/, toMs: () => 60 * 60_000 },
    { re: /^\s*每\s*天\s*$/, toMs: () => 24 * 60 * 60_000 },
    { re: /^\s*每?\s*(\d+)\s*分钟?\s*$/, toMs: (m) => parseInt(m[1], 10) * 60_000 },
    { re: /^\s*每?\s*(\d+)\s*小时\s*$/, toMs: (m) => parseInt(m[1], 10) * 60 * 60_000 },
    { re: /^\s*每?\s*(\d+)\s*天\s*$/, toMs: (m) => parseInt(m[1], 10) * 24 * 60 * 60_000 },
    { re: /^\s*(\d+)\s*(?:minutes|minute|mins|min|m)\s*$/i, toMs: (m) => parseInt(m[1], 10) * 60_000 },
    { re: /^\s*(\d+)\s*(?:hours|hour|hrs|hr|h)\s*$/i, toMs: (m) => parseInt(m[1], 10) * 60 * 60_000 },
    { re: /^\s*(\d+)\s*(?:days|day|d)\s*$/i, toMs: (m) => parseInt(m[1], 10) * 24 * 60 * 60_000 },
  ];
  for (const { re, toMs } of patterns) {
    const m = re.exec(body);
    if (m) {
      const ms = toMs(m);
      if (!Number.isFinite(ms) || ms < GOAL_MIN_INTERVAL_MS) return null;
      return ms;
    }
  }
  return null;
}

const GOAL_VALID_STATUS = new Set(["active", "paused", "completed", "cancelled"]);

// #191 Phase 1 Pillar A — render one goal with progress log for `anet goal
// show`. Compact, no color codes (consistent with `anet info`).
function printGoalShow(goal: LocalGoal, displayName: string, path: string) {
  console.log("");
  console.log(`  Goal:     ${goal.goal_id}`);
  console.log(`  Node:     ${displayName}`);
  console.log(`  Status:   ${goal.status || "?"}`);
  console.log(`  Text:     ${(goal.text || "").replace(/\s+/g, " ")}`);
  console.log(`  Every:    ${formatGoalInterval(goal.interval_ms)}`);
  console.log(`  Next:     ${formatGoalDue(goal.next_wake_at)}${goal.next_wake_at ? `  (${goal.next_wake_at})` : ""}`);
  if (goal.last_wake_at) console.log(`  Last:     ${goal.last_wake_at}`);
  if (goal.runtime) console.log(`  Runtime:  ${goal.runtime}`);
  if (goal.parent_task_id) console.log(`  Parent:   ${goal.parent_task_id}`);
  if (goal.report_to) console.log(`  ReportTo: ${goal.report_to}`);
  console.log(`  Created:  ${goal.created_at || "-"}`);
  console.log(`  Updated:  ${goal.updated_at || "-"}`);
  console.log(`  File:     ${path}`);
  const log = Array.isArray(goal.progress_log) ? goal.progress_log : [];
  if (log.length === 0) {
    console.log("  Progress: (none)");
  } else {
    console.log(`  Progress (${log.length}):`);
    for (const entry of log.slice(-10)) {
      const ts = (entry.ts || "").slice(0, 19).padEnd(19);
      const st = (entry.status || "").padEnd(10);
      const sm = (entry.summary || "").replace(/\s+/g, " ").slice(0, 80);
      console.log(`    ${ts}  ${st}  ${sm}`);
    }
    if (log.length > 10) console.log(`    … ${log.length - 10} earlier entries omitted`);
  }
  console.log("");
}

function printGoalUsage() {
  console.log(`
anet goal <command>

  list [node]                  List scheduled goals for one node, or all nodes
  show <node> <goal-id>        Show one goal in detail (including progress log)
  edit <node> <goal-id> ...    Edit a goal's interval / text / status
  cancel <node> <goal-id>      Mark a goal cancelled in that node's goals.json

Edit flags (at least one required):
  --interval <5min|1h|1d|每5分钟|hourly|daily|...>
  --text "<new goal description>"
  --status active|paused|completed|cancelled

Examples:
  anet goal list
  anet goal list 通信牛
  anet goal show 通信牛 abcd1234
  anet goal edit 通信牛 abcd1234 --interval 10min
  anet goal edit 通信牛 abcd1234 --status paused
  anet goal cancel 通信牛 abcd1234

Data: .anet/nodes/<node>/goals.json

Note: running agent-node processes keep goal state in memory. After edit /
cancel, restart the node for the change to take effect until live goal
control is backed by a hub API.
`);
}

async function goalCommand() {
  const sub = args[1];
  if (!sub || sub === "--help" || sub === "-h") {
    printGoalUsage();
    return;
  }

  if (sub === "list" || sub === "ls") {
    const nodeRef = args[2];
    const targets = nodeRef
      ? (() => {
          const resolved = resolveNodeRef(nodeRef);
          if (!resolved) {
            console.error(`Node "${nodeRef}" not found.`);
            process.exit(1);
          }
          return [resolved];
        })()
      : listProfileIds().map(id => {
          const profile = loadProfile(id);
          return profile ? { id, profile } : null;
        }).filter(Boolean) as Array<{ id: string; profile: Profile }>;

    let total = 0;
    for (const { id, profile } of targets) {
      const { path, file } = loadGoalsFile(id);
      const goals = file.goals || [];
      if (!nodeRef && goals.length === 0) continue;
      total += goals.length;
      const name = nodeDisplayName(id, profile);
      console.log(`\n${name} (${id})`);
      console.log(`  ${path}`);
      if (goals.length === 0) {
        console.log("  No goals.");
        continue;
      }
      console.log("  ID       STATUS     EVERY   NEXT        TEXT");
      console.log("  ──────── ────────── ─────── ─────────── ─────────────────────────────");
      for (const g of goals) {
        const short = g.goal_id.slice(0, 8);
        const status = String(g.status || "?").padEnd(10);
        const every = formatGoalInterval(g.interval_ms).padEnd(7);
        const due = formatGoalDue(g.next_wake_at).slice(0, 11).padEnd(11);
        const text = (g.text || "").replace(/\s+/g, " ").slice(0, 60);
        console.log(`  ${short} ${status} ${every} ${due} ${text}`);
      }
    }
    if (total === 0) console.log("\nNo goals found.\n");
    else console.log();
    return;
  }

  if (sub === "cancel") {
    const nodeRef = args[2];
    const goalRef = args[3];
    if (!nodeRef || !goalRef) {
      console.error("Usage: anet goal cancel <node> <goal-id>");
      process.exit(1);
    }
    const resolved = resolveNodeRef(nodeRef);
    if (!resolved) {
      console.error(`Node "${nodeRef}" not found.`);
      process.exit(1);
    }
    const { path, file } = loadGoalsFile(resolved.id);
    const matches = file.goals.filter(g => g.goal_id === goalRef || g.goal_id.startsWith(goalRef));
    if (matches.length === 0) {
      console.error(`Goal "${goalRef}" not found in ${path}`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`Goal prefix "${goalRef}" is ambiguous (${matches.length} matches). Use a longer id.`);
      process.exit(1);
    }
    const goal = matches[0];
    goal.status = "cancelled";
    goal.updated_at = new Date().toISOString();
    goal.progress_log = Array.isArray(goal.progress_log) ? goal.progress_log : [];
    goal.progress_log.push({ ts: new Date().toISOString(), status: "cancelled", summary: "cancelled by anet goal cancel" });
    saveGoalsFile(path, file);

    console.log(`[anet] cancelled goal ${goal.goal_id.slice(0, 8)} for ${nodeDisplayName(resolved.id, resolved.profile)}`);
    console.log(`[anet] ${path}`);
    if (isNodeProbablyRunning(resolved.id, resolved.profile)) {
      console.log("[anet] node appears to be running; restart it for local goals.json changes to take effect.");
    }
    return;
  }

  // #191 Phase 1 Pillar A — `anet goal show <node> <goal-id>`: detailed
  // view for one goal, including the last 10 progress_log entries. Read-only.
  if (sub === "show") {
    const nodeRef = args[2];
    const goalRef = args[3];
    if (!nodeRef || !goalRef) {
      console.error("Usage: anet goal show <node> <goal-id>");
      process.exit(1);
    }
    const resolved = resolveNodeRef(nodeRef);
    if (!resolved) {
      console.error(`Node "${nodeRef}" not found.`);
      process.exit(1);
    }
    const { path, file } = loadGoalsFile(resolved.id);
    const matches = file.goals.filter(g => g.goal_id === goalRef || g.goal_id.startsWith(goalRef));
    if (matches.length === 0) {
      console.error(`Goal "${goalRef}" not found in ${path}`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`Goal prefix "${goalRef}" is ambiguous (${matches.length} matches). Use a longer id.`);
      process.exit(1);
    }
    printGoalShow(matches[0], nodeDisplayName(resolved.id, resolved.profile), path);
    return;
  }

  // #191 Phase 1 Pillar A — `anet goal edit <node> <goal-id> --interval ...
  // --text "..." --status active|paused|completed|cancelled`. At least one
  // mutating flag required. Atomic write (saveGoalsFile = tmp + rename).
  // Appends a progress_log "edited" entry summarising the changed fields so
  // the audit trail is preserved.
  if (sub === "edit") {
    const nodeRef = args[2];
    const goalRef = args[3];
    if (!nodeRef || !goalRef) {
      console.error("Usage: anet goal edit <node> <goal-id> [--interval ...] [--text \"...\"] [--status ...]");
      process.exit(1);
    }
    const opts = parseOpts();
    const resolved = resolveNodeRef(nodeRef);
    if (!resolved) {
      console.error(`Node "${nodeRef}" not found.`);
      process.exit(1);
    }
    const { path, file } = loadGoalsFile(resolved.id);
    const matches = file.goals.filter(g => g.goal_id === goalRef || g.goal_id.startsWith(goalRef));
    if (matches.length === 0) {
      console.error(`Goal "${goalRef}" not found in ${path}`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`Goal prefix "${goalRef}" is ambiguous (${matches.length} matches). Use a longer id.`);
      process.exit(1);
    }
    const goal = matches[0];
    const changes: string[] = [];

    if (typeof opts.interval === "string" && opts.interval.length > 0) {
      const ms = parseGoalIntervalFlag(opts.interval);
      if (ms === null) {
        console.error(`--interval value not recognised: "${opts.interval}". Try 5min / 1h / 1d / 每5分钟 / hourly / daily (sub-minute rejected).`);
        process.exit(1);
      }
      if (ms !== goal.interval_ms) {
        const prev = formatGoalInterval(goal.interval_ms);
        goal.interval_ms = ms;
        // Recompute next_wake_at from now + new interval so the change
        // takes effect on the next tick rather than waiting out the old
        // window. Live nodes still need a restart per the Note in usage.
        goal.next_wake_at = new Date(Date.now() + ms).toISOString();
        changes.push(`interval ${prev} → ${formatGoalInterval(ms)}`);
      }
    }

    if (typeof opts.text === "string" && opts.text.length > 0) {
      const next = opts.text.trim();
      if (next && next !== goal.text) {
        goal.text = next;
        changes.push(`text updated (${next.length} chars)`);
      }
    }

    if (typeof opts.status === "string" && opts.status.length > 0) {
      const next = opts.status.trim().toLowerCase();
      if (!GOAL_VALID_STATUS.has(next)) {
        console.error(`--status must be one of: ${Array.from(GOAL_VALID_STATUS).join(", ")}`);
        process.exit(1);
      }
      if (next !== goal.status) {
        const prev = goal.status || "?";
        goal.status = next as GoalStatus;
        changes.push(`status ${prev} → ${next}`);
      }
    }

    if (changes.length === 0) {
      console.error("No edit flags supplied (or no effective change). Use --interval / --text / --status.");
      process.exit(1);
    }

    goal.updated_at = new Date().toISOString();
    goal.progress_log = Array.isArray(goal.progress_log) ? goal.progress_log : [];
    goal.progress_log.push({
      ts: goal.updated_at,
      status: goal.status,
      summary: `edited by anet goal edit: ${changes.join("; ")}`,
    });
    saveGoalsFile(path, file);

    console.log(`[anet] edited goal ${goal.goal_id.slice(0, 8)} for ${nodeDisplayName(resolved.id, resolved.profile)}`);
    for (const c of changes) console.log(`         ${c}`);
    console.log(`[anet] ${path}`);
    if (isNodeProbablyRunning(resolved.id, resolved.profile)) {
      console.log("[anet] node appears to be running; restart it for local goals.json changes to take effect.");
    }
    return;
  }

  printGoalUsage();
  process.exit(1);
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
//   runtime: claude-agent-sdk   (#98 confirmed fully compatible with intern)
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
    runtime  = claude-agent-sdk   (#98 confirmed fully compatible with intern)
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
  console.log(`        Runtime:   claude-agent-sdk + intern-s1-pro\n`);

  // sci-team is now a preset wrapper over the generic batch primitive
  // (issue #55). The Intern URL + model + active-fan-out sciTeamPrompt
  // template all stay locked here; createBatch handles the per-node
  // mkdir + ensureNodeToken + saveProfile + tmux launch loop.
  const result = await createBatch({
    prefix: "研究员",
    count,
    workdir: targetDir,
    workdirMode: "separate",
    runtime: "claude-agent-sdk",
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
  runtime: string;               // claude-agent-sdk / codex-sdk / claude-code-cli
  model?: string;                // e.g. intern-s1-pro / MiniMax-M2.7 / claude-sonnet-4-6
  baseUrl?: string;              // ANTHROPIC_BASE_URL value (omit for Anthropic native)
  apiKey?: string;               // ANTHROPIC_AUTH_TOKEN value (or runtime-specific token)
  authTokenEnvName?: string;     // env var name for the auth token (default ANTHROPIC_AUTH_TOKEN)
  systemPrompt?: string | ((role: "leader" | "worker", index: number, total: number) => string);
  team?: string;                 // profile.team field + tmux session prefix (defaults to prefix)
  leaderAlias?: string;          // 设了 → i=1 = leader role with this alias; i>1 = `${prefix}${i-1}号` worker. 没设 → all i = `${prefix}${i}号` workers.
  printSummary?: boolean;        // default true
  noYolo?: boolean;              // #156 — opt out of codex-sdk yolo flags (CI / scripted use). default false (yolo on, matches single-node).
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
        flags: {
          dangerouslySkipPermissions: true,
          // #156 (Vincent 5531) — same codex-sdk yolo posture as single-node
          // (createProfileFromOpts). Helper is the source of truth, shared
          // between the two paths to prevent the v0.10.6 1/4-vs-4/4 drift.
          ...(opts.runtime === "codex-sdk" ? codexSdkYoloFlags(opts.noYolo) : {}),
        },
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
// Vendor/model selection is the unified VENDORS registry + selectVendorAndModel()
// (issue #104-B). The old BATCH_PRESETS array was removed in B3 — createBatchWizardCommand
// now uses findVendorByModel() for --preset back-compat and selectVendorAndModel()
// for the interactive path.

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
                          mimo-v2.5-pro / claude-sonnet-4-6 / claude-opus-4-6 /
                          claude-haiku-4-5 / __custom__
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

  // 1. Vendor + model (vendor-first, #104-B B2.3)
  //
  // --preset back-compat (通信龙 decision): old --preset values are model ids
  // (intern-s1-pro / MiniMax-M2.7 / mimo-v2.5-pro / claude-sonnet-4-6 / ...) or
  // "__custom__". findVendorByModel maps a model id → its vendor;
  // resolveVendorSelection covers the case where someone passes a vendor key.
  let runtime: string;
  let model: string | undefined;
  let baseUrl: string | undefined;
  let presetLabel: string;
  // #153 (Vincent 5481) — capture vendor.requiresAuth so the batch wizard
  // can skip the ANTHROPIC_AUTH_TOKEN prompt for vendors that already login
  // through their own CLI (codex / claude-code-cli). For __custom__ runtime,
  // derive requiresAuth from the runtime choice.
  let requiresAuth: "claude" | "codex" | undefined;
  if (opts.preset === "__custom__") {
    const customRuntime = await ask("Runtime (claude-agent-sdk / codex-sdk / claude-code-cli)", "claude-agent-sdk");
    runtime = normalizeRuntime(customRuntime);
    baseUrl = (await ask("ANTHROPIC_BASE_URL (空白=Anthropic default)", "")) || undefined;
    model = (await ask("Model id", "")) || undefined;
    presetLabel = `custom (${runtime}${model ? " + " + model : ""})`;
    // Custom runtime auth inference: codex-sdk uses `codex auth login`, claude-
    // code-cli uses `claude` subscription; the SDK path needs an API key.
    if (runtime === "codex-sdk") requiresAuth = "codex";
    else if (runtime === "claude-code-cli") requiresAuth = "claude";
  } else if (opts.preset) {
    const sel = findVendorByModel(opts.preset) || resolveVendorSelection(opts.preset);
    if (!sel) {
      closeRL();
      console.error(`[anet] Unknown --preset: ${opts.preset}. 见 --help 的 vendor / model 列表。`);
      return;
    }
    runtime = sel.runtime; model = sel.model; baseUrl = sel.baseUrl;
    requiresAuth = sel.requiresAuth;
    presetLabel = `${sel.vendorKey}${model ? " + " + model : ""}`;
  } else {
    const sel = await selectVendorAndModel();
    if (!sel) {
      closeRL();
      console.error(`[anet] vendor selector 不可用（非交互终端？用 --preset <model-id> 指定）。`);
      return;
    }
    runtime = sel.runtime; model = sel.model; baseUrl = sel.baseUrl;
    requiresAuth = sel.requiresAuth;
    presetLabel = `${sel.vendorKey}${model ? " + " + model : ""}`;
  }

  // 2. API key — #153 (Vincent 5481): vendors with their own CLI login flow
  // (codex / claude-code-cli) don't need an ANTHROPIC_AUTH_TOKEN. Skip the
  // prompt and print a hint that the user should run the vendor's own login.
  let apiKey: string | undefined;
  if (requiresAuth === "codex") {
    console.log("  [anet] codex-sdk — will reuse `codex auth login` state (no API key needed)");
    console.log("         If not logged in: run `codex auth login` in a separate terminal first.");
    apiKey = undefined;
  } else if (requiresAuth === "claude") {
    console.log("  [anet] claude-code-cli — will reuse `claude` CLI / subscription (no API key needed)");
    console.log("         If not logged in: run `claude` once in a separate terminal to sign in.");
    apiKey = undefined;
  } else {
    apiKey = opts["api-key"] || opts.key || process.env.ANET_BATCH_API_KEY || await ask("API key (ANTHROPIC_AUTH_TOKEN)");
    if (!apiKey) {
      closeRL();
      console.error("[anet] API key required.");
      return;
    }
  }

  // 3. Workdir
  const workdir = opts.workdir || await ask("Workdir", join(home, "anet-team"));
  // #152 (Vincent 5477+5478) — `--workdir-mode` CLI flag already supported
  // (separate / shared), but the interactive wizard never asked. Now it does:
  // explicit prompt with inquirer select when the flag isn't pre-set.
  let workdirMode: "separate" | "shared";
  if (opts["workdir-mode"]) {
    workdirMode = opts["workdir-mode"] as "separate" | "shared";
    if (workdirMode !== "separate" && workdirMode !== "shared") {
      closeRL();
      console.error(`[anet] --workdir-mode must be 'separate' or 'shared', got: ${workdirMode}`);
      return;
    }
  } else {
    try {
      const { select: sel } = await import("@inquirer/prompts");
      workdirMode = await sel({
        message: "工作目录模式 (Workdir mode):",
        choices: [
          { value: "separate" as const, name: `separate — 每节点独立子目录 (${workdir}/node1, ${workdir}/node2, ...)` },
          { value: "shared"   as const, name: `shared   — 全部共享同一目录 (${workdir} 一个 .anet/nodes/, 所有 agent 同 cwd)` },
        ],
        default: "separate",
      }) as "separate" | "shared";
    } catch {
      // Non-TTY / inquirer missing → keep existing default.
      console.log(`[anet] ⚠ Workdir mode selector unavailable — defaulting to 'separate' (use --workdir-mode shared to opt in)`);
      workdirMode = "separate";
    }
  }

  // 4. Prefix + count — #155 (Vincent 5493 hit wizard exit here)
  //
  // After the inquirer select() prompt for workdir mode (above), @inquirer/
  // prompts leaves process.stdin in a state where the readline-based ask()
  // returns immediately at EOF and the process silently exits — the EXACT
  // same #137 (preview.5) pattern. The fix is to use inquirer input() for
  // all post-select prompts so stdin handling stays uniform with the select
  // that came before.
  let prefix: string;
  let countStr: string;
  let description: string;
  try {
    const { input: inquirerInput } = await import("@inquirer/prompts");
    prefix = opts.prefix || (await inquirerInput({
      message: "Node prefix (e.g. 工程师)",
      default: "工程师",
    })).trim() || "工程师";
    countStr = opts.count || (await inquirerInput({
      message: "Count (1-50)",
      default: "5",
    })).trim() || "5";
    // 5. Description (systemPrompt)
    // parseOpts maps a valueless/empty `--description` (e.g. `--description ""`)
    // to the sentinel string "true"; treat that as "not provided" (#93).
    const descFlag = opts.description === "true" ? "" : opts.description;
    description = descFlag || (await inquirerInput({
      message: "Description / system prompt (空 → no prompt)",
      default: "",
    })).trim();
  } catch {
    // Non-TTY / inquirer unavailable — fall back to legacy readline ask().
    prefix = opts.prefix || await ask("Node prefix (e.g. 工程师)", "工程师");
    countStr = opts.count || await ask("Count (1-50)", "5");
    const descFlag = opts.description === "true" ? "" : opts.description;
    description = descFlag || await ask("Description / system prompt (空 → no prompt)", "");
  }
  const countRaw = parseInt(countStr, 10);
  const count = Math.max(1, Math.min(50, Number.isFinite(countRaw) ? countRaw : 5));
  if (count !== countRaw) {
    console.log(`  [anet] Count ${countRaw} → clamped to [1,50] = ${count}`);
  }
  if (count > 20) {
    console.warn(`  [anet] Warning: count=${count} > 20 may exceed memory/ulimit on a developer laptop. Recommended ≤ 20 unless tested.`);
  }

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
  console.log(`        Preset:        ${presetLabel}`);
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
    noYolo: opts["no-yolo"] === "true",  // #156 — propagate opt-out to batch path
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
  // #101 user warning — make the effective toolset explicit. Empty / missing
  // tools means the runtime gets the full Claude Code preset; this is shown as
  // "all (preset)" so users don't mistake it for "no tools".
  const toolsArr = Array.isArray(profile.tools) ? profile.tools : [];
  console.log(`  tools:    ${toolsArr.length ? `[${toolsArr.join(", ")}]` : "all (Claude Code preset)"}`);
  // Flags worth surfacing — dangerouslySkipPermissions is the one most likely
  // to surprise users in retrospect, so list it first.
  const flags = (profile as any).flags || {};
  const flagBits = [
    `dangerouslySkipPermissions=${flags.dangerouslySkipPermissions === false ? "false" : "true"}`,
    flags.teammateMode ? "teammateMode" : null,
  ].filter(Boolean);
  console.log(`  flags:    ${flagBits.join(", ")}`);
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

// ── migrate-token-to-envref (issue #125) ──
//
// Convert plain-secret env values in a node's config.json to the envRef shape
// (`{ "_envRef": "<NAME>" }`) so secrets stop persisting on disk. Backward
// compat: agent-node runtime accepts both shapes; existing plain configs keep
// working until the user migrates.
async function migrateTokenToEnvRefCommand() {
  const ref = args[1];
  if (!ref) {
    console.log(`\nanet node migrate-token-to-envref <node-name>`);
    console.log(`\n  Convert plain-secret env values in this node's config.json to envRef shape.`);
    console.log(`  Secrets persist in process.env only; config.json holds the env-var name.\n`);
    return;
  }
  const resolved = resolveNodeRef(ref);
  if (!resolved) { console.error(`Node "${ref}" not found.`); process.exit(1); }
  const { id: nodeId, profile } = resolved;
  const envMap: any = profile.env;
  if (!envMap || typeof envMap !== "object") {
    console.log(`[anet] Node "${nodeId}" has no env map — nothing to migrate.`);
    return;
  }

  // Same regex pair the runtime (#125) and `anet doctor` (#125) use.
  const SECRET_KEY_RX = /(_TOKEN|_KEY|_SECRET|AUTH)$/i;
  const SECRET_VAL_RX = /^(sk-|utok_|ntok_|atok_|ak-|gsk_|key-|Bearer\s)/i;
  const candidates: { key: string; value: string }[] = [];
  for (const [k, v] of Object.entries(envMap)) {
    if (typeof v !== "string") continue; // already envRef object
    if (SECRET_KEY_RX.test(k) || SECRET_VAL_RX.test(v)) {
      candidates.push({ key: k, value: v });
    }
  }
  if (candidates.length === 0) {
    console.log(`[anet] Node "${nodeId}" — no plain-secret env values detected. Nothing to migrate.`);
    return;
  }

  // Derive a safe env-var name: <KEY>_<NODE_ID_SUFFIX>. node_id is ASCII;
  // alias may include CJK which is allowed in process.env on most shells but
  // breaks `export NAME=...` interpolation. Pick the ASCII path.
  const nodeIdShort = (profile.node_id || nodeId).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 16);
  const newEnv: any = { ...envMap };
  const exportLines: string[] = [];
  for (const { key, value } of candidates) {
    const refName = `${key}_${nodeIdShort}`.toUpperCase();
    newEnv[key] = { _envRef: refName };
    // Quote the value: it may contain shell-special chars; single-quote and
    // escape any literal single quote inside.
    const safeVal = value.replace(/'/g, `'\\''`);
    exportLines.push(`export ${refName}='${safeVal}'`);
  }

  // Backup the original config before overwriting, so users can revert.
  const cfgPath = join(nodesDir(), nodeId, "config.json");
  if (!existsSync(cfgPath)) {
    console.error(`[anet] Node "${nodeId}" config not found at ${cfgPath}`);
    process.exit(1);
  }
  const bakPath = `${cfgPath}.bak-${Date.now()}`;
  try {
    writeFileSync(bakPath, readFileSync(cfgPath, "utf-8"));
  } catch (e: any) {
    console.error(`[anet] Failed to write backup ${bakPath}: ${e.message}`);
    process.exit(1);
  }

  // Persist the migrated env map. We rewrite the whole profile to preserve
  // every other field (the canonical writer is `saveProfile()`).
  const newProfile: any = { ...profile, env: newEnv };
  saveProfile(nodeId, newProfile);

  console.log(`\n[anet] ✅ Migrated ${candidates.length} env value(s) in node "${nodeId}":`);
  for (const { key } of candidates) console.log(`         env.${key} → { _envRef: "${key}_${nodeIdShort}".toUpperCase() }`);
  console.log(`[anet]    Backup written: ${bakPath}\n`);
  console.log(`[anet] 🔑 Now export the secret values in your shell BEFORE starting this node:`);
  console.log("");
  for (const line of exportLines) console.log(`    ${line}`);
  console.log("");
  console.log(`[anet]    (Append these to ~/.bashrc / ~/.zshrc / your secrets manager for persistence.)`);
  console.log(`[anet]    The agent-node runtime will refuse to start if any referenced var is unset.`);
  console.log(`[anet]    Restart the node: anet node start ${nodeId}\n`);
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

  // #125 — scan all nodes for plain-secret env values still persisted in
  // config.json. Migration is per-node (`anet node migrate-token-to-envref
  // <alias>`); doctor just enumerates candidates so users see the inventory
  // before deciding whether to migrate.
  const SECRET_KEY_RX = /(_TOKEN|_KEY|_SECRET|AUTH)$/i;
  const SECRET_VAL_RX = /^(sk-|utok_|ntok_|atok_|ak-|gsk_|key-|Bearer\s)/i;
  const plainSecretNodes: { id: string; fields: string[] }[] = [];
  for (const id of ids) {
    const p = loadProfile(id);
    if (!p || !p.env || typeof p.env !== "object") continue;
    const hits: string[] = [];
    for (const [k, v] of Object.entries(p.env)) {
      if (typeof v !== "string") continue; // already envRef object → safe
      if (SECRET_KEY_RX.test(k) || SECRET_VAL_RX.test(v)) hits.push(k);
    }
    if (hits.length) plainSecretNodes.push({ id, fields: hits });
  }
  if (plainSecretNodes.length) {
    warning("Plain-secret config detected", `${plainSecretNodes.length} node(s) persist secrets in config.json (security hygiene #125)`);
    for (const { id, fields } of plainSecretNodes) {
      const name = nodeDisplayName(id, loadProfile(id));
      info(`    ↳ ${name}`, `env keys: ${fields.join(", ")}`);
    }
    info("→ migrate", `anet node migrate-token-to-envref <alias>   (one node at a time, prints export commands)`);
  } else {
    check("No plain-secret config", true, "all env values are either non-secret or envRef objects");
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

// #135 v3 fix — Wrap the entire dispatch in `async function main()` so the
// module's actual top-level has zero `await` expressions. Node v24 ESM
// strict mode emits "Detected unsettled top-level await" + minified bundle
// stack dump when the module's top-level await chain settles but the event
// loop is still busy. With the dispatch inlined at top level (the original
// pattern), the bundle is compiled with implicit module-level awaits that
// the v24 check considers "unsettled" even after we call process.exit(0)
// (the check runs BEFORE exit takes effect). Moving the dispatch into an
// async function removes the module-level await entirely; only main()'s
// returned promise needs to settle, and an explicit .then/.catch terminator
// gives Node v24 a clean module shutdown signal. preview.0 / preview.1
// fixes (process.exit in createInteractiveCommand / dispatch end) didn't
// help because they don't change the module's top-level await profile.
async function main() {
// #215 (P0) — universal --help / -h intercept: never let a subcommand's
// `--help` argv slip into business logic. Without this, `anet token create
// --help` SIGNS a real token, `anet run --help` STARTS a real SSE listener
// on :9200, `anet hub start --help` STARTS the hub. Convention everywhere
// else (cargo, git, npm, docker) is "see help, no side effect" — match it.
// Per-subcommand inline help is polish (tracked in #214 F7-01 follow-ups);
// here we hard-stop with global help, which is correct minimum.
if (args.slice(1).some((a) => a === "--help" || a === "-h")) {
  printHelp();
  process.exit(0);
}
switch (command) {
  case "init":
    if (args[1] === "project") initProject();
    else if (args[1] === "profile") await initProfile();
    else await initGlobal();
    break;
  case "create": await createCommand(); break;
  case "server": await serverCommand(); break;
  case "hub": await serverCommand(); break; // anet hub start/dashboard/config
  case "node": // anet node create/start/stop/resume/delete/ls/rename
    switch (args[1]) {
      case "create": args.splice(0, 1); await createCommand(); break;
      case "start": args.splice(0, 1); await startCommand(); break;
      case "stop": args.splice(0, 1); await stopCommand(); break;
      case "resume": args.splice(0, 1); await resumeCommand(); break;
      case "delete": args.splice(0, 1); await deleteCommand(); break;
      case "rename": args.splice(0, 1); await renameCommand(); break;
      case "ls": case "list": await lsCommand(); break;
      case "migrate-token-to-envref": args.splice(0, 1); await migrateTokenToEnvRefCommand(); break;
      default: console.log(`Usage: anet node <create|start|stop|resume|delete|ls|rename|migrate-token-to-envref> [name]`); break;
    }
    break;
  case "project": await projectCommand(); break;  // #117 — cwd-wide orchestration
  case "start": await startCommand(); break;   // backward compat
  case "resume": await resumeCommand(); break; // backward compat
  case "rename": await renameCommand(); break; // backward compat
  case "stop": await stopCommand(); break; // backward compat
  case "delete": await deleteCommand(); break; // backward compat
  case "import": await importCommand(); break;
  case "channel": await channelCommand(); break;
  case "setup": await setupCommand(); break;
  case "upgrade": await upgradeCommand(); break;
  case "session": sessionCommand(); break;
  case "ls": case "list": await lsCommand(); break;
  case "status": await statusCommand(); break;
  case "tasks": await tasksCommand(); break;
  case "goal": await goalCommand(); break;
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
  case "run": await runCommand(); break;
  case "-v": case "--version": case "version": {
    printVersionReport();
    break;
  }
  case "--help": case "-h": case undefined: printHelp(); break;
  default:
    if (resolveNodeRef(command)) { args.unshift("start"); await startCommand(); }
    else { console.error(`Unknown: ${command}`); printHelp(); process.exit(1); }
}
}  // end async function main

// #135 v3 — explicit .then/.catch terminator. main()'s returned promise is
// the ONLY top-level promise the module emits; no `await` at module scope
// means Node v24's strict ESM checker has nothing to scan. We exit
// explicitly in both branches so readline / @inquirer signal handlers
// don't keep the event loop alive past the dispatch.
main().then(
  () => { if (process.env.ANET_INTERNAL_KEEP_PROCESS !== "1") process.exit(0); },
  (err: any) => {
    console.error("[anet] FATAL:", err?.stack || err?.message || err);
    process.exit(1);
  },
);
