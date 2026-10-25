// Byte-identical in both packages; accepted versions are independently pinned by runtime admission. Finite Linux start evidence, not ongoing
// health, Host adoption, interactive TUI readiness or a hostile-UID boundary.
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { renameOverExistingSync } from "./windows-rename-retry";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const BORROWED_LAUNCH_HEALTH = "opencode-borrowed-v1-launch.json";
export function hasBorrowedV1Intent(dir: string, config: any) {
  if (config?.opencodeBorrowedV1 !== undefined) return true;
  try { lstatSync(join(dir,"opencode-borrowed-v1-selection.json")); return true; }
  catch (error: any) { return error?.code !== "ENOENT"; }
}
function refuse(): never { throw new Error("borrowed V1 launch evidence unavailable or mismatched"); }
function privateRead(path: string, max = 1024 * 1024) {
  if (process.platform !== "linux" || realpathSync(path) !== path) refuse();
  const dir = lstatSync(dirname(path));
  if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o7777) !== 0o700) refuse();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const a = fstatSync(fd);
    if (!a.isFile() || a.nlink !== 1 || a.uid !== process.getuid?.() || (a.mode & 0o7777) !== 0o600 || a.size < 1 || a.size > max) refuse();
    const bytes = readFileSync(fd), b = lstatSync(path), c = fstatSync(fd);
    const stamp = (s: typeof a) => [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs,s.mode,s.uid,s.nlink];
    if (b.isSymbolicLink() || JSON.stringify(stamp(a)) !== JSON.stringify(stamp(b))
      || JSON.stringify(stamp(a)) !== JSON.stringify(stamp(c)) || bytes.length !== a.size) refuse();
    return { value: JSON.parse(bytes.toString("utf8")), stamp: stamp(a) };
  } finally { closeSync(fd); }
}
function fields(value: any, names: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== names.length
    || names.some(k => !Object.hasOwn(value,k))) refuse();
}
/** Read-only preflight. Runtime admission still validates the independent Host,
 * binary, original credentials, native directory/session and cooperative lease. */
export function readBorrowedLaunchConfig(configPath: string, cwd?: string) {
  const { value: c, stamp } = privateRead(configPath);
  const s = c.opencodeBorrowedV1;
  fields(s,["schema","hostRoot","expectedHost","selectedCohortId","binding"]);
  fields(s.expectedHost,["hostId","instanceId","version","cohortId"]);
  fields(s.binding,["networkId","nodeId","serverIdentity","directory","sessionId"]);
  const b = s.binding, h = s.expectedHost;
  if (c.runtime !== "opencode-cli" || c.opencodeGeneration !== "v1" || c.opencodeMode !== "copresence"
    || c.flags?.opencodeUnsafeTools === true || typeof c.token !== "string" || !c.token
    || typeof c.alias !== "string" || !c.alias || typeof c.model !== "string"
    || c.model.split("/").length !== 2 || c.model.split("/").some((v: string) => !v)
    || s.schema !== 1 || typeof s.hostRoot !== "string" || !s.hostRoot.startsWith("/")
    || typeof h.version !== "string" || !/^1\.\d+\.\d+$/.test(h.version) || s.selectedCohortId !== h.cohortId
    || [h.hostId,h.instanceId,h.cohortId,c.node_id,c.network_id,b.directory,b.sessionId].some(v => typeof v !== "string" || !v)
    || b.nodeId !== c.node_id || b.networkId !== c.network_id || b.sessionId !== c.session
    || b.serverIdentity !== `${h.hostId}:${h.instanceId}` || !/^ses_[A-Za-z0-9]+$/.test(b.sessionId)
    || realpathSync(b.directory) !== b.directory || (cwd !== undefined && b.directory !== cwd)) refuse();
  // Deliberately omit tokens, endpoints and provider environment from evidence.
  return { selection: s, alias: c.alias, model: c.model, stamp };
}
function live(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1) refuse();
  const parts = readFileSync(`/proc/${pid}/stat`,"utf8").replace(/^.*\) /s,"").trim().split(/\s+/);
  if (["Z","X","x"].includes(parts[0]) || !/^\d+$/.test(parts[19] ?? "")) refuse();
  return { pid, ticks: parts[19] };
}
export function publishBorrowedLaunchHealth(configPath: string, nonce: string) {
  if (!/^[a-f0-9-]{36}$/.test(nonce)) refuse();
  const config = readBorrowedLaunchConfig(configPath,process.cwd()), bridge = live(process.pid);
  const record = { schema: 1, mode: "borrowed-v1", nonce, writtenAt: Date.now(), config, bridge };
  const path = join(dirname(configPath),BORROWED_LAUNCH_HEALTH), tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp,JSON.stringify(record)+"\n",{flag:"wx",mode:0o600}); renameOverExistingSync(tmp,path); }
  finally { rmSync(tmp,{force:true}); }
  return () => {
    try { const current = privateRead(path,16384).value;
      if (current.nonce === nonce && current.bridge?.pid === bridge.pid && current.bridge?.ticks === bridge.ticks) rmSync(path);
    } catch { /* never delete a replaced or unprovable generation */ }
  };
}
export function inspectBorrowedLaunchHealth(configPath: string, launchedAt: number, nonce?: string) {
  try {
    const config = readBorrowedLaunchConfig(configPath), r = privateRead(join(dirname(configPath),BORROWED_LAUNCH_HEALTH),16384).value;
    if (r.schema !== 1 || r.mode !== "borrowed-v1" || !Number.isFinite(r.writtenAt) || r.writtenAt < launchedAt
      || !/^[a-f0-9-]{36}$/.test(r.nonce) || (nonce !== undefined && r.nonce !== nonce)
      || JSON.stringify(r.config) !== JSON.stringify(config) || live(r.bridge?.pid).ticks !== r.bridge?.ticks) refuse();
    const argv = readFileSync(`/proc/${r.bridge.pid}/cmdline`,"utf8").split("\0");
    if (!argv.some((v,i) => v === "--config" && argv[i+1] === configPath)
      || realpathSync(`/proc/${r.bridge.pid}/cwd`) !== config.selection.binding.directory) refuse();
    return { ok: true as const, bridgePid: r.bridge.pid as number };
  } catch { return { ok: false as const, reason: "borrowed V1 launch evidence unavailable or mismatched" }; }
}
export async function waitForBorrowedLaunchHealth(configPath: string, launchedAt: number, deadline: number, nonce?: string) {
  let health = inspectBorrowedLaunchHealth(configPath,launchedAt,nonce);
  while (!health.ok && Date.now() < deadline) {
    await new Promise(r => setTimeout(r,Math.min(50,Math.max(0,deadline-Date.now()))));
    health = inspectBorrowedLaunchHealth(configPath,launchedAt,nonce);
  }
  return health;
}
