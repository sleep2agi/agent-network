import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inspectOpencodeOwnedSafeLaunch } from "../opencode-acp/child-env";
import { revalidatePinnedOpencodeBinary, type PinnedOpencodeBinaryAttestation } from "../opencode-acp/binary";
import { readPrivateV1HostFile, validatePrivateV1HostDirectory } from "./v1-host-registry";
import { readV1Checkpoint } from "./v1-checkpoint";

export class V1OwnedSafeTopologyError extends Error {
  readonly code = "opencode_v1_owned_safe_topology_refused";
  constructor() { super("OpenCode V1 owned SAFE topology refused; retain original state"); }
}
function refuse(): never { throw new V1OwnedSafeTopologyError(); }
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface InspectV1OwnedSafeTopologyOptions {
  readonly sourceRoot: string;
  readonly configPath: string;
  /** Owner-selected independently of config/checkpoint; neither directory may
   * be inferred from the other. Historical configs without workdir refuse. */
  readonly source: { readonly nodeId: string; readonly networkId: string; readonly alias: string;
    readonly requestedDirectory: string; readonly nativeDirectory: string;
    readonly sessionId: string; readonly model: string };
  /** Independently selected installation, not an attestation of a live PID. */
  readonly binaryAttestation: PinnedOpencodeBinaryAttestation;
  readonly requestedSoftwareMain: string;
}

/** No spawn/write/cleanup/retention or cutover. Current-process allocation and
 * stable private files are observations, never final history or a custody lease. */
export function inspectV1OwnedSafeTopology(options: InspectV1OwnedSafeTopologyOptions) {
  try {
    const source = Object.freeze({ ...options.source });
    const { sourceRoot, configPath, binaryAttestation, requestedSoftwareMain } = options;
    const fields = ["nodeId", "networkId", "alias", "requestedDirectory", "nativeDirectory", "sessionId", "model"];
    if (Object.keys(source).length !== fields.length || Object.keys(source).some(k => !fields.includes(k))
      || fields.some(k => typeof (source as any)[k] !== "string" || !(source as any)[k])
      || !/^[^/\s]+\/[^/\s]+$/.test(source.model) || !/^[a-f0-9]{40}$/.test(requestedSoftwareMain)
      || configPath !== join(sourceRoot, "config.json")
      || (binaryAttestation.generation ?? "v1") !== "v1") refuse();
    const uid = process.getuid?.(); if (uid === undefined) refuse();
    validatePrivateV1HostDirectory(sourceRoot, uid);
    const topology = inspectOpencodeOwnedSafeLaunch(sourceRoot, source.requestedDirectory, source.nativeDirectory);
    revalidatePinnedOpencodeBinary(binaryAttestation, { forbiddenRoots: [sourceRoot,
      source.requestedDirectory, topology.launch.path] });
    const checkpointPath = join(sourceRoot, "opencode-v1-session.json");
    const configBytes = readPrivateV1HostFile(configPath, uid, 1024 * 1024);
    const checkpointBytes = readPrivateV1HostFile(checkpointPath, uid, 64 * 1024 * 1024);
    const c = JSON.parse(configBytes.toString("utf8"));
    if (!["opencode-cli", "opencode"].includes(c.runtime) || c.opencodeGeneration !== "v1"
      || c.opencodeMode !== "copresence" || c.opencodeBorrowedV1 !== undefined
      || c.flags?.opencodeUnsafeTools === true || typeof c.token !== "string" || !c.token
      || typeof c.hub !== "string" || !c.hub || c.node_id !== source.nodeId || c.network_id !== source.networkId
      || c.alias !== source.alias || c.session !== source.sessionId || c.model !== source.model
      || c.workdir !== source.requestedDirectory) refuse();
    const checkpoint = readV1Checkpoint(sourceRoot, source, source.sessionId);
    if (!checkpoint || checkpoint.data.info.directory !== source.nativeDirectory) refuse();
    for (const name of ["opencode-borrowed-v1-selection.json", "opencode-borrowed-v1-launch.json", "opencode-borrowed-v1-tui.json"])
      try { lstatSync(join(sourceRoot, name)); refuse(); } catch (error: any) { if (error?.code !== "ENOENT") refuse(); }
    if (!readPrivateV1HostFile(configPath, uid, 1024 * 1024).equals(configBytes)
      || !readPrivateV1HostFile(checkpointPath, uid, 64 * 1024 * 1024).equals(checkpointBytes)
      || !isDeepStrictEqual(topology, inspectOpencodeOwnedSafeLaunch(sourceRoot, source.requestedDirectory, source.nativeDirectory))) refuse();
    revalidatePinnedOpencodeBinary(binaryAttestation, { forbiddenRoots: [sourceRoot,
      source.requestedDirectory, topology.launch.path] });
    return Object.freeze({ schema: 1 as const, purpose: "owned-safe-v1-dual-directory-observation" as const,
      state: "observation-only" as const, custodyProven: false as const, writerExclusionProven: false as const,
      finalHistoryProven: false as const, nativeProcessVersionProven: false as const,
      modelExecutionProven: false as const, targetCohortProven: false as const, commitAllowed: false as const,
      observedAt: new Date().toISOString(), requestedSoftwareMain,
      source, topology, requestedBinaryVersion: binaryAttestation.expectedVersion,
      configSha256: sha256(configBytes), checkpointSha256: sha256(checkpointBytes),
      checkpointSavedAt: checkpoint.savedAt, checkpointCleanShutdown: checkpoint.cleanShutdown,
      requiredBeforeCommit: Object.freeze(["original Owner authority and every writer exclusion",
        "native workspace retention/custody with cleanup and unknown fault qualification",
        "actual source process version, effective model/provider/safety and independently selected target cohort",
        "final native history and exact target restoration",
        "verified main/installed software, atomic config+intent journal and all launcher refusal",
        "encrypted backups and final lossless rollback"]) });
  } catch { return refuse(); } // Do not expose config credentials or history errors.
}
