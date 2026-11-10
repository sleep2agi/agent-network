// #1324 unit controls: every reason, plus a positive that is proven by an
// EQUALITY between two independently obtained facts (process exe identity vs the
// package/file attestation), with the swap/PID-reuse re-check in place.
import { describe, expect, test } from "bun:test";
import type { PinnedOpencodeBinaryAttestation } from "./opencode-acp/binary.js";
import type { HostSharedProcessEvidence } from "./opencode-host-shared-observer.js";
import {
  bindHostSharedServeGeneration,
  looksLikeInterpreter,
  type ExeIdentity,
  type HostSharedGenerationDeps,
} from "./opencode-host-shared-generation.js";

const evidence: HostSharedProcessEvidence = {
  url: "http://127.0.0.1:4096",
  host: "127.0.0.1",
  port: 4096,
  listenInode: "4242",
  pid: 777,
  uid: 1000,
  startTicks: 900,
  diagnostics: {
    executable: "/usr/lib/opencode/bin/opencode",
    executableSource: "proc_exe",
    socketUid: 1000,
    argvTail: ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
    argvContract: "v2",
    argvContractNote: "diagnostic only",
  },
};

const attestedExe: ExeIdentity = { path: "/usr/lib/opencode/bin/opencode", dev: "2049", ino: "424242", size: "1234" };

function attestation(over: Partial<PinnedOpencodeBinaryAttestation> = {}): PinnedOpencodeBinaryAttestation {
  return {
    binary: "/usr/lib/opencode/bin/opencode",
    packageJson: "/usr/lib/opencode/package.json",
    expectedVersion: "2.0.22",
    generation: "v2",
    binaryFile: { dev: "2049", ino: "424242", size: 1234, sha256: "a".repeat(64) },
    packageJsonFile: { dev: "2049", ino: "424243", size: 99, sha256: "b".repeat(64) },
    ...over,
  } as PinnedOpencodeBinaryAttestation;
}

function deps(over: Partial<HostSharedGenerationDeps> = {}): HostSharedGenerationDeps {
  const base: HostSharedGenerationDeps = {
    platform: "linux",
    procExeIdentity: () => attestedExe,
    liveTicks: () => "900",
    attest: () => attestation(),
    revalidate: () => {},
    statBinary: () => ({ dev: "2049", ino: "424242", size: "1234" }),
    reobserve: () => ({
      ok: true,
      processEvidence: { ...evidence },
    }),
  };
  return { ...base, ...over };
}

describe("#1324 generation binding: fail-closed reasons", () => {
  test("a proven match yields generation v2 with the full proof", () => {
    const r = bindHostSharedServeGeneration(evidence, "v2", deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.generation).toBe("v2");
    expect(r.proof).toMatchObject({
      binaryPath: "/usr/lib/opencode/bin/opencode", dev: "2049", ino: "424242", size: "1234",
      packageName: "@opencode/cli", packageVersion: "2.0.22",
      pid: 777, startTicks: 900, listenInode: "4242",
    });
    expect(r.proof.sha256).toBe("a".repeat(64));
  });

  test("non-Linux is never bound", () => {
    expect(bindHostSharedServeGeneration(evidence, "v2", deps({ platform: "darwin" })))
      .toEqual({ ok: false, reason: "unsupported_platform" });
  });

  test("an interpreter/wrapper exe cannot prove the script", () => {
    for (const path of ["/usr/local/bin/bun", "/usr/bin/node", "/usr/bin/env", "/bin/bash"]) {
      const r = bindHostSharedServeGeneration(evidence, "v2", deps({ procExeIdentity: () => ({ ...attestedExe, path }) }));
      expect(r).toEqual({ ok: false, reason: "interpreter_or_wrapper_exe" });
    }
    expect(looksLikeInterpreter("/usr/local/bin/bun")).toBe(true);
    expect(looksLikeInterpreter("/usr/lib/opencode/bin/opencode")).toBe(false);
  });

  test("permission/absent exe is a refusal, never a guess", () => {
    expect(bindHostSharedServeGeneration(evidence, "v2", deps({ procExeIdentity: () => "permission_denied" })))
      .toEqual({ ok: false, reason: "permission_denied" });
    expect(bindHostSharedServeGeneration(evidence, "v2", deps({ procExeIdentity: () => undefined })))
      .toEqual({ ok: false, reason: "exe_unreadable" });
  });

  test("a V1 binary asked as v2 (or any non-matching file) is an identity mismatch", () => {
    // Same argv, different inode: exactly the same-argv fake/V1 shape.
    const r = bindHostSharedServeGeneration(evidence, "v2", deps({
      procExeIdentity: () => ({ ...attestedExe, path: "/usr/lib/opencode-v1/bin/opencode", ino: "999999" }),
    }));
    expect(r).toEqual({ ok: false, reason: "executable_identity_mismatch" });
  });

  test("attestation unavailability is reported, not substituted with the caller's expectation", () => {
    const r = bindHostSharedServeGeneration(evidence, "v2", deps({
      attest: () => { throw new Error("no accepted install"); },
    }));
    expect(r).toEqual({ ok: false, reason: "attestation_unavailable" });
  });

  test("a file swapped after attestation fails revalidation", () => {
    const r = bindHostSharedServeGeneration(evidence, "v2", deps({
      revalidate: () => { throw new Error("binary changed after version probe"); },
    }));
    expect(r).toEqual({ ok: false, reason: "file_changed_since_attestation" });
  });

  test("an exec behind the same pid/startTicks is caught by the second exe read", () => {
    // A process can exec a different binary without changing pid or startTicks:
    // only the re-read of /proc/<pid>/exe (dev/ino/size) can see that.
    let calls = 0;
    const r = bindHostSharedServeGeneration(evidence, "v2", deps({
      procExeIdentity: () => (calls++ === 0 ? attestedExe : { ...attestedExe, path: "/usr/lib/opencode/bin/opencode-v2b", ino: "424299" }),
    }));
    expect(r).toEqual({ ok: false, reason: "observation_drift" });
  });

  test("pid/startTicks drift between the two checks refuses (PID reuse cannot pass)", () => {
    let ticks = 0;
    const driftTicks = bindHostSharedServeGeneration(evidence, "v2", deps({
      liveTicks: () => (ticks++ === 0 ? "900" : "901"),
    }));
    expect(driftTicks).toEqual({ ok: false, reason: "observation_drift" });

    let exeCalls = 0;
    const driftExe = bindHostSharedServeGeneration(evidence, "v2", deps({
      procExeIdentity: () => (exeCalls++ === 0 ? attestedExe : { ...attestedExe, ino: "424299" }),
    }));
    expect(driftExe).toEqual({ ok: false, reason: "observation_drift" });
  });

  // #1324 review P1-1: a real V1 attestation must not be relabelled as v2.
  test("the attestation's OWN generation must equal the requested one", () => {
    const r = bindHostSharedServeGeneration(evidence, "v2", deps({ attest: () => attestation({ generation: "v1", expectedVersion: "1.18.34" } as any) }));
    expect(r).toEqual({ ok: false, reason: "generation_contract_mismatch" });
    // A version that is not accepted for the requested generation is the same class.
    const bad = bindHostSharedServeGeneration(evidence, "v2", deps({ attest: () => attestation({ expectedVersion: "1.18.34" } as any) }));
    expect(bad).toEqual({ ok: false, reason: "generation_contract_mismatch" });
  });

  // #1324 review P1-3: the attestation side must be exact too (an inode above
  // MAX_SAFE_INTEGER can be rounded by a numbers-based attestation).
  test("a rounded attestation identity is refused, and exact >2^53 inodes still bind", () => {
    const rounded = bindHostSharedServeGeneration(evidence, "v2", deps({
      statBinary: () => ({ dev: "2049", ino: "9007199254740993", size: "1234" }),
      attest: () => attestation({ binaryFile: { dev: "2049", ino: "9007199254740992", size: 1234, sha256: "a".repeat(64) } } as any),
    }));
    expect(rounded).toEqual({ ok: false, reason: "attestation_identity_imprecise" });

    const exact = bindHostSharedServeGeneration(evidence, "v2", deps({
      procExeIdentity: () => ({ ...attestedExe, ino: "9007199254740993" }),
      statBinary: () => ({ dev: "2049", ino: "9007199254740993", size: "1234" }),
      attest: () => attestation({ binaryFile: { dev: "2049", ino: "9007199254740993", size: 1234, sha256: "a".repeat(64) } } as any),
    }));
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(exact.proof.ino).toBe("9007199254740993");
    expect(exact.proof.size).toBe("1234"); // exact string, never Number()
  });

  // #1324 review P1-2: the listener binding is re-observed, not copied.
  test("a fabricated or drifted listener binding is refused on re-observation", () => {
    const fabricated = bindHostSharedServeGeneration({ ...evidence, listenInode: "0" }, "v2", deps());
    expect(fabricated).toEqual({ ok: false, reason: "observation_drift" });

    const movedPid = bindHostSharedServeGeneration(evidence, "v2", deps({
      reobserve: () => ({ ok: true, processEvidence: { ...evidence, pid: 4242 } }),
    }));
    expect(movedPid).toEqual({ ok: false, reason: "observation_drift" });

    const gone = bindHostSharedServeGeneration(evidence, "v2", deps({ reobserve: () => ({ ok: false }) }));
    expect(gone).toEqual({ ok: false, reason: "observation_drift" });
  });

  test("the process start ticks must match the observation before anything is attested", () => {
    const r = bindHostSharedServeGeneration(evidence, "v2", deps({ liveTicks: () => "1234" }));
    expect(r).toEqual({ ok: false, reason: "observation_drift" });
  });

  test("a valid v1 request is bound as v1 (the adapter is not v2-only)", () => {
    const v1 = attestation({ binary: "/usr/lib/opencode-ai/bin/opencode", expectedVersion: "1.18.34", generation: "v1",
      binaryFile: { dev: "2049", ino: "555555", size: 10, sha256: "c".repeat(64) } } as any);
    const r = bindHostSharedServeGeneration(evidence, "v1", deps({
      attest: () => v1,
      procExeIdentity: () => ({ path: "/usr/lib/opencode-ai/bin/opencode", dev: "2049", ino: "555555", size: "10" }),
      statBinary: () => ({ dev: "2049", ino: "555555", size: "10" }),
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.generation).toBe("v1");
    expect(r.proof.packageName).toBe("opencode-ai");
    expect(r.proof.packageVersion).toBe("1.18.34");
  });
});
