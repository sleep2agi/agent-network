import { lstatSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readPrivateV1HostFile, validatePrivateV1HostDirectory, type V1HostExpectation } from "./v1-host-registry";
import { validateV1SharedBinding, type V1SharedSessionBinding } from "./v1-shared-read";
import type { V1BorrowedAdmissionOptions } from "./v1-borrowed-admission";
import { resolvePinnedOpencodeBinaryAttestation } from "../opencode-acp/binary";
import { isAcceptedOpencodeVersionFor, opencodeGenerationOfConfig } from "../opencode-versions";

export interface V1BorrowedCliContext {
  runtime: string; generation?: string; mode: unknown; configFile: string;
  networkId: string; nodeId: string; alias: string; cwd: string; stateRoot: string;
  model?: string; sessionId?: string; newSession: boolean; unsafeTools: boolean;
}
interface Selection {
  schema: 1; hostRoot: string; expectedHost: V1HostExpectation;
  selectedCohortId: string; binding: V1SharedSessionBinding;
}
export class V1BorrowedCliError extends Error {
  readonly code = "opencode_v1_borrowed_cli_refused";
  constructor(reason: string) { super(`OpenCode V1 borrowed CLI refused: ${reason}`); this.name = "V1BorrowedCliError"; }
}
function refuse(reason: string): never { throw new V1BorrowedCliError(reason); }
function object(value: any, fields: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value, k))) refuse("invalid selection fields");
}
function parse(value: any): Selection {
  object(value, ["schema", "hostRoot", "expectedHost", "selectedCohortId", "binding"]);
  object(value.expectedHost, ["hostId", "instanceId", "version", "cohortId"]);
  object(value.binding, ["networkId", "nodeId", "serverIdentity", "directory", "sessionId"]);
  if (value.schema !== 1 || typeof value.hostRoot !== "string" || !value.hostRoot.startsWith("/")
    || typeof value.selectedCohortId !== "string" || value.selectedCohortId !== value.expectedHost.cohortId
    || !isAcceptedOpencodeVersionFor("v1", value.expectedHost.version)) refuse("invalid schema/root/cohort/version");
  for (const k of ["hostId", "instanceId", "version", "cohortId"]) {
    if (typeof value.expectedHost[k] !== "string" || !value.expectedHost[k].trim()) refuse("missing independent Host expectation");
  }
  if (value.binding.serverIdentity !== `${value.expectedHost.hostId}:${value.expectedHost.instanceId}`) refuse("binding is not selected Host incarnation");
  return Object.freeze({ ...value, expectedHost: Object.freeze({ ...value.expectedHost }), binding: Object.freeze({ ...value.binding }) });
}
/** Explicit private node-config selection; never discover/adopt a Host from
 * /health, registry values, latest session or a shared provider environment. */
export function selectV1BorrowedCli(value: unknown, context: V1BorrowedCliContext) {
  const marker = join(context.stateRoot, "opencode-borrowed-v1-selection.json");
  let marked = false;
  try { lstatSync(marker); marked = true; } catch (error: any) { if (error?.code !== "ENOENT") refuse("selection marker unreadable"); }
  if (value === undefined) {
    if (marked) refuse("persisted borrowed selection requires explicit config; no owned fallback");
    return null;
  }
  if (context.runtime !== "opencode" || context.generation !== "v1" || context.mode !== "copresence"
    || context.newSession || context.unsafeTools) refuse("explicit safe V1 copresence with existing session required");
  context = Object.freeze({ ...context });
  const selected = parse(value);
  const expected: V1SharedSessionBinding = Object.freeze({ networkId: context.networkId, nodeId: context.nodeId,
    serverIdentity: `${selected.expectedHost.hostId}:${selected.expectedHost.instanceId}`, directory: context.cwd,
    sessionId: context.sessionId ?? "" });
  validateV1SharedBinding(expected, selected.binding);
  if (!context.model || context.model.split("/").length !== 2 || context.model.split("/").some(x => !x)) refuse("explicit provider/model required");
  const uid = process.getuid?.();
  if (uid === undefined || !context.configFile || dirname(context.configFile) !== context.stateRoot) refuse("private node config required");
  validatePrivateV1HostDirectory(context.stateRoot, uid);
  let frozenHubToken: string | undefined;
  function readBinding() {
    let config: any;
    try { config = JSON.parse(readPrivateV1HostFile(context.configFile, uid!, 1024 * 1024).toString("utf8")); }
    catch { return refuse("private node config unreadable"); }
    const current = parse(config.opencodeBorrowedV1);
    if (typeof config.token !== "string" || !config.token || (frozenHubToken !== undefined && config.token !== frozenHubToken)) refuse("original node Hub credential changed or missing");
    frozenHubToken ??= config.token;
    if (!["opencode-cli", "opencode"].includes(config.runtime) || opencodeGenerationOfConfig(config) !== "v1"
      || config.node_id !== context.nodeId || config.network_id !== context.networkId || config.alias !== context.alias
      || config.session !== context.sessionId || config.model !== context.model || config.opencodeMode !== "copresence"
      || config.flags?.opencodeUnsafeTools === true) refuse("node identity/session/model selection changed");
    if (current.hostRoot !== selected.hostRoot || current.selectedCohortId !== selected.selectedCohortId
      || ["hostId", "instanceId", "version", "cohortId"].some(k => current.expectedHost[k as keyof V1HostExpectation] !== selected.expectedHost[k as keyof V1HostExpectation])) refuse("Host selection changed");
    validateV1SharedBinding(expected, current.binding);
    return current.binding;
  }
  readBinding();
  if (!marked) {
    try { writeFileSync(marker, JSON.stringify(selected) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error: any) { if (error?.code !== "EEXIST") refuse("cannot retain selected borrowed intent"); }
  }
  // Persists across clean close and config self-heal; switching back to owned
  // is an explicit migration, not automatic removal of this selection record.
  let recorded: Selection;
  try { recorded = parse(JSON.parse(readPrivateV1HostFile(marker, uid, 16384).toString("utf8"))); }
  catch { return refuse("selection marker unreadable"); }
  validateV1SharedBinding(expected, recorded.binding);
  if (recorded.hostRoot !== selected.hostRoot || recorded.selectedCohortId !== selected.selectedCohortId
    || ["hostId", "instanceId", "version", "cohortId"].some(k => recorded.expectedHost[k as keyof V1HostExpectation] !== selected.expectedHost[k as keyof V1HostExpectation])) refuse("persisted Host selection differs");
  return Object.freeze({ selected, readBinding, matchesHubCredential: (token: string) => token === frozenHubToken, context: Object.freeze({ ...context }) });
}
export function borrowedV1CliAdmission(selection: NonNullable<ReturnType<typeof selectV1BorrowedCli>>,
  credentials: { hubMcpUrl: string; hubToken: string; binary?: string; binarySearchPath?: string; expectedVersion?: string }): V1BorrowedAdmissionOptions {
  const { selected, context, readBinding } = selection;
  if (credentials.expectedVersion && credentials.expectedVersion !== selected.expectedHost.version) refuse("launch version differs from selected Host");
  if (!credentials.hubToken || !selection.matchesHubCredential(credentials.hubToken)) refuse("original private node Hub credential required");
  const attestation = resolvePinnedOpencodeBinaryAttestation({ requestedBinary: credentials.binary,
    searchPath: credentials.binarySearchPath, expectedVersion: selected.expectedHost.version,
    probeEnv: { PATH: credentials.binarySearchPath ?? process.env.PATH, HOME: process.env.HOME, OPENCODE_DISABLE_AUTOUPDATE: "1" },
    probeCwd: context.cwd, forbiddenRoots: [context.cwd, context.stateRoot, selected.hostRoot] });
  const [providerID, modelID] = context.model!.split("/");
  return { mode: "borrowed-v1", hostRoot: selected.hostRoot, expectedHost: selected.expectedHost, attestation,
    expectedBinding: selected.binding, readBinding, selectedCohortId: selected.selectedCohortId,
    model: { providerID, modelID }, stateRoot: context.stateRoot, alias: context.alias,
    hubMcpUrl: credentials.hubMcpUrl, hubToken: credentials.hubToken };
}
