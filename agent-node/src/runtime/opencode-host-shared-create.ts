// #1326: compose the existing evidence providers before a create request may
// copy host-shared connection fields. The registry supplies a candidate, never
// process identity or a generation. Refusal leaves the child on its own server.
import { prepareOpencodeNodeForProfileWrite } from "../shared/opencode-preset.js";
import { OPENCODE_V2_BACKEND } from "./opencode-backend.js";
import {
  discardUnspawnedOpencodeChildEnv,
  revalidateOpencodeChildLaunch,
} from "./opencode-acp/child-env.js";
import { discoverOpencodeForbiddenRoots } from "./opencode-acp/binary.js";
import { observeHostSharedServe, makeHostSharedAliveProbe } from "./opencode-host-shared-observer.js";
import { bindHostSharedServeGeneration } from "./opencode-host-shared-generation.js";
import { decideHostSharedServerAdmission } from "./opencode-server-reuse.js";
import type { HostSharedOpenCodeServer } from "./opencode-shared-server-registry.js";

type ConnectionFields = Pick<HostSharedOpenCodeServer,
  "opencodeSharedServerUrl" | "opencodeSharedServerPasswordFile">;
export type HostSharedCreateSelection =
  | { decision: "admit"; reason: string; fields: ConnectionFields; pid: number; port: number }
  | { decision: "fallback"; reason: string; fields?: never; pid?: number; port?: number };

/** Prepares private node directories and a disposable probe root; selection
 * therefore has filesystem side effects, even if admission later falls back. */
export function selectHostSharedOpenCodeForCreate(opts: {
  candidate?: HostSharedOpenCodeServer;
  nodeDir: string;
  projectDir: string;
  searchPath: string;
  newServer?: boolean;
}): HostSharedCreateSelection {
  if (opts.newServer === true) return { decision: "fallback", reason: "explicit_new_server" };
  if (!opts.candidate) return { decision: "fallback", reason: "no_candidate" };
  const uid = process.getuid?.();
  if (uid === undefined) return { decision: "fallback", reason: "uid_unavailable" };
  const observed = observeHostSharedServe(opts.candidate.opencodeSharedServerUrl);
  if (!observed.ok) return { decision: "fallback", reason: `observe_${observed.reason}` };
  const evidence = observed.processEvidence;
  const fallback = (reason: string): HostSharedCreateSelection => ({
    decision: "fallback", reason, pid: evidence.pid, port: evidence.port,
  });
  // Do not execute even a credential-free probe on behalf of a foreign owner.
  if (evidence.uid !== uid) return fallback("foreign_uid");
  try {
    prepareOpencodeNodeForProfileWrite(opts.nodeDir);
    const forbiddenRoots = [opts.nodeDir, ...discoverOpencodeForbiddenRoots(opts.projectDir)];
    const backend = OPENCODE_V2_BACKEND;
    const probeEnv = backend.buildChildEnv({
      workDir: opts.nodeDir, cwd: opts.projectDir, unsafeTools: false,
      credentialMode: "probe", managedPolicyMode: "redirect-only",
      parentEnv: { PATH: opts.searchPath },
    });
    let bound: ReturnType<typeof bindHostSharedServeGeneration>;
    let discarded = false;
    try {
      const probeCwd = revalidateOpencodeChildLaunch(opts.nodeDir, probeEnv);
      bound = bindHostSharedServeGeneration(evidence, "v2", {
        attest: () => backend.resolveBinary({
          searchPath: opts.searchPath, probeEnv, probeCwd, forbiddenRoots,
        }),
        revalidate: (attestation) => { backend.revalidateBinary(attestation, { forbiddenRoots }); },
      });
    } finally {
      discarded = discardUnspawnedOpencodeChildEnv(opts.nodeDir, probeEnv);
    }
    if (!discarded) return fallback("probe_cleanup_failed");
    if (!bound.ok) return fallback(`generation_${bound.reason}`);
    const admission = decideHostSharedServerAdmission({
      uid, generation: "v2",
      // The binder proves this generation from attestation/version/exe identity
      // and re-observation; never replace it with the requested generation.
      observations: [{ ...evidence, generation: bound.generation }],
      probeAlive: makeHostSharedAliveProbe(),
    });
    if (admission.decision !== "admit" || !admission.server) return fallback(admission.reason);
    return {
      decision: "admit", reason: admission.reason, pid: admission.server.pid, port: evidence.port,
      fields: {
        opencodeSharedServerUrl: admission.server.url,
        opencodeSharedServerPasswordFile: opts.candidate.opencodeSharedServerPasswordFile,
      },
    };
  } catch {
    // No exception may promote a disk record to an admitted connection.
    return fallback("probe_unavailable");
  }
}
