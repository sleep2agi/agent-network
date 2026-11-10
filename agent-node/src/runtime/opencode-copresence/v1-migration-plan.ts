import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readV1Checkpoint, verifyV1ImportedHistory } from "./v1-checkpoint";
import { captureV1SharedCandidate, type CaptureV1SharedOptions } from "./v1-shared-capture";
import { loadV1HostRegistry, readPrivateV1HostFile, validatePrivateV1HostDirectory } from "./v1-host-registry";
import { validateV1SharedBinding } from "./v1-shared-read";
import { revalidatePinnedOpencodeBinary, type PinnedOpencodeBinaryAttestation } from "../opencode-acp/binary";
import { fetchOpenCodeJson } from "./http";
import { OPENCODE_DEFAULT_DISABLED_TOOLS } from "../../shared/opencode-preset";

export class V1MigrationPlanError extends Error {
  readonly code = "opencode_v1_migration_plan_refused";
  constructor() { super("OpenCode V1 migration plan refused; retain source, target, binding and recovery"); }
}
function refuse(): never { throw new V1MigrationPlanError(); }
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface PrepareV1MigrationPlanOptions {
  readonly sourceRoot: string;
  readonly configPath: string;
  /** Independent original Owner expectation; never adopted from config. */
  readonly source: { readonly networkId: string; readonly nodeId: string; readonly alias: string;
    readonly directory: string; readonly sessionId: string; readonly model: string };
  readonly sourceAttestation: PinnedOpencodeBinaryAttestation;
  readonly target: Omit<CaptureV1SharedOptions, "model">;
  /** Requested matching software pin, not proof of main ancestry/installation. */
  readonly requestedSoftwareMain: string;
}

/** Read-only proposal. A stable existing source checkpoint is not a final
 * live export, writer exclusion, approval, transaction journal or commit. */
export async function prepareV1MigrationPlan(options: PrepareV1MigrationPlanOptions) {
  try {
    const source = Object.freeze({ ...options.source });
    const host = Object.freeze({ ...options.target.expectedHost });
    const binding = Object.freeze({ ...options.target.expectedBinding });
    const { sourceRoot, configPath, sourceAttestation, requestedSoftwareMain } = options;
    const target = Object.freeze({ ...options.target, expectedHost: host, expectedBinding: binding, model: source.model });
    const uid = process.getuid?.();
    const exactFields = (value: object, names: string[]) => Object.keys(value).length === names.length
      && Object.keys(value).every(k => names.includes(k));
    if (!exactFields(source, ["networkId", "nodeId", "alias", "directory", "sessionId", "model"])
      || !exactFields(host, ["hostId", "instanceId", "version", "cohortId"])) refuse();
    if (uid === undefined || dirname(configPath) !== sourceRoot || configPath !== join(sourceRoot, "config.json")
      || !/^[a-f0-9]{40}$/.test(requestedSoftwareMain) || !/^[^/\s]+\/[^/\s]+$/.test(source.model)
      || !source.alias || (sourceAttestation.generation ?? "v1") !== "v1"
      || sourceAttestation.expectedVersion !== host.version) refuse();
    validatePrivateV1HostDirectory(sourceRoot, uid);
    const expected = { networkId: source.networkId, nodeId: source.nodeId,
      serverIdentity: `${host.hostId}:${host.instanceId}`, directory: source.directory, sessionId: source.sessionId };
    validateV1SharedBinding(expected, binding);
    const fields = ["networkId", "nodeId", "serverIdentity", "directory", "sessionId"];
    if (Object.keys(binding).length !== fields.length || Object.keys(binding).some(k => !fields.includes(k))) refuse();
    revalidatePinnedOpencodeBinary(sourceAttestation, { expectedVersion: host.version,
      forbiddenRoots: [sourceRoot, source.directory, target.hostRoot] });
    function absent(path: string) {
      try { lstatSync(path); refuse(); } catch (error: any) { if (error?.code !== "ENOENT") refuse(); }
    }
    function noIntentOrLease() {
      for (const name of ["opencode-borrowed-v1-selection.json", "opencode-borrowed-v1-launch.json", "opencode-borrowed-v1-tui.json"])
        absent(join(sourceRoot, name));
      absent(join(source.directory, ".anet-v1-mcp.lock"));
    }
    const checkpointPath = join(sourceRoot, "opencode-v1-session.json");
    const configBytes = readPrivateV1HostFile(configPath, uid, 1024 * 1024);
    const checkpointBytes = readPrivateV1HostFile(checkpointPath, uid, 64 * 1024 * 1024);
    function sourceSnapshot() {
      noIntentOrLease();
      if (!readPrivateV1HostFile(configPath, uid!, 1024 * 1024).equals(configBytes)
        || !readPrivateV1HostFile(checkpointPath, uid!, 64 * 1024 * 1024).equals(checkpointBytes)) refuse();
      const c = JSON.parse(configBytes.toString("utf8"));
      if (!["opencode-cli", "opencode"].includes(c.runtime) || c.opencodeGeneration !== "v1" || c.opencodeMode !== "copresence"
        || c.opencodeBorrowedV1 !== undefined || c.flags?.opencodeUnsafeTools === true
        || typeof c.token !== "string" || !c.token || typeof c.hub !== "string" || !c.hub
        || c.node_id !== source.nodeId || c.network_id !== source.networkId || c.alias !== source.alias
        || c.session !== source.sessionId || c.model !== source.model
        || (c.workdir !== undefined && c.workdir !== source.directory)) refuse();
      const checkpoint = readV1Checkpoint(sourceRoot, source, source.sessionId);
      if (!checkpoint || checkpoint.data.info.directory !== source.directory) refuse();
      return checkpoint;
    }
    const original = sourceSnapshot();
    const server = loadV1HostRegistry(target.hostRoot, host, target.attestation).server;
    async function policy() {
      sourceSnapshot(); validateV1SharedBinding(binding, target.readBinding());
      if (!isDeepStrictEqual(loadV1HostRegistry(target.hostRoot, host, target.attestation).server, server)) refuse();
      const read = (path: string) => fetchOpenCodeJson(server.url, server.password, path, {
        headers: { "x-opencode-directory": encodeURIComponent(binding.directory) }, redirect: "error",
      });
      const config = await read("/config"), mcp = await read("/mcp");
      if (config?.model !== source.model || config.permission?.["commhub_*"] !== "allow"
        || config.permission?.["*"] === "deny" || config.permission?.external_directory !== "deny"
        || !mcp || typeof mcp !== "object" || Array.isArray(mcp)) refuse();
      for (const tool of OPENCODE_DEFAULT_DISABLED_TOOLS)
        if (config.tools?.[tool] !== false || config.permission?.[tool] !== "deny") refuse();
      for (const [name, state] of Object.entries(mcp) as [string, any][])
        if ((name === "commhub" || name.startsWith("commhub_")) && state?.status !== "disabled") refuse();
      sourceSnapshot(); validateV1SharedBinding(binding, target.readBinding());
      if (!isDeepStrictEqual(loadV1HostRegistry(target.hostRoot, host, target.attestation).server, server)) refuse();
    }
    await policy();
    const candidate = await captureV1SharedCandidate(target);
    verifyV1ImportedHistory(original, candidate.data);
    await policy();
    revalidatePinnedOpencodeBinary(sourceAttestation, { expectedVersion: host.version,
      forbiddenRoots: [sourceRoot, source.directory, target.hostRoot] });
    // These fingerprints describe observed private source bytes, not a lock or
    // permission to commit. No config credentials or history body are returned.
    return Object.freeze({ schema: 1 as const, purpose: "owned-to-borrowed-v1-review-plan" as const,
      state: "proposal-only" as const, finalCheckpointProven: false as const, writerExclusionProven: false as const,
      preparedAt: new Date().toISOString(), requestedSoftwareMain,
      source: Object.freeze({ ...source, version: sourceAttestation.expectedVersion, configPath,
        configSha256: digest(configBytes), checkpointSha256: digest(checkpointBytes),
        checkpointSavedAt: original.savedAt, checkpointCleanShutdown: original.cleanShutdown }),
      target: Object.freeze({ schema: 1 as const, hostRoot: target.hostRoot, expectedHost: host,
        selectedCohortId: target.selectedCohortId, binding }),
      targetDataSha256: candidate.dataSha256,
      requiredBeforeCommit: Object.freeze(["Owner named idle maintenance window and all writer exclusion",
        "verified final source checkpoint and target history",
        "fresh main ancestry, actual matching software and original credentials",
        "atomic config/intent journal with restart refusal and fault recovery",
        "retained encrypted backups and final lossless rollback authority"]) });
  } catch { return refuse(); } // Never propagate raw native/config/history errors.
}
