import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readlinkSync, openSync, closeSync, fstatSync, lstatSync, statSync, readFileSync, realpathSync, constants } from "node:fs";
import { join, dirname } from "node:path";
import { readHostSharedOpenCodeServer } from "../opencode-shared-server-registry";
import { observeHostSharedServe } from "../opencode-host-shared-observer";

// Local TEST-ONLY artifact, not a stock release or a production trust list.
const TEST_BUILD_SHA256 = "1cf5fcccf345438316db82d4c63c5df5f5010cc94a8465e1a119f9639c53c786";
export const TEST_BUILD_VERSION = "2.0.22-anet-test.29040e2";

export async function acceptsSharedVersion(url: string, info: { version?: string; pid?: number }, testOnly: boolean) {
  if (info?.version === "2.0.22") return true;
  const evidence = testOnly && typeof info?.version === "string" && await observeSharedTestBuild(url, info.version);
  return !!evidence && evidence.pid === info.pid;
}

function privateJson(path: string) {
  if (realpathSync(path) !== path) throw Error("shared_variant_authority_refused");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size > 65536 || (s.mode & 0o077) || s.uid !== process.getuid?.()) throw Error("shared_variant_authority_refused");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

/** A private profile carries only a reference, never an authorization proof.
 * Trust boundary: existing local operator files (not malicious same-UID code).
 * Re-read the registry and independent operator policy on every variant access. */
export function sharedVariantAuthorized(configPath: string, directory: string, url: string, password: string, sessionId: string, serverPid: number): boolean {
  try {
    const c = privateJson(configPath), a = c.sharedVariantAuthority;
    if (!a || c.runtime !== "opencode-cli" || c.opencodeGeneration !== "v2" || c.opencodeMode !== "copresence"
      || c.flags?.opencodeUnsafeTools !== true || c.sessionId !== sessionId || !/^ses_[A-Za-z0-9]+$/.test(sessionId)
      || c.opencodeSharedServerUrl !== url || c.sourceDelivery?.expected_version !== TEST_BUILD_VERSION
      || c.sourceDelivery?.resume_only !== true || c.sourceDelivery.server_pid !== serverPid || realpathSync(directory) !== directory
      || configPath !== join(directory, ".anet", "nodes", dirname(configPath).split("/").at(-1)!, "config.json")) return false;
    const claim = privateJson(join(dirname(configPath), "source-delivery-claim.json"));
    if (claim.session_id !== sessionId || claim.child_node_id !== c.node_id || claim.delivery_id !== c.sourceDelivery.delivery_id
      || claim.execution_id !== c.sourceDelivery.execution_id || c.network_id !== a.network_id) return false;
    for (const dir of [join(a.home, ".anet"), join(a.daemonWorkDir, ".anet")]) {
      const s = lstatSync(dir); if (!s.isDirectory() || realpathSync(dir) !== dir || (s.mode & 0o077) || s.uid !== process.getuid?.()) return false;
    }
    const registryPath = join(a.home, ".anet", "opencode-shared-server.json");
    privateJson(registryPath);
    const endpoint = readHostSharedOpenCodeServer(registryPath);
    if (!endpoint || endpoint.opencodeSharedServerUrl !== url) return false;
    // The registry reader validates its private file; also check password via
    // the same no-follow/private-owner boundary without persisting any proof.
    const fd = openSync(endpoint.opencodeSharedServerPasswordFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > 4096 || (s.mode & 0o077) || s.uid !== process.getuid?.()
      || readFileSync(fd, "utf8").trim() !== password) return false; } finally { closeSync(fd); }
    const policy = privateJson(join(a.daemonWorkDir, ".anet", "opencode-directory-authorities.json"));
    if (policy.version !== 1 || !Array.isArray(policy.grants)) return false;
    const matches = policy.grants.filter((g: any) => g.server_id === a.server_id && g.network_id === a.network_id && g.source_node_id === a.source_node_id);
    return matches.length === 1 && matches[0].test_only_shared_variant === true && matches[0].opencode_unsafe_tools === true
      && Array.isArray(matches[0].directories) && matches[0].directories.includes(directory);
  } catch { return false; }
}

/** Process evidence only: callers must separately authorize the private registry,
 * directory and session. This is not a delegation or a capability grant. */
export type SharedTestBuildEvidence = { pid: number; startTicks: number; listenInode: string; uid: number; executable: string; executableIdentity: string };
export async function observeSharedTestBuild(url: string, version: string, pinned?: SharedTestBuildEvidence): Promise<SharedTestBuildEvidence | undefined> {
  if (process.platform !== "linux" || version !== TEST_BUILD_VERSION || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) return undefined;
  try {
    const first = observeHostSharedServe(url);
    if (!first.ok || first.processEvidence.uid !== process.getuid?.()) return undefined;
    const p = first.processEvidence;
    const executable = readlinkSync(`/proc/${p.pid}/exe`);
    if (executable !== "/tmp/opencode/anet-4099-test-only-29040e2/cli/cli-linux-x64/bin/opencode") return undefined;
    const fileIdentity = () => { const s = statSync(`/proc/${p.pid}/exe`, { bigint: true });
      return [s.dev, s.ino, s.size, s.mode, s.mtimeNs, s.ctimeNs].join(":"); };
    const evidence = { pid: p.pid, startTicks: p.startTicks, listenInode: p.listenInode, uid: p.uid, executable, executableIdentity: fileIdentity() };
    // Only a runtime-held evidence object from the initial double hash is used
    // here, never profile-provided proof. Any file/instance change refuses.
    if (pinned) return JSON.stringify(evidence) === JSON.stringify(pinned) ? evidence : undefined;
    if (await hashLinuxExecutable(p.pid) !== TEST_BUILD_SHA256) return undefined;
    const second = observeHostSharedServe(url);
    if (!second.ok || second.processEvidence.uid !== p.uid || second.processEvidence.pid !== p.pid ||
      second.processEvidence.startTicks !== p.startTicks || second.processEvidence.listenInode !== p.listenInode ||
      readlinkSync(`/proc/${p.pid}/exe`) !== executable || await hashLinuxExecutable(p.pid) !== TEST_BUILD_SHA256
      || fileIdentity() !== evidence.executableIdentity) return undefined;
    return evidence;
  } catch { return undefined; }
}

/** Fail closed: a server-reported version or PID alone is not executable identity.
 * Only a directly spawned Linux child can be inspected; shared/unknown servers
 * remain unsupported. The caller must additionally keep the child binding live.
 */
export async function isOwnedTestBuild(input: {
  version: string;
  serverPid: number;
  childPid?: number;
  platform?: NodeJS.Platform;
  hashExecutable?: (pid: number) => Promise<string>;
}): Promise<boolean> {
  if ((input.platform ?? process.platform) !== "linux" || input.version !== TEST_BUILD_VERSION ||
      !Number.isSafeInteger(input.childPid) || input.childPid! <= 1 || input.serverPid !== input.childPid) return false;
  try {
    const digest = await (input.hashExecutable ?? hashLinuxExecutable)(input.childPid!);
    return digest === TEST_BUILD_SHA256;
  } catch { return false; }
}

async function hashLinuxExecutable(pid: number): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(`/proc/${pid}/exe`)) hash.update(chunk);
  return hash.digest("hex");
}
