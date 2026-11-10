import { constants, openSync, fstatSync, lstatSync, readFileSync, closeSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { revalidatePinnedOpencodeBinary, type PinnedOpencodeBinaryAttestation } from "../opencode-acp/binary";
import { isAcceptedOpencodeVersionFor } from "../opencode-versions";
import type { V1SharedServer } from "./v1-shared-read";

export interface V1HostExpectation {
  readonly hostId: string;
  readonly instanceId: string;
  readonly version: string;
  /** Owner-selected cooperative trust cohort; not proof of credential isolation. */
  readonly cohortId: string;
}

const ROOT_NAMES = Object.freeze(["home", "config", "data", "cache", "state", "managed", "runtime"] as const);
export const V1_HOST_ROOT_NAMES = ROOT_NAMES;
export { privateDirectory as validatePrivateV1HostDirectory, privateFile as readPrivateV1HostFile };
export interface V1HostRecord extends V1HostExpectation {
  readonly schema: 1;
  readonly generation: "v1";
  readonly packageName: "opencode-ai";
  readonly binary: string;
  readonly url: string;
  readonly passwordFile: string;
  readonly roots: Readonly<Record<typeof ROOT_NAMES[number], string>>;
}

export class V1HostAdmissionError extends Error {
  readonly code = "opencode_v1_host_admission_refused";
  constructor(reason: string) { super(`OpenCode V1 host admission refused: ${reason}`); this.name = "V1HostAdmissionError"; }
}
function refuse(reason: string): never { throw new V1HostAdmissionError(reason); }

function privateDirectory(path: string, uid: number): void {
  try {
    const st = lstatSync(path);
    if (isAbsolute(path) && realpathSync(path) === path && st.isDirectory()
      && st.uid === uid && (st.mode & 0o7777) === 0o700) return;
  } catch { /* Error text never includes secret-bearing record values. */ }
  refuse("unsafe private directory");
}

/** Read the checked inode, then verify the pathname still names that inode.
 * Nonblocking/no-follow rejects FIFOs and symlinks without waiting or following
 * them. Same UID peers are cooperative, not a hostile OS tenant boundary. */
function privateFile(path: string, uid: number, maxBytes: number): Buffer {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || realpathSync(path) !== path) refuse("unsafe private file path");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== uid || (before.mode & 0o7777) !== 0o600
      || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) refuse("unsafe private file");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd), current = lstatSync(path);
    if (bytes.length !== before.size || current.isSymbolicLink()
      || current.dev !== before.dev || current.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs
      || current.mode !== before.mode || current.uid !== uid || current.nlink !== 1) refuse("private file changed during read");
    return bytes;
  } catch (error) {
    if (error instanceof V1HostAdmissionError) throw error;
    return refuse("unreadable private file");
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** No spawn, write, mkdir, health-based identity adoption or automatic fallback.
 * A future supervisor must rotate instanceId on each Server incarnation and
 * supply its current expectation independently of this registry. */
export function loadV1HostRegistry(
  trustedRoot: string,
  expected: V1HostExpectation,
  attestation: PinnedOpencodeBinaryAttestation,
): { readonly record: V1HostRecord; readonly server: V1SharedServer } {
  const uid = process.getuid?.();
  if (uid === undefined || process.platform === "win32") refuse("POSIX owner/mode validation required");
  privateDirectory(trustedRoot, uid);
  let record: V1HostRecord;
  try { record = JSON.parse(privateFile(join(trustedRoot, "registry.json"), uid, 16384).toString("utf8")); }
  catch (error) { if (error instanceof V1HostAdmissionError) throw error; return refuse("invalid registry JSON"); }
  if (!record || typeof record !== "object" || Array.isArray(record) || record.schema !== 1
    || record.generation !== "v1" || record.packageName !== "opencode-ai") refuse("unsupported registry schema/generation/package");
  const fields = new Set(["schema", "generation", "packageName", "hostId", "instanceId", "version", "cohortId", "binary", "url", "passwordFile", "roots"]);
  if (Object.keys(record).some(key => !fields.has(key))) refuse("unexpected registry field");
  for (const key of ["hostId", "instanceId", "version", "cohortId"] as const) {
    if (typeof expected[key] !== "string" || !expected[key].trim() || record[key] !== expected[key]) refuse(`mismatched ${key}`);
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(record.hostId) || !/^[a-f0-9]{32}$/.test(record.instanceId)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(record.cohortId)) refuse("invalid host/instance/cohort identity");
  if (!isAcceptedOpencodeVersionFor("v1", record.version) || (attestation.generation ?? "v1") !== "v1"
    || attestation.expectedVersion !== record.version || attestation.binary !== record.binary) refuse("binary/version attestation mismatch");
  let url: URL;
  try { url = new URL(record.url); } catch { return refuse("invalid Server origin"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) refuse("unsafe Server origin");
  if (!record.roots || typeof record.roots !== "object" || Array.isArray(record.roots)) refuse("missing persistent roots");
  if (Object.keys(record.roots).some(key => !(ROOT_NAMES as readonly string[]).includes(key))) refuse("unexpected persistent root");
  for (const name of ROOT_NAMES) {
    if (record.roots[name] !== join(trustedRoot, name)) refuse("persistent root mismatch");
    privateDirectory(record.roots[name], uid);
  }
  // Keep executable/package outside all host state, not merely outside HOME.
  try { revalidatePinnedOpencodeBinary(attestation, { expectedVersion: record.version, forbiddenRoots: [trustedRoot] }); }
  catch { return refuse("binary package changed or overlaps host state"); }
  if (record.passwordFile !== join(trustedRoot, "server.password")) refuse("password file mismatch");
  const password = privateFile(record.passwordFile, uid, 65).toString("utf8");
  if (!/^[a-f0-9]{64}\n?$/.test(password)) refuse("invalid password file format");
  const roots = Object.freeze({ ...record.roots });
  const snapshot = Object.freeze({ ...record, url: url.origin, roots });
  const server = Object.freeze({ identity: `${record.hostId}:${record.instanceId}`, generation: "v1" as const,
    packageName: "opencode-ai" as const, version: record.version, url: url.origin, password: password.replace(/\n$/, "") });
  return Object.freeze({ record: snapshot, server });
}
