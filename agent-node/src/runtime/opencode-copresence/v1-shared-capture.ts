import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadV1HostRegistry, readPrivateV1HostFile, validatePrivateV1HostDirectory, type V1HostExpectation } from "./v1-host-registry";
import { createV1SharedReadClient, validateV1SharedBinding, type V1SharedSessionBinding } from "./v1-shared-read";
import { validateV1SessionData, type V1Checkpoint, type V1SessionData } from "./v1-checkpoint";
import { fetchOpenCodeJson } from "./http";
import { isAcceptedOpencodeVersionFor } from "../opencode-versions";
import type { PinnedOpencodeBinaryAttestation } from "../opencode-acp/binary";

export const V1_SHARED_CANDIDATE_FILE = "opencode-v1-shared-candidate.json";
const LIMIT = 64 * 1024 * 1024;
export class V1SharedCaptureError extends Error {
  readonly code = "opencode_v1_shared_capture_refused";
  constructor() { super("OpenCode V1 shared capture refused; retain original binding, data and recovery"); }
}
function refuse(): never { throw new V1SharedCaptureError(); }
export interface V1SharedCaptureSelection {
  readonly binding: V1SharedSessionBinding;
  readonly version: string;
  readonly cohortId: string;
  readonly model: string;
}
export interface V1SharedCandidate extends V1SharedCaptureSelection {
  readonly schema: 1;
  readonly purpose: "migration-candidate";
  /** An idle double read is not a write lease or final shutdown checkpoint. */
  readonly cleanShutdown: false;
  readonly savedAt: string;
  readonly dataSha256: string;
  readonly data: V1SessionData;
}
export interface CaptureV1SharedOptions {
  readonly hostRoot: string;
  readonly expectedHost: V1HostExpectation;
  readonly attestation: PinnedOpencodeBinaryAttestation;
  readonly expectedBinding: V1SharedSessionBinding;
  readonly readBinding: () => V1SharedSessionBinding;
  readonly selectedCohortId: string;
  readonly model: string;
}
const digest = (data: V1SessionData) => createHash("sha256").update(JSON.stringify(data)).digest("hex");

function validateCandidate(value: V1SharedCandidate, selected: V1SharedCaptureSelection): void {
  if (!value || value.schema !== 1 || value.purpose !== "migration-candidate" || value.cleanShutdown !== false
    || typeof value.savedAt !== "string" || !Number.isFinite(Date.parse(value.savedAt))
    || !isAcceptedOpencodeVersionFor("v1", selected.version) || value.version !== selected.version
    || !selected.cohortId || value.cohortId !== selected.cohortId
    || !/^[^/\s]+\/[^/\s]+$/.test(selected.model) || value.model !== selected.model
    || Object.keys(value).some(key => !["schema", "purpose", "cleanShutdown", "savedAt", "binding", "version", "cohortId", "model", "dataSha256", "data"].includes(key))) refuse();
  validateV1SharedBinding(selected.binding, value.binding);
  if (Object.keys(value.binding).some(key => !["networkId", "nodeId", "serverIdentity", "directory", "sessionId"].includes(key))) refuse();
  validateV1SessionData(value.data, selected.binding.sessionId);
  if (value.data.info.directory !== selected.binding.directory || value.dataSha256 !== digest(value.data)) refuse();
  const users = new Set(value.data.messages.filter(message => message.info.role === "user").map(message => message.info.id));
  for (const message of value.data.messages) {
    if (!["user", "assistant"].includes(message.info.role)
      || (message.info.role === "assistant" && (!users.has(message.info.parentID) || !message.info.time?.completed))) refuse();
  }
}

/** Read-only API primitive for an explicitly selected cooperative Host. Never
 * stops a bridge/TUI/Host, registers MCP, creates/imports a session or switches
 * a binding. The Owner must separately exclude writers before a final export. */
export async function captureV1SharedCandidate(options: CaptureV1SharedOptions): Promise<V1SharedCandidate> {
  try {
    const host = Object.freeze({ ...options.expectedHost }), binding = Object.freeze({ ...options.expectedBinding });
    const { hostRoot, attestation, readBinding, model, selectedCohortId } = options;
    if (!selectedCohortId || selectedCohortId !== host.cohortId || !/^[^/\s]+\/[^/\s]+$/.test(model)) refuse();
    const original = loadV1HostRegistry(hostRoot, host, attestation).server;
    function authority() {
      validateV1SharedBinding(binding, readBinding());
      const server = loadV1HostRegistry(hostRoot, host, attestation).server;
      if (!isDeepStrictEqual(server, original)) refuse();
      return server;
    }
    async function read(path: string) {
      const server = authority();
      const value = await fetchOpenCodeJson(server.url, server.password, path, {
        headers: { "x-opencode-directory": encodeURIComponent(binding.directory) }, redirect: "error",
      });
      authority(); return value;
    }
    async function sample(): Promise<V1SessionData> {
      const reader = createV1SharedReadClient(authority(), binding, readBinding());
      const info = await reader.readSession(); authority();
      const states = await read("/session/status");
      if (!states || typeof states !== "object" || Array.isArray(states)
        || (Object.hasOwn(states, binding.sessionId) && states[binding.sessionId]?.type !== "idle")) refuse();
      if ((await read("/config"))?.model !== model) refuse();
      const messages = await reader.readMessages(); authority();
      const after = await read("/session/status");
      if (!after || typeof after !== "object" || Array.isArray(after)
        || (Object.hasOwn(after, binding.sessionId) && after[binding.sessionId]?.type !== "idle")) refuse();
      return { info, messages };
    }
    const first = await sample(), second = await sample();
    if (!isDeepStrictEqual(first, second)) refuse();
    if ((await read("/config"))?.model !== model) refuse();
    authority();
    const value: V1SharedCandidate = { schema: 1, purpose: "migration-candidate", cleanShutdown: false,
      binding, version: host.version, cohortId: selectedCohortId, model,
      savedAt: new Date().toISOString(), dataSha256: digest(second), data: second };
    validateCandidate(value, value); return value;
  } catch { return refuse(); } // Never surface raw history, URLs or Server credentials.
}

/** Distinct format/name prevents owned-mode recovery treating a candidate as
 * final. Exclusive publication never replaces an existing recovery point. */
export function writeV1SharedCandidate(root: string, value: V1SharedCandidate): void {
  let temp: string | undefined;
  try {
    validatePrivateV1HostDirectory(root, process.getuid!()); validateCandidate(value, value);
    if (root === value.binding.directory || root.startsWith(value.binding.directory + "/")
      || value.binding.directory.startsWith(root + "/")) refuse();
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > LIMIT) refuse();
    temp = join(root, `.${V1_SHARED_CANDIDATE_FILE}.${randomBytes(16).toString("hex")}`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temp, join(root, V1_SHARED_CANDIDATE_FILE));
    const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { refuse(); }
  finally { if (temp) rmSync(temp, { force: true }); }
}

export function readV1SharedCandidate(root: string, selected: V1SharedCaptureSelection): V1SharedCandidate {
  try {
    validatePrivateV1HostDirectory(root, process.getuid!());
    const value = JSON.parse(readPrivateV1HostFile(join(root, V1_SHARED_CANDIDATE_FILE), process.getuid!(), LIMIT).toString("utf8"));
    validateCandidate(value, selected); return value;
  } catch { return refuse(); }
}

/** Explicit scratch-only conversion for the existing native importer. Caller
 * must own an offline fresh store; this API does not import into a live Host. */
export function v1SharedCandidateCheckpoint(value: V1SharedCandidate, selected: V1SharedCaptureSelection): V1Checkpoint {
  try {
    validateCandidate(value, selected);
    return { version: 1, nodeId: selected.binding.nodeId, networkId: selected.binding.networkId,
      savedAt: value.savedAt, cleanShutdown: false, data: value.data };
  } catch { return refuse(); }
}
