// #1293 — host-shared OpenCode server ADMISSION GUARD.
//
// Decides whether a node may BORROW a host-shared OpenCode server (the one
// registered as `.anet/opencode-shared-server.json` and started by the host
// desktop, i.e. the PR #2776 `host shared registry → create default-selects
// shared` path) instead of spawning its own server.
//
// Scope — deliberately NOT the node-identity gate. Node identity/isolation is
// carried by each workspace's MCP credential and session binding, so this guard
// does NOT require an equal node id or alias: any node on the host may borrow
// the same host-shared server. What it does require is that the server is a
// genuine, live, same-uid, same-generation LOOPBACK server.
//
// PURE DECISION ONLY. No spawn, no signal, no credential read, and — by design —
// no file read: the observations are supplied by the caller. The host shared
// registry is read by the existing private-file reader
// (`readHostSharedOpenCodeServer`), so this module introduces no second registry
// and no second file-trust surface.
//
// The admitted facts (loopback url, same uid, live pid + startTicks, generation)
// must come from ACTUAL observation. The admitted url shape is exactly
// `http://127.0.0.1:<port>` — the only form the host registry writes.
// The shared registry does NOT carry pid,
// startTicks, uid or generation, so a caller must not fabricate them from the
// registry record: a missing/unobservable required fact falls back to spawning a
// fresh server. Reuse is never approved on the strength of an on-disk record.
//
// Every path FAILS CLOSED: any refusal, missing observation, absent or throwing
// probe, or malformed record is a fallback rather than a reuse.

/** One observed host-shared serve this host may borrow. */
export interface HostSharedServerObservation {
  /** Observed loopback URL of the running serve (http://127.0.0.1:PORT). */
  url: unknown;
  /** Observed owning uid of the serve process (same-uid requirement). */
  uid: unknown;
  /** Observed pid of the serve process. */
  pid: unknown;
  /** Observed process start ticks — the only defense against PID reuse. */
  startTicks: unknown;
  /** Observed generation of the running serve. */
  generation: unknown;
}

/** The admitted server, narrowed to the fields callers act on. */
export interface HostSharedServer {
  url: string;
  uid: number;
  pid: number;
  startTicks: number;
  generation: "v1" | "v2";
}

export interface HostSharedServerAdmissionInput {
  /** Daemon uid; a serve owned by another uid is refused. */
  uid: number;
  /** Generation the target node requires; a mismatch is refused. */
  generation: "v1" | "v2";
  /**
   * Observations of running host-shared serves. The caller must obtain these
   * from ACTUAL runtime observation (registry url + live process inspection);
   * this module does not read or trust a registry record by itself, and never
   * invents facts the registry does not carry.
   */
  observations: readonly (HostSharedServerObservation | null | undefined)[];
  /** opt-in flag: "off" preserves today's always-spawn behaviour verbatim. */
  mode?: "host-shared" | "off";
  /**
   * Live process identity probe. REQUIRED for admission — it must observe that
   * `pid` is alive AND still the same process as `startTicks`. It is never
   * defaulted to "alive": a missing probe is a fallback, and a throwing probe is
   * caught and treated as a fallback so this function never escapes by throwing.
   */
  probeAlive?: (pid: number, startTicks: number) => boolean;
}

export interface HostSharedServerAdmission {
  decision: "admit" | "fallback";
  /** Machine-readable reason; also the audit field for the launch evidence. */
  reason: string;
  /** Admitted server when decision === "admit". */
  server?: HostSharedServer;
}

/** Loopback only: borrowing must never target a routable address.
 *
 * Only the production-supported **literal** `http://127.0.0.1:<port>` is admitted
 * (通信牛, #2777 review): the host registry only ever writes that form, so
 * accepting `localhost` / `[::1]` would widen the guard past anything the host can
 * produce — `localhost` additionally depends on resolver/hosts state.
 *
 * The check is on the RAW string, not on a parsed URL: `new URL()` normalizes
 * `http://127.1:4096`, integer/hex addresses and trailing path/query/fragment into
 * `127.0.0.1`, so a parsed-host comparison accepts spellings the registry never
 * writes (same defect 通信牛 found in the #1313 provider).
 *
 * A loopback host in any other shape is still reported separately
 * (`unsupported_loopback`) so the audit reason distinguishes it from a routable
 * address. */
export type ServeUrlClass = "supported" | "unsupported_loopback" | "not_loopback";

/** The exact production endpoint: lowercase http, literal 127.0.0.1, a decimal
 *  port with no leading zero and no path/query/fragment/credentials. */
const SUPPORTED_SERVE_URL_RE = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function classifyServeUrl(url: unknown): ServeUrlClass {
  if (typeof url !== "string") return "not_loopback";
  const literal = SUPPORTED_SERVE_URL_RE.exec(url);
  if (literal) {
    const port = Number(literal[1]);
    if (Number.isSafeInteger(port) && port > 0 && port <= 65535) return "supported";
  }
  // Right host, wrong literal endpoint: bad/out-of-range port, path, query,
  // fragment, credentials, uppercase scheme — still "loopback but unsupported"
  // rather than a routable address, so the audit reason stays informative.
  if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://127.0.0.1")) {
    return "unsupported_loopback";
  }
  // Otherwise classify by *host* only to choose the audit reason.
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "not_loopback"; }
  const isLoopbackHost = LOOPBACK_HOSTNAMES.has(parsed.hostname) || /^127\./.test(parsed.hostname);
  return isLoopbackHost ? "unsupported_loopback" : "not_loopback";
}

export function isSupportedServeUrl(url: unknown): url is string {
  return classifyServeUrl(url) === "supported";
}

function normalizeUid(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * Pure decision. Never throws: any malformed observation is a fallback with a
 * reason, so a broken or hostile observation list can never turn into an unsafe
 * borrow.
 */
export function decideHostSharedServerAdmission(
  input: HostSharedServerAdmissionInput,
): HostSharedServerAdmission {
  if ((input.mode ?? "host-shared") === "off") {
    return { decision: "fallback", reason: "host_shared_off" };
  }
  const records = input.observations
    .filter((o): o is HostSharedServerObservation => !!o && typeof o === "object");
  if (records.length === 0) return { decision: "fallback", reason: "no_candidate" };
  // Fail closed without an observation path: admission is never approved on the
  // strength of an on-disk/registered record alone.
  const probe = input.probeAlive;
  if (typeof probe !== "function") return { decision: "fallback", reason: "probe_unavailable" };

  const reasons: string[] = [];
  for (const observed of records) {
    const refused = refuseObservation(input, observed, probe);
    if (typeof refused === "string") { reasons.push(refused); continue; }
    return { decision: "admit", reason: "host_shared_live", server: refused };
  }
  // Surface the most specific refusal so logs stay actionable.
  return { decision: "fallback", reason: reasons[0] ?? "no_candidate" };
}

function refuseObservation(
  input: HostSharedServerAdmissionInput,
  observed: HostSharedServerObservation,
  probe: (pid: number, startTicks: number) => boolean,
): string | HostSharedServer {
  // Only `http://127.0.0.1:<port>` is admitted. Loopback in an unsupported shape
  // (localhost / [::1] / 127.x / credentials / https) gets its own reason so the
  // audit field says what was actually wrong, not lumped in with a routable
  // address (#2777 review).
  if (!isSupportedServeUrl(observed.url)) {
    return classifyServeUrl(observed.url) === "unsupported_loopback"
      ? "host_not_127_0_0_1" : "not_loopback";
  }
  if (observed.generation !== input.generation) return "generation_mismatch";
  const uid = normalizeUid(observed.uid);
  if (uid === null || uid !== input.uid) return "foreign_uid";
  if (typeof observed.pid !== "number" || !Number.isFinite(observed.pid) || observed.pid <= 0) {
    return "missing_pid";
  }
  const { pid } = observed;
  const startTicks = observed.startTicks;
  if (typeof startTicks !== "number" || !Number.isFinite(startTicks)) return "missing_start_ticks";
  let alive: boolean;
  try {
    alive = probe(pid, startTicks);
  } catch {
    return "probe_error";
  }
  if (alive !== true) return "not_live";
  return { url: observed.url, uid, pid, startTicks, generation: input.generation };
}
