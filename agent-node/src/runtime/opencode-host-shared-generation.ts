// #1324 / parent #1302 — GENERATION BINDING for a host-shared OpenCode serve.
//
// #1313 gives REAL PROCESS EVIDENCE for the listener behind a literal loopback
// URL (pid/uid/startTicks/listenInode + argv as diagnostics). That evidence
// deliberately claims no generation. This adapter binds it to the generation the
// EXISTING package/file attestation in `opencode-acp/binary.ts` can actually
// prove — or answers `unavailable`, never a guess.
//
// Binding is an EQUALITY between two independently obtained facts:
//   1. the running process's executable:      /proc/<pid>/exe → {dev, ino, size}
//   2. the attested package entrypoint:       resolvePinnedOpencodeBinaryAttestation
//                                             → binaryFile {dev, ino, size, sha256}
// plus a re-count before returning (revalidate), a pid/startTicks re-check **and a
// second /proc/<pid>/exe read**, so a file swap, a PID reuse, or an `exec` that
// keeps the same PID/startTicks cannot pass.
//
// `attest()` must come from the existing credential-isolated package probe with
// an EXPLICIT probe env/cwd supplied by the caller (the resolver's `probeEnv` /
// `probeCwd`); this module constructs no environment of its own.
//
// NEVER generation evidence (they may only be reported as diagnostics elsewhere):
// a path spelling, `clientBinDir`, a file named `opencode`, `argvContract`, an
// interpreter's name, or the caller's expectation. If `/proc/<pid>/exe` is an
// interpreter/wrapper (bun, node, …) whose script cannot be proven, the answer is
// `interpreter_or_wrapper_exe`. This module never runs `--version` on an arbitrary
// /proc executable to impersonate a verified package: the package identity comes
// from the credential-isolated attestation path only.
//
// No second registry, no password-file read, no `close`/lifecycle change, no
// second server, no create-node-daemon wiring, no provider-rule change, and no
// relaxation of the observation/uid gates. Non-Linux, unreadable or ambiguous
// input is `unsupported_platform` / `permission_denied` / `observation_drift`.

import { readFileSync, readlinkSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  resolvePinnedOpencodeBinaryAttestation,
  revalidatePinnedOpencodeBinary,
  type PinnedOpencodeBinaryAttestation,
} from "./opencode-acp/binary.js";
import { isAcceptedOpencodeVersionFor, opencodeGenerationSupport } from "./opencode-versions.js";
import {
  observeHostSharedServe,
  type HostSharedProcessEvidence,
} from "./opencode-host-shared-observer.js";

export type HostSharedGenerationReason =
  | "unsupported_platform"
  | "exe_unreadable"
  | "permission_denied"
  | "interpreter_or_wrapper_exe"
  | "attestation_unavailable"
  | "executable_identity_mismatch"
  | "file_changed_since_attestation"
  | "generation_contract_mismatch"
  | "attestation_identity_imprecise"
  | "observation_drift";

export interface HostSharedGenerationProof {
  /** Attested package entrypoint the running process was proven to be. */
  binaryPath: string;
  dev: string;
  ino: string;
  /** Exact decimal size (string) — never a Number round-trip. */
  size: string;
  sha256: string;
  packageName: string;
  packageVersion: string;
  /** Listener binding carried over from the observation, re-checked here. */
  pid: number;
  startTicks: number;
  listenInode: string;
}

export type HostSharedGenerationResult =
  | { ok: true; generation: "v1" | "v2"; proof: HostSharedGenerationProof }
  | { ok: false; reason: HostSharedGenerationReason };

export interface ExeIdentity {
  path: string;
  dev: string;
  ino: string;
  /** Exact decimal size — compared as a string, never through Number(). */
  size: string;
}

export interface HostSharedGenerationDeps {
  platform?: NodeJS.Platform;
  /** /proc/<pid>/exe resolution: identity, `"permission_denied"`, or undefined. */
  procExeIdentity?: (pid: number) => ExeIdentity | "permission_denied" | undefined;
  /** Live process ticks for the pid/startTicks re-check. */
  liveTicks?: (pid: number) => string | undefined;
  /** Package/file attestation for the requested generation (throws = unavailable).
   *  REQUIRED and caller-supplied: production passes the launcher's trusted path
   *  (`requestedBinary` from its own pinned resolution) — this module never
   *  guesses a PATH or a version. */
  attest: (generation: "v1" | "v2") => PinnedOpencodeBinaryAttestation;
  /** Re-validation right before returning; must throw if the file changed.
   *  REQUIRED: the caller passes `revalidatePinnedOpencodeBinary`. */
  revalidate: (attestation: PinnedOpencodeBinaryAttestation) => void;
  /** Executables that cannot prove the script they run. */
  interpreterBasenames?: readonly string[];
  /** bigint identity of the canonical attested binary. Defaults to a real stat;
   *  the attestation's stored dev/ino strings are only trusted when they equal
   *  these exact decimal values (a numbers-based attestation can be rounded). */
  statBinary?: (path: string) => { dev: string; ino: string; size: string } | undefined;
  /** Re-observe the endpoint right before returning (defaults to the #1313
   *  observer, i.e. the same strict rules — no second, looser scanner). */
  reobserve?: (url: string) => { ok: true; processEvidence: HostSharedProcessEvidence } | { ok: false };
}

const INTERPRETERS = ["bun", "node", "nodejs", "deno", "tsx", "ts-node", "env", "sh", "bash"];

function defaultProcExeIdentity(pid: number): ExeIdentity | "permission_denied" | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    // The kernel resolves /proc/<pid>/exe to the real executable: report BOTH the
    // resolved path (so an interpreter/wrapper is recognised by its own name) and
    // the file identity that the attestation equality is built on.
    const resolved = readlinkSync(`/proc/${pid}/exe`);
    // bigint stat: dev/ino can exceed 2^53 on some filesystems, and the identity
    // comparison must be exact — never a float round-trip.
    const st = statSync(`/proc/${pid}/exe`, { bigint: true });
    if (!st.isFile()) return undefined;
    return { path: resolved, dev: st.dev.toString(), ino: st.ino.toString(), size: st.size.toString() };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM" ? "permission_denied" : undefined;
  }
}

function defaultLiveTicks(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    // Same /proc/<pid>/stat field-22 reader the launcher health check uses.
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] ?? "") ? fields[19] : undefined;
  } catch {
    return undefined;
  }
}

type ResolvedDeps = Required<Omit<HostSharedGenerationDeps, "attest" | "revalidate">>
  & Pick<HostSharedGenerationDeps, "attest" | "revalidate">;

function defaultStatBinary(path: string): { dev: string; ino: string; size: string } | undefined {
  try {
    const st = statSync(path, { bigint: true });
    if (!st.isFile()) return undefined;
    return { dev: st.dev.toString(), ino: st.ino.toString(), size: st.size.toString() };
  } catch {
    return undefined;
  }
}

function defaults(overrides: Partial<HostSharedGenerationDeps>): ResolvedDeps {
  if (typeof overrides.attest !== "function" || typeof overrides.revalidate !== "function") {
    // Fail closed at construction: without the package identity and the
    // re-validation there is nothing that could prove a generation.
    throw new Error("bindHostSharedServeGeneration requires attest() and revalidate()");
  }
  return {
    platform: overrides.platform ?? process.platform,
    procExeIdentity: overrides.procExeIdentity ?? defaultProcExeIdentity,
    liveTicks: overrides.liveTicks ?? defaultLiveTicks,
    interpreterBasenames: overrides.interpreterBasenames ?? INTERPRETERS,
    statBinary: overrides.statBinary ?? defaultStatBinary,
    reobserve: overrides.reobserve ?? ((url) => observeHostSharedServe(url)),
    attest: overrides.attest,
    revalidate: overrides.revalidate,
  };
}

/** `/proc/<pid>/exe` points at the resolved binary; use its basename to spot an
 *  interpreter BEFORE reading any other field, so we never attempt to attest a
 *  script's interpreter as if it were the package entrypoint. */
export function looksLikeInterpreter(
  exePath: string,
  interpreters: readonly string[] = INTERPRETERS,
): boolean {
  const name = basename(exePath).toLowerCase();
  return interpreters.includes(name);
}

/**
 * Bind a host-shared serve's real process to a PROVEN generation.
 *
 * `generation` is the generation the caller needs proven (the shared-server path
 * is V2 today; V1 is accepted so the caller can ask for it explicitly and get a
 * refusal rather than a silent pass). Everything fails closed.
 */
export function bindHostSharedServeGeneration(
  evidence: HostSharedProcessEvidence,
  generation: "v1" | "v2",
  overrides: Partial<HostSharedGenerationDeps>,
): HostSharedGenerationResult {
  let deps: ResolvedDeps;
  try {
    deps = defaults(overrides);
  } catch {
    return { ok: false, reason: "attestation_unavailable" };
  }
  try {
    if (deps.platform !== "linux") return { ok: false, reason: "unsupported_platform" };
    if (!Number.isSafeInteger(evidence.pid) || evidence.pid <= 0) return { ok: false, reason: "exe_unreadable" };

    const firstExe = deps.procExeIdentity(evidence.pid);
    if (firstExe === "permission_denied") return { ok: false, reason: "permission_denied" };
    if (!firstExe) return { ok: false, reason: "exe_unreadable" };
    if (looksLikeInterpreter(firstExe.path, deps.interpreterBasenames)) {
      return { ok: false, reason: "interpreter_or_wrapper_exe" };
    }
    const firstTicks = deps.liveTicks(evidence.pid);
    if (firstTicks === undefined || firstTicks !== String(evidence.startTicks)) {
      return { ok: false, reason: "observation_drift" };
    }

    let attestation: PinnedOpencodeBinaryAttestation;
    try {
      attestation = deps.attest(generation);
    } catch {
      return { ok: false, reason: "attestation_unavailable" };
    }
    // The attestation must PROVE the requested generation itself: echoing the
    // caller's parameter (while a V1 attestation was returned) would label a real
    // V1 binary as V2.
    const attestedGeneration = attestation.generation ?? "v1";
    if (attestedGeneration !== generation
      || !isAcceptedOpencodeVersionFor(generation, attestation.expectedVersion)) {
      return { ok: false, reason: "generation_contract_mismatch" };
    }
    // Exact identity of the ATTESTED binary (bigint), used as the bridge between
    // the attestation's stored strings and the running process. A numbers-based
    // attestation can carry a rounded dev/ino, so a mismatch here is a refusal —
    // never a silent pass on an unproven identity.
    const attestedBinary = deps.statBinary(attestation.binary);
    if (!attestedBinary) return { ok: false, reason: "attestation_unavailable" };
    const attested = attestation.binaryFile;
    if (String(attested.dev) !== attestedBinary.dev || String(attested.ino) !== attestedBinary.ino
      || String(attested.size) !== attestedBinary.size) {
      return { ok: false, reason: "attestation_identity_imprecise" };
    }
    if (attestedBinary.dev !== firstExe.dev || attestedBinary.ino !== firstExe.ino
      || attestedBinary.size !== firstExe.size) {
      return { ok: false, reason: "executable_identity_mismatch" };
    }

    // Re-count the file and re-check the process identity immediately before
    // returning: a swap or a PID reuse during this call must not pass.
    try {
      deps.revalidate(attestation);
    } catch {
      return { ok: false, reason: "file_changed_since_attestation" };
    }
    // Re-observe the ENDPOINT (same strict rules as #1313): the listener binding
    // must still hold, otherwise `listenInode` could be a stale or invented value.
    let reobserved: HostSharedProcessEvidence;
    try {
      const again = deps.reobserve(evidence.url);
      if (!again.ok) return { ok: false, reason: "observation_drift" };
      reobserved = again.processEvidence;
    } catch {
      return { ok: false, reason: "observation_drift" };
    }
    if (reobserved.pid !== evidence.pid || reobserved.listenInode !== evidence.listenInode
      || reobserved.uid !== evidence.uid || reobserved.startTicks !== evidence.startTicks
      || reobserved.host !== evidence.host || reobserved.port !== evidence.port) {
      return { ok: false, reason: "observation_drift" };
    }
    const secondExe = deps.procExeIdentity(evidence.pid);
    const secondTicks = deps.liveTicks(evidence.pid);
    if (secondExe === "permission_denied") return { ok: false, reason: "permission_denied" };
    if (!secondExe || secondTicks === undefined) return { ok: false, reason: "observation_drift" };
    if (secondExe.dev !== firstExe.dev || secondExe.ino !== firstExe.ino || secondExe.size !== firstExe.size
      || secondTicks !== firstTicks) {
      return { ok: false, reason: "observation_drift" };
    }

    return {
      ok: true,
      generation,
      proof: {
        binaryPath: attestation.binary,
        dev: attestedBinary.dev,
        ino: attestedBinary.ino,
        size: attestedBinary.size,
        sha256: String(attested.sha256),
        packageName: opencodeGenerationSupport(generation).packageName,
        packageVersion: attestation.expectedVersion,
        pid: evidence.pid,
        startTicks: evidence.startTicks,
        listenInode: evidence.listenInode,
      },
    };
  } catch {
    // Diagnostics-grade adapter: any unexpected failure is `unavailable`.
    return { ok: false, reason: "attestation_unavailable" };
  }
}
