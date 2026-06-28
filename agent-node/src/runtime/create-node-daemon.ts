// RFC-026 v4 daemon-side — handles SSE doorbell `type: create_node`,
// pulls the request from hub, validates again (defense in depth),
// fork-exec `anet node create + start` with strict env, acks hub.
//
// Only registered/active when this agent-node's config has
// `role: "host_supervisor"`. The supervisor wrap (RFC-024 W1) keeps
// the daemon itself respawning on crash; child nodes spawned here run
// in their own processes (detached) and get their own supervisor wrap
// once they hit `anet node start`.

import { execFileSync, spawn } from "node:child_process";
import { writeFileSync, statSync, realpathSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isReservedEnvKey } from "../shared/reserved-env.js";

// ── §4.2.6 B2 — ANET_BIN install-time pin + boot 4-check ──────────
//
// Resolution order (first-match wins):
//   1. `/etc/anet-daemon/path.conf` (KEY=VALUE format; install scripts
//      write this on systemd-managed hosts)
//   2. `ANET_BIN_ABS` env var (container / dev convenience —
//      Dockerfile sets this at build time)
//
// Runtime fork ALWAYS uses the resolved path. Daemon NEVER calls
// `which anet` or any other PATH lookup. CI lint guard greps
// `execFile.*"[^/"` to enforce.

interface PathPin {
  abs: string;
  sha256?: string;
}

function readPathConf(path: string): PathPin | null {
  try {
    const buf = readFileSync(path, "utf-8");
    const out: Record<string, string> = {};
    for (const line of buf.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/);
      if (m) out[m[1]] = m[2];
    }
    if (!out.ANET_BIN_ABS) return null;
    return { abs: out.ANET_BIN_ABS, sha256: out.ANET_BIN_SHA256 };
  } catch { return null; }
}

/** §4.2.6 B2 hardened — install-time pin + 5-check (PR #299 BLOCKER #3).
 *  All five gates throw `anet_bin_unsafe_path:<reason>` and fail-fast
 *  the daemon on boot (RFC: better to lose 1 host than fork a poisoned
 *  binary). owner=root is enforced unless an explicit opt-out env var
 *  ANET_DAEMON_ALLOW_NON_ROOT_BIN=1 is set (containers/CI escape hatch
 *  for environments where the binary lives under /usr/local owned by
 *  a non-root user — must be deliberate, not silent). */
export function loadAndVerifyAnetBin(env: NodeJS.ProcessEnv = process.env): string {
  let pin: PathPin | null = null;
  const confPath = env.ANET_DAEMON_PATH_CONF || "/etc/anet-daemon/path.conf";
  pin = readPathConf(confPath);
  if (!pin && env.ANET_BIN_ABS) {
    pin = { abs: env.ANET_BIN_ABS, sha256: env.ANET_BIN_SHA256 };
  }
  if (!pin) {
    throw new Error("anet_bin_unsafe_path: no ANET_BIN_ABS resolved (neither /etc/anet-daemon/path.conf nor env)");
  }
  // ① absolute
  if (!pin.abs.startsWith("/")) {
    throw new Error(`anet_bin_unsafe_path: not absolute: ${pin.abs}`);
  }
  // ② no symlink path component (realpath equals self)
  const real = realpathSync(pin.abs);
  if (real !== pin.abs) {
    throw new Error(`anet_bin_unsafe_path: contains symlink: ${pin.abs} → ${real}`);
  }
  // ③ stat: owner=root (enforced unless explicit opt-out)
  const st = statSync(pin.abs);
  const allowNonRoot = env.ANET_DAEMON_ALLOW_NON_ROOT_BIN === "1";
  if (st.uid !== 0 && !allowNonRoot) {
    throw new Error(`anet_bin_unsafe_path: owner not root (uid=${st.uid}; set ANET_DAEMON_ALLOW_NON_ROOT_BIN=1 to bypass for non-root install)`);
  }
  // ④ not group/other writable
  if ((st.mode & 0o022) !== 0) {
    throw new Error(`anet_bin_unsafe_path: writable by group/other (mode=${(st.mode & 0o777).toString(8)})`);
  }
  // ⑤ executable
  if ((st.mode & 0o111) === 0) {
    throw new Error(`anet_bin_unsafe_path: not executable`);
  }
  // hash match install-time witness (when provided, REQUIRED to match)
  if (pin.sha256) {
    const actual = createHash("sha256").update(readFileSync(pin.abs)).digest("hex");
    if (actual !== pin.sha256) {
      throw new Error(`anet_bin_unsafe_path: sha256 mismatch (install=${pin.sha256.slice(0,8)} vs now=${actual.slice(0,8)})`);
    }
  }
  return pin.abs;
}

// Cached once at module-load time. Throws if unsafe → daemon exits.
// Lazy so unit tests can mock env without firing on import; the cli
// boot path calls this explicitly + stashes the result.
let _anetBinAbs: string | null = null;
export function getAnetBinAbs(): string {
  if (_anetBinAbs) return _anetBinAbs;
  _anetBinAbs = loadAndVerifyAnetBin();
  return _anetBinAbs;
}
export function _resetAnetBinAbsForTest(): void { _anetBinAbs = null; }

// ── §4.2.6 B1 — minimalEnv (filter + fixed-keys-last + throw-on-collision) ──
import { dirname } from "node:path";

const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const FIXED_ENV_KEYS = new Set(["PATH", "HOME", "LANG"]);

/** #301 nvm fix (issue: spawned child shebang `#!/usr/bin/env node`
 *  finds no node when daemon runs under nvm / pnpm / Bun / custom
 *  installs where node is not in SAFE_PATH). Prepend daemon's own
 *  node bin dir to PATH for spawned children.
 *
 *  Trust root: process.execPath is daemon's own already-resolved
 *  node binary path (boot-time canonicalize, attacker can't change
 *  the running process's own argv0 dirname). NOT trusting env.PATH
 *  (that's C1 attacker surface). So no C1 / PATH-poison regression:
 *  hub-side validateEnvRefs still rejects env_refs:["PATH"] /
 *  ["LD_PRELOAD"] (G7/G8 invariant unchanged) — the only thing we
 *  add is a fixed dir name that the daemon process itself defines.
 */
function computeChildPath(): string {
  const execDir = dirname(process.execPath);
  // Skip prepend if execDir is already an early SAFE_PATH entry
  // (avoid duplicate path; canonical SAFE_PATH wins).
  const safeParts = SAFE_PATH.split(":");
  if (safeParts.includes(execDir)) return SAFE_PATH;
  return `${execDir}:${SAFE_PATH}`;
}

export function minimalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (isReservedEnvKey(k)) {
      throw new Error(`minimalEnv: reserved env key ${k} reached fork (denylist gap — investigate)`);
    }
    if (FIXED_ENV_KEYS.has(k)) {
      throw new Error(`minimalEnv: fixed env key ${k} reached fork`);
    }
    filtered[k] = v;
  }
  return {
    ...filtered,
    PATH: computeChildPath(),
    HOME: process.env.HOME!,
    LANG: process.env.LANG || "C.UTF-8",
  };
}

// ── §4.2.2 daemon-side spec validators (mirror of create-node-validate) ──
// We duplicate the structural validation here so an attacker who
// compromises hub still can't smuggle a bad spec past the daemon.

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_RE = /^[a-zA-Z0-9._:\-]+$/;
const VALID_RUNTIMES = new Set(["claude-agent-sdk", "codex-sdk", "grok-build-acp"]);
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"]);

// §4.2.2 daemon-side flag VALUE validator — defense in depth, mirrors
// hub-side validateFlagValue (server/src/create-node-validate.ts). A
// compromised hub or mid-flight tampering could smuggle `maxTurns:
// "DROP TABLE"` or `dangerouslySkipPermissions: "true"` (string!) past
// hub's check; daemon catches it before the value reaches child config
// or fork argv. Per 通信牛 PR #299 BLOCKER #2.
export function validateFlagValueDaemon(k: string, v: unknown): void {
  switch (k) {
    case "permissionMode":
      if (typeof v !== "string" || !PERMISSION_MODES.has(v)) {
        throw new Error(`flag_value_invalid:${k}:must be default/acceptEdits/plan/bypassPermissions`);
      }
      return;
    case "dangerouslySkipPermissions":
      if (typeof v !== "boolean") throw new Error(`flag_value_invalid:${k}:must be boolean`);
      return;
    case "maxTurns":
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 9999) {
        throw new Error(`flag_value_invalid:${k}:must be integer 1..9999`);
      }
      return;
    case "budget":
      if (typeof v !== "number" || !Number.isFinite(v) || (v as number) < 0 || (v as number) > 1000) {
        throw new Error(`flag_value_invalid:${k}:must be number 0..1000`);
      }
      return;
    case "timeout":
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 86400) {
        throw new Error(`flag_value_invalid:${k}:must be integer 1..86400`);
      }
      return;
    default:
      throw new Error(`flag_key_unknown:${k}`);
  }
}

export interface DaemonNodeSpec {
  name: string;
  runtime: string;
  model: string;
  flags?: Record<string, unknown>;
  channels?: unknown;
}

function kebab(k: string): string { return k.replace(/([A-Z])/g, "-$1").toLowerCase(); }

export function buildAnetArgsDaemon(spec: DaemonNodeSpec): string[] {
  if (!spec.name || !NAME_RE.test(spec.name)) throw new Error("node_name_invalid");
  if (!VALID_RUNTIMES.has(spec.runtime)) throw new Error("runtime_invalid");
  if (!spec.model || spec.model.length > 100 || !MODEL_RE.test(spec.model)) throw new Error("model_invalid");
  if (Array.isArray(spec.channels) && spec.channels.length > 0) throw new Error("channels_not_supported_in_p1");
  const args: string[] = ["node", "create", spec.name, "--runtime", spec.runtime, "--model", spec.model];
  for (const [k, v] of Object.entries(spec.flags || {})) {
    if (!["permissionMode", "dangerouslySkipPermissions", "maxTurns", "budget", "timeout"].includes(k)) {
      throw new Error(`flag_key_unknown:${k}`);
    }
    // §4.2.2 daemon double-layer: defense in depth (per 通信牛 PR
    // #299 BLOCKER #2). hub already filters, but a compromised hub
    // could smuggle `maxTurns: "DROP TABLE"` etc; we type/range
    // check before String() coerces into argv.
    validateFlagValueDaemon(k, v);
    args.push(`--${kebab(k)}`, String(v));
  }
  return args;
}

// §4.4.7 — duplicate of hub serializeEnvLocal (same escape rules).
export function serializeEnvLocalDaemon(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => {
    const esc = String(v)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r");
    return `${k}="${esc}"`;
  }).join("\n") + "\n";
}

// ── §2.5 step 3 — handle SSE doorbell ──────────────────────────────
// Caller (cli.ts SSE handler) invokes this when an SSE event of
// type=create_node arrives. We pull the request from hub, run +
// wait for child, then ack.

export interface CreateNodeDeps {
  callCommHub: (tool: string, args: Record<string, unknown>) => Promise<any>;
  workDir: string;                     // §4.2.3 WORK_DIR enforced cwd
  hubUrl: string;                       // daemon propagates its hub to child via global config
  log: (msg: string) => void;
  warn: (msg: string) => void;
  serializeEnvLocal: (env: Record<string, string>) => string;
  // §4.2 belt-and-suspenders: hub already filters runtime via the
  // daemon_capabilities.allowed_runtimes snapshot, but daemon repeats
  // the check using its own config — if hub is compromised or stale,
  // daemon still refuses runtimes the host operator hasn't whitelisted.
  // null/empty = accept any in the global enum (P1 default).
  allowedRuntimes?: ReadonlyArray<string> | null;
}

/** §2.5 step 3 helper — ensure $HOME/.anet/config.json carries the
 *  daemon's hub URL so the spawned `anet node create + start` doesn't
 *  bail with `未找到 CommHub Server`. Idempotent. */
function ensureGlobalAnetConfig(home: string, hubUrl: string): void {
  const dir = join(home, ".anet");
  const path = join(dir, "config.json");
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* ok */ }
  let cur: Record<string, any> = {};
  try { cur = JSON.parse(readFileSync(path, "utf-8")); } catch { /* fresh */ }
  if (cur.hub !== hubUrl) {
    cur.hub = hubUrl;
    writeFileSync(path, JSON.stringify(cur, null, 2), { mode: 0o600 });
  }
}

interface GetCreateRequestResult {
  ok: boolean;
  error?: string;
  request_id?: string;
  node_spec?: DaemonNodeSpec;
  child_token?: string;
  env_blob?: Record<string, string>;
}

export async function handleCreateNodeDoorbell(
  event: { request_id: string },
  deps: CreateNodeDeps,
): Promise<void> {
  const { request_id } = event;
  const req: GetCreateRequestResult = await deps.callCommHub("get_create_request", { request_id });
  if (!req?.ok || !req.node_spec || !req.child_token) {
    deps.warn(`[create-node] get_create_request failed: ${req?.error || "unknown"}`);
    await deps.callCommHub("ack_create_request", {
      request_id, status: "failed", error: req?.error || "get_failed",
    }).catch(() => {});
    return;
  }

  // §4.2 daemon-side runtime allowlist fallback (belt-and-suspenders;
  // hub already enforces, this catches hub-bypass / compromised-hub).
  if (deps.allowedRuntimes && deps.allowedRuntimes.length > 0 &&
      !deps.allowedRuntimes.includes(req.node_spec.runtime)) {
    deps.warn(`[create-node] runtime '${req.node_spec.runtime}' not in daemon's allowed_runtimes: [${deps.allowedRuntimes.join(",")}]`);
    await deps.callCommHub("ack_create_request", {
      request_id, status: "rejected", error: `runtime_not_in_local_allowlist: ${req.node_spec.runtime}`,
    }).catch(() => {});
    return;
  }

  let args: string[];
  try {
    args = buildAnetArgsDaemon(req.node_spec);
  } catch (e: any) {
    deps.warn(`[create-node] spec rejected by daemon-side validate: ${e?.message || e}`);
    await deps.callCommHub("ack_create_request", {
      request_id, status: "rejected", error: `validate: ${e?.message || e}`,
    }).catch(() => {});
    return;
  }

  // Resolve anet binary (install-time pin, never PATH lookup at runtime)
  let anetBin: string;
  try {
    anetBin = getAnetBinAbs();
  } catch (e: any) {
    deps.warn(`[create-node] anet_bin_unsafe_path: ${e?.message || e}`);
    await deps.callCommHub("ack_create_request", {
      request_id, status: "failed", error: `bin: ${e?.message || e}`,
    }).catch(() => {});
    return;
  }

  // Ensure WORK_DIR exists
  try { mkdirSync(deps.workDir, { recursive: true, mode: 0o700 }); } catch { /* ok */ }

  // P1: ensure global ~/.anet/config.json has hub so `anet node start`
  // can resolve the hub even when called from minimalEnv. Idempotent.
  try { ensureGlobalAnetConfig(process.env.HOME!, deps.hubUrl); }
  catch (e: any) { deps.warn(`[create-node] global config write failed (continuing): ${e?.message || e}`); }

  // Step 1 — write child config.json directly.
  //
  // P1 simplification: we bypass `anet node create` (which requires a
  // user-login utok in global config + would mint its own ntok we'd
  // overwrite anyway). Hub already minted the child-ntok via the
  // create_node MCP tool path; we just write a minimal but complete
  // per-node config and let `anet node start` boot from it.
  //
  // The `args` array (validated by buildAnetArgsDaemon) is the source
  // of truth for runtime/model/flags — we map it back to config keys.
  // F2 security: args were already structurally validated; this map
  // is a JSON write, no shell.
  const childDir = join(deps.workDir, ".anet", "nodes", req.node_spec.name);
  try { mkdirSync(childDir, { recursive: true, mode: 0o700 }); } catch { /* ok */ }
  const childCfgPath = join(childDir, "config.json");
  const flagsObj: Record<string, unknown> = req.node_spec.flags || {};
  // Best-effort: also derive `permissionMode` etc into a `flags` block
  // for the agent-node config shape. anet-node consults config.flags +
  // flat keys; flat keys win, so we write flat for safety.
  try {
    const childCfg: Record<string, any> = {
      node_id: `node_${request_id.replace(/^cr_/, "")}`,
      node_name: req.node_spec.name,
      alias: req.node_spec.name,
      runtime: req.node_spec.runtime,
      model: req.node_spec.model,
      hub: deps.hubUrl,
      token: req.child_token,
      ...(Object.keys(flagsObj).length ? { flags: flagsObj } : {}),
    };
    writeFileSync(childCfgPath, JSON.stringify(childCfg, null, 2), { mode: 0o600 });
    deps.log(`[create-node] wrote child config: ${childCfgPath}`);
  } catch (e: any) {
    deps.warn(`[create-node] write child config failed: ${e?.message || e}`);
    await deps.callCommHub("ack_create_request", {
      request_id, status: "failed", error: `write_config: ${e?.message || e}`,
    }).catch(() => {});
    return;
  }
  void args;     // args validated; we'll use them on Phase 2 follow-up if anet node create lands an --unattended flag
  if (req.env_blob && Object.keys(req.env_blob).length > 0) {
    const envFile = join(deps.workDir, ".anet", "nodes", req.node_spec.name, ".env.local");
    try {
      writeFileSync(envFile, deps.serializeEnvLocal(req.env_blob), { mode: 0o600 });
    } catch (e: any) {
      deps.warn(`[create-node] env.local write failed: ${e?.message || e}`);
      // not fatal — proceed to start; hub will see status=succeeded but
      // child might fail on first vendor call. Acceptable for P1.
    }
  }

  // Step 3 — anet node start <name> in background (detached).
  //
  // N站马 N#19 联调 (通信龙 5149126c) — spawn hardening + immediate
  // kill-0 self-verify. Docker repro shows the chain stays alive
  // across daemon SIGTERM, but additive defenses for env-specific
  // edge cases (interactive terminal SIGHUP, inherited fd lifecycle,
  // child insta-crash post-spawn):
  //   - explicit stdio array [ignore, ignore, ignore] (no chance of
  //     ipc/inherit fd lifecycle coupling)
  //   - detached: true (Linux setsid; child becomes new session leader,
  //     immune to terminal SIGHUP + parent death by signal)
  //   - close any returned stream handles (belt — should be null
  //     under stdio:"ignore" array, harmless if not)
  //   - child.unref() removes child from this process's event loop
  //   - kill-0 self-verify: if child crashed in the few ms since spawn
  //     return, process.kill(pid, 0) throws ESRCH and we ack 'failed'
  //     rather than 'started' (catches N站马's "registered then dead"
  //     symptom if the real cause is insta-crash on first vendor call /
  //     missing API key / config issue)
  let childPid = -1;
  try {
    const child = spawn(anetBin, ["node", "start", req.node_spec.name], {
      cwd: deps.workDir,
      env: minimalEnv(),
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    childPid = child.pid || -1;
    try { child.stdin?.destroy(); } catch { /* ok */ }
    try { child.stdout?.destroy(); } catch { /* ok */ }
    try { child.stderr?.destroy(); } catch { /* ok */ }
    child.unref();
    deps.log(`[create-node] spawned child '${req.node_spec.name}' pid=${childPid}`);

    if (childPid > 0) {
      try {
        process.kill(childPid, 0);
        deps.log(`[create-node] post-spawn kill-0 verify OK: pid=${childPid} alive`);
      } catch (kerr: any) {
        const msg = `child died immediately after spawn: ${kerr?.message || kerr}`;
        deps.warn(`[create-node] ${msg}`);
        await deps.callCommHub("ack_create_request", {
          request_id, status: "failed", error: msg,
        }).catch(() => {});
        return;
      }
    }
  } catch (e: any) {
    const msg = (e?.message || String(e)).slice(0, 800);
    deps.warn(`[create-node] fork (start) failed: ${msg}`);
    await deps.callCommHub("ack_create_request", {
      request_id, status: "failed", error: `fork_start: ${msg}`,
    }).catch(() => {});
    return;
  }

  // Step 4 — ack 'started' (success path; hub flips to 'succeeded' on
  // child's first report_status content-match)
  await deps.callCommHub("ack_create_request", {
    request_id, status: "started", child_pid: childPid,
  }).catch((e: any) => deps.warn(`[create-node] ack failed: ${e?.message || e}`));
}
