// #630 — codex nodes whose app-server URL is fixed in config.json and that run as
// three tmux sessions: `<alias>-appsrv` (codex app-server), `<alias>-tui` (codex
// TUI resuming the configured thread), `<alias>` (agent-node bridge).
//
// This is the layout an external team's per-node launcher uses (modes
// appserver / tui / bridge). Until now it was brought up by hand-written
// scripts; this module holds the pure decisions so `anet node start|stop|restart`
// can do it with one command and the Docker suite (tests/test630-*) can pin them.
//
// 🔴 It is NOT the RFC-030 co-presence layout that `anet node start --copresence`
//    builds (`<alias>` = TUI, `<alias>-桥` = bridge, a port anet picks and then
//    writes into codexAppServerUrl). Those nodes ALSO carry codexAppServerUrl +
//    codexCopresence, so "has a URL" cannot be the discriminator — reading it
//    that way would re-launch every native co-presence node in the wrong shape.
//    The layout is opted into explicitly: `--external-appserver` once, recorded
//    as `codexLaunchLayout: "external-appserver"` in config.json.

import { createServer, type AddressInfo } from "node:net";
import { request } from "node:http";
import { join } from "node:path";

export const EXTERNAL_APPSERVER_LAYOUT = "external-appserver";
/** Each node (app-server + TUI) measured at 1.5–2 GB; refuse below two nodes' worth. */
export const MIN_MEM_AVAILABLE_BYTES = 4 * 1024 ** 3;
export const READYZ_TIMEOUT_MS = 30_000;

export interface ExternalAppserverProfile {
  runtime?: string;
  codexAppServerUrl?: string;
  codexThreadId?: string;
  codexProjectDir?: string;
  codexCopresence?: boolean;
  codexLaunchLayout?: string;
  codexBin?: string;
  codexHome?: string;
  model?: string;
  env?: Record<string, unknown>;
}

export interface ExternalAppserverSessions { appsrv: string; tui: string; bridge: string }

export function externalAppserverSessions(alias: string): ExternalAppserverSessions {
  return { appsrv: `${alias}-appsrv`, tui: `${alias}-tui`, bridge: alias };
}

/** Bridge first, so nothing is left attached to a server that is going away. */
export function externalAppserverStopOrder(alias: string): string[] {
  const s = externalAppserverSessions(alias);
  return [s.bridge, s.tui, s.appsrv];
}

/**
 * Does this start/stop/restart take the external-app-server lane?
 * `runtime` is the already-normalized runtime name.
 */
export function externalAppserverRequested(
  flagPassed: boolean,
  profile: ExternalAppserverProfile,
  runtime: string,
): boolean {
  if (runtime !== "codex-app-server") return false;
  if (typeof profile.codexAppServerUrl !== "string" || !profile.codexAppServerUrl.trim()) return false;
  return flagPassed || profile.codexLaunchLayout === EXTERNAL_APPSERVER_LAYOUT;
}

export interface ExternalAppserverPlan {
  alias: string;
  nodeDir: string;
  configPath: string;
  workspaceDir: string;
  url: string;
  host: string;
  port: number;
  readyzUrl: string;
  projectDir: string;
  /** True when config.codexProjectDir was empty and the workspace was used instead. */
  projectDirFromWorkspace: boolean;
  threadId: string;
  model: string;
  codexHome: string;
  codexBin: string;
  /** Start the `<alias>-tui` session (codexCopresence && codexThreadId). */
  tui: boolean;
  sessions: ExternalAppserverSessions;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function planExternalAppserverNode(input: {
  alias: string;
  nodeDir: string;
  workspaceDir: string;
  profile: ExternalAppserverProfile;
}): { ok: true; plan: ExternalAppserverPlan } | { ok: false; error: string } {
  const { alias, nodeDir, workspaceDir, profile } = input;
  const rawUrl = (profile.codexAppServerUrl || "").trim();
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch {
    return { ok: false, error: `codexAppServerUrl ${JSON.stringify(rawUrl)} is not a URL (expected ws://127.0.0.1:<port>)` };
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "http:") {
    return { ok: false, error: `codexAppServerUrl must be ws:// (got ${parsed.protocol}//)` };
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { ok: false, error: `codexAppServerUrl host ${parsed.hostname} is not loopback — anet can only start an app-server on this machine` };
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: `codexAppServerUrl ${rawUrl} has no explicit port` };
  }
  const envHome = profile.env && typeof profile.env.CODEX_HOME === "string" ? profile.env.CODEX_HOME.trim() : "";
  const codexHome = envHome
    || (typeof profile.codexHome === "string" && profile.codexHome.trim() ? profile.codexHome.trim() : "")
    || join(nodeDir, "codex-home");
  // An empty codexProjectDir used to become `-C ''`, and the app-server exits on it.
  const configuredProject = typeof profile.codexProjectDir === "string" ? profile.codexProjectDir.trim() : "";
  const threadId = typeof profile.codexThreadId === "string" ? profile.codexThreadId.trim() : "";
  const httpHost = parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname;
  return {
    ok: true,
    plan: {
      alias,
      nodeDir,
      configPath: join(nodeDir, "config.json"),
      workspaceDir,
      url: rawUrl,
      host: httpHost.replace(/^\[|\]$/g, ""),
      port,
      readyzUrl: `http://${httpHost}:${port}/readyz`,
      projectDir: configuredProject || workspaceDir,
      projectDirFromWorkspace: !configuredProject,
      threadId,
      model: typeof profile.model === "string" ? profile.model.trim() : "",
      codexHome,
      codexBin: typeof profile.codexBin === "string" && profile.codexBin.trim() ? profile.codexBin.trim() : "codex",
      tui: profile.codexCopresence === true && !!threadId,
      sessions: externalAppserverSessions(alias),
    },
  };
}

/** Names from `wanted` that exist in `existing` — compared as whole strings, never by tmux target rules. */
export function sessionsAlreadyPresent(existing: readonly string[], wanted: readonly string[]): string[] {
  const have = new Set(existing);
  return wanted.filter((name) => have.has(name));
}

/** `{id, name}` rows whose name equals one of `names` exactly, in the order of `names`. */
export function exactSessionRows(
  rows: readonly { id: string; name: string }[],
  names: readonly string[],
): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const name of names) for (const row of rows) if (row.name === name) out.push(row);
  return out;
}

export function parseMemAvailableBytes(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(meminfo);
  return m ? Number(m[1]) * 1024 : null;
}

export function memoryVerdict(availableBytes: number | null, force: boolean): { ok: boolean; message: string } {
  const gib = (n: number) => (n / 1024 ** 3).toFixed(1);
  if (availableBytes === null) {
    return { ok: true, message: "memory pre-check skipped: /proc/meminfo has no MemAvailable (not Linux?)" };
  }
  if (availableBytes >= MIN_MEM_AVAILABLE_BYTES) {
    return { ok: true, message: `memory pre-check: MemAvailable ${gib(availableBytes)} GiB (need ≥ ${gib(MIN_MEM_AVAILABLE_BYTES)} GiB)` };
  }
  if (force) {
    return { ok: true, message: `memory pre-check: MemAvailable ${gib(availableBytes)} GiB < ${gib(MIN_MEM_AVAILABLE_BYTES)} GiB — continuing because of --force` };
  }
  return {
    ok: false,
    message: `MemAvailable is ${gib(availableBytes)} GiB, below ${gib(MIN_MEM_AVAILABLE_BYTES)} GiB. ` +
      `Each codex node (app-server + TUI) takes about 2 GB; starting another one risks pushing the machine into OOM. ` +
      `Stop a node first, or pass --force to start anyway.`,
  };
}

function q(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

/** Load the workspace `.env` inside the session (secrets such as provider keys live there). */
function dotenvSnippet(workspaceDir: string): string {
  const p = q(join(workspaceDir, ".env"));
  return `set -a; if [ -f ${p} ]; then . ${p}; fi; set +a`;
}

/** The app-server is loopback; never send its readiness or websocket traffic to a company proxy. */
const NO_PROXY_SNIPPET =
  `export NO_PROXY="\${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost" no_proxy="\${no_proxy:+$no_proxy,}127.0.0.1,localhost"`;

/**
 * Read the node token from config.json INSIDE the session shell, into the env.
 * The value never appears in tmux's argv, the pane's start command, or any
 * process's /proc/<pid>/cmdline — only the config path does.
 */
export function tokenInSessionSnippet(configPath: string, jsRuntime: string): string {
  const js = `const c=JSON.parse(require("fs").readFileSync(process.env.ANET_EXTAPP_CONFIG,"utf8"));process.stdout.write(typeof c.token==="string"?c.token:"")`;
  return `ANET_CODEX_COMMHUB_TOKEN="$(ANET_EXTAPP_CONFIG=${q(configPath)} ${q(jsRuntime)} -e ${q(js)})"; export ANET_CODEX_COMMHUB_TOKEN; ` +
    `if [ -z "$ANET_CODEX_COMMHUB_TOKEN" ]; then echo "[anet] warning: config.json has no token; the app-server's commhub MCP will not authenticate" >&2; fi`;
}

export function appserverShellCommand(plan: ExternalAppserverPlan, jsRuntime: string): string {
  const tokenExport = tokenInSessionSnippet(plan.configPath, jsRuntime); // MUTATION-ANCHOR:token-in-session
  return [
    dotenvSnippet(plan.workspaceDir),
    NO_PROXY_SNIPPET,
    `export CODEX_HOME=${q(plan.codexHome)}`,
    tokenExport,
    `mkdir -p ${q(join(plan.nodeDir, "logs"))}`,
    `${q(plan.codexBin)} -C ${q(plan.projectDir)} app-server --listen ${q(plan.url)} 2>&1 | tee -a ${q(join(plan.nodeDir, "logs", "tmux-appserver.log"))}`,
  ].join("; ");
}

export function tuiShellCommand(plan: ExternalAppserverPlan): string {
  const model = plan.model ? ` -m ${q(plan.model)}` : "";
  return [
    dotenvSnippet(plan.workspaceDir),
    NO_PROXY_SNIPPET,
    `export CODEX_HOME=${q(plan.codexHome)}`,
    `exec ${q(plan.codexBin)} -C ${q(plan.projectDir)} resume ${q(plan.threadId)} --remote ${q(plan.url)}${model} --no-alt-screen`,
  ].join("; ");
}

export function bridgeShellCommand(plan: ExternalAppserverPlan, launch: { command: string; argsPrefix: readonly string[] }): string {
  const argv = [
    launch.command, ...launch.argsPrefix,
    "--config", plan.configPath,
    "--alias", plan.alias,
    "--runtime", "codex-app-server",
    ...(plan.model ? ["--model", plan.model] : []),
    "--log-dir", join(plan.nodeDir, "logs"),
  ];
  return [
    dotenvSnippet(plan.workspaceDir),
    NO_PROXY_SNIPPET,
    `mkdir -p ${q(join(plan.nodeDir, "logs"))}`,
    `${argv.map(q).join(" ")} 2>&1 | tee -a ${q(bridgeLogPath(plan))}`,
  ].join("; ");
}

export function bridgeLogPath(plan: { nodeDir: string }): string {
  return join(plan.nodeDir, "logs", "tmux-bridge.log");
}

/**
 * tmux `-c` for the product-started bridge (`anet node start` and
 * `restart --bridge-only`). The node directory arrives as `--config` and
 * `--log-dir`; agent-node derives NODE_DIR from that absolute config.
 * Codex's app-server and TUI are separate sessions and pin the project
 * with `-C` plus `CODEX_HOME`, so this directory is not their project.
 * A hand-started agent-node never calls this and keeps the person's cwd.
 */
export function externalAppserverBridgeCwd(
  plan: Pick<ExternalAppserverPlan, "workspaceDir" | "nodeDir">,
): string {
  // nodeDir stays on the argument so a test can point this return at it.
  return plan.workspaceDir; // external bridge cwd
}

export type ResumedVerdict =
  | { state: "match"; seen: string }
  | { state: "mismatch"; seen: string }
  | { state: "new-thread"; seen: string }
  | { state: "not-seen" }
  | { state: "no-thread-configured" };

/**
 * Did the bridge resume the configured thread? Reads only the log text written
 * since this start. agent-node prints `[codex-app-server] resumed thread <12 chars>…`
 * or `created thread <12 chars>…` (a silent new session). Registration alone
 * proves nothing about which thread the node is on.
 */
export function resumedThreadVerdict(logText: string, threadId: string): ResumedVerdict {
  if (!threadId) return { state: "no-thread-configured" };
  let last: ResumedVerdict = { state: "not-seen" };
  const re = /(resumed|created) thread:?\s+([0-9A-Za-z_-]+)/g;
  for (const m of logText.matchAll(re)) {
    const seen = m[2];
    if (m[1] === "created") { last = { state: "new-thread", seen }; continue; }
    const match = seen === threadId || (seen.length >= 8 && threadId.startsWith(seen));
    last = match ? { state: "match", seen } : { state: "mismatch", seen };
  }
  return last;
}

/** True when something is already bound to host:port (a listen attempt fails). */
export function portBusy(host: string, port: number): Promise<boolean> {
  return new Promise((resolveBusy) => {
    const srv = createServer();
    srv.once("error", (e: NodeJS.ErrnoException) => resolveBusy(e.code === "EADDRINUSE" || e.code === "EACCES"));
    srv.listen({ host, port, exclusive: true }, () => {
      const bound = (srv.address() as AddressInfo | null)?.port === port;
      srv.close(() => resolveBusy(!bound));
    });
  });
}

function readyzOnce(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolveStatus) => {
    const req = request(url, { method: "GET", timeout: timeoutMs, agent: false }, (res) => {
      res.resume();
      resolveStatus(res.statusCode ?? 0);
    });
    req.on("timeout", () => { req.destroy(); resolveStatus(0); });
    req.on("error", () => resolveStatus(0));
    req.end();
  });
}

/** Poll `/readyz` until it answers 200 or `timeoutMs` passes. */
export async function waitForReadyz(
  url: string,
  timeoutMs: number = READYZ_TIMEOUT_MS,
  intervalMs = 500,
): Promise<{ ok: boolean; status: number; waitedMs: number }> {
  const t0 = Date.now();
  let status = 0;
  for (;;) {
    status = await readyzOnce(url, 2_000);
    if (status === 200) return { ok: true, status, waitedMs: Date.now() - t0 };
    if (Date.now() - t0 >= timeoutMs) return { ok: false, status, waitedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
