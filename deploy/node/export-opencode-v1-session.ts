/** Linux operator entry: GET-only capture from one already-running owned V1
 * bridge/server pair. No stops, model calls, credential copies or Hub writes. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { writeV1Checkpoint, type V1SessionData } from "../../agent-node/src/runtime/opencode-copresence/v1-checkpoint";

function refuse(reason: string): never { throw new Error(`V1 export refused: ${reason}`); }
function owned(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1) refuse("explicit live PIDs required");
  const root = `/proc/${pid}`;
  if (lstatSync(root).uid !== process.getuid?.()) refuse("process owner mismatch");
  const stat = readFileSync(join(root, "stat"), "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (["Z", "X"].includes(fields[0])) refuse("process is not live");
  return { pid, parent: Number(fields[1]), start: fields[19],
    argv: readFileSync(join(root, "cmdline"), "utf8").split("\0").filter(Boolean) };
}
function flag(argv: string[], name: string): string | undefined {
  const matches = argv.flatMap((arg, i) => arg === name ? [argv[i + 1]]
    : arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : []);
  if (matches.length !== 1 || !matches[0]) return undefined;
  return matches[0];
}
function privateConfig(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1 || stat.size > 1024 * 1024) refuse("config must be owned private regular file");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function json(bytes: Buffer): any {
  try { return JSON.parse(bytes.toString()); } catch { refuse("invalid private config JSON"); }
}
function serverAuth(pid: number) {
  // Never return this environment or include its contents in an error/report.
  const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  const value = (key: string) => env.find(entry => entry.startsWith(`${key}=`))?.slice(key.length + 1);
  const password = value("OPENCODE_SERVER_PASSWORD");
  if (!password || value("OPENCODE_SERVER_USERNAME") !== "opencode") refuse("owned server authentication missing");
  return { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    mode: value("ANET_OPENCODE_MODE") };
}

export async function exportLegacyV1Session(input: { nodeDir: string; bridgePid: number; serverPid: number }) {
  if (process.platform !== "linux") refuse("Linux process identity required");
  const nodeDir = resolve(input.nodeDir);
  if (realpathSync(nodeDir) !== nodeDir) refuse("canonical node directory required");
  const directory = lstatSync(nodeDir);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) {
    refuse("owned 0700 node directory required");
  }
  const configPath = join(nodeDir, "config.json"), before = privateConfig(configPath), config = json(before);
  const sessionId = config.session || config.resume || config.sessionId;
  if (!config.node_id || !config.network_id || !/^ses_[A-Za-z0-9]+$/.test(sessionId ?? "")
    || config.runtime !== "opencode-cli" || (config.opencodeGeneration ?? "v1") !== "v1") {
    refuse("explicit V1 node/network/session identity required");
  }
  const bridge = owned(input.bridgePid), server = owned(input.serverPid);
  const bridgeConfig = flag(bridge.argv, "--config");
  if (!bridgeConfig || resolve(bridgeConfig) !== configPath || server.parent !== bridge.pid
    || !server.argv.includes("serve") || flag(server.argv, "--hostname") !== "127.0.0.1") {
    refuse("bridge config / owned loopback server mismatch");
  }
  if (bridge.argv.includes("--new-session") || (flag(bridge.argv, "--session") && flag(bridge.argv, "--session") !== sessionId)) {
    refuse("bridge session override mismatch");
  }
  const port = flag(server.argv, "--port");
  if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) refuse("server port missing");
  const auth = serverAuth(server.pid);
  if ((config.opencodeMode ?? auth.mode) !== "copresence") refuse("copresence mode required");
  const get = async (path: string): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { authorization: auth.authorization }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) refuse("owned server read failed");
    // Do not print native response bodies (they may contain conversation data).
    try { return await res.json(); } catch { refuse("owned server returned invalid JSON"); }
  };
  const health = await get("/global/health");
  if (health.healthy !== true || !["1.18.1", "1.18.34"].includes(health.version)) refuse("unsupported native V1 version");
  const capture = async (): Promise<V1SessionData> => {
    const status = await get("/session/status");
    if (!status || typeof status !== "object" || Array.isArray(status)
      || (status[sessionId] && status[sessionId].type !== "idle")) refuse("session is busy or status unknown");
    return { info: await get(`/session/${sessionId}`), messages: await get(`/session/${sessionId}/message`) };
  };
  const first = await capture(), second = await capture();
  if (!isDeepStrictEqual(first, second) || first.info?.id !== sessionId) refuse("session changed during capture");
  const finalStatus = await get("/session/status");
  if (!finalStatus || typeof finalStatus !== "object" || Array.isArray(finalStatus)
    || (finalStatus[sessionId] && finalStatus[sessionId].type !== "idle")) refuse("session became busy");
  const same = (a: ReturnType<typeof owned>, b: ReturnType<typeof owned>) => a.start === b.start
    && a.parent === b.parent && isDeepStrictEqual(a.argv, b.argv);
  if (!same(bridge, owned(bridge.pid)) || !same(server, owned(server.pid))
    || !before.equals(privateConfig(configPath))) refuse("process/config changed during capture");
  // Live capture is NOT a clean shutdown or a lease preventing later TUI input.
  writeV1Checkpoint(nodeDir, { nodeId: config.node_id, networkId: config.network_id }, first, false, { exclusive: true });
  const saved = readFileSync(join(nodeDir, "opencode-v1-session.json"));
  return { nodeId: config.node_id, sessionId, version: health.version, messages: first.messages.length,
    sha256: createHash("sha256").update(saved).digest("hex"), cleanShutdown: false };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    const nodeDir = flag(args, "--node-dir");
    if (!nodeDir) refuse("--node-dir, --bridge-pid and --server-pid required");
    console.log(JSON.stringify(await exportLegacyV1Session({ nodeDir,
      bridgePid: Number(flag(args, "--bridge-pid")), serverPid: Number(flag(args, "--server-pid")) })));
  } catch (error) {
    // Only our fixed messages are safe. OS/fetch errors can embed paths/URLs.
    console.error(error instanceof Error && error.message.startsWith("V1 export refused:")
      ? error.message : "V1 export failed; original processes/config preserved, inspect private state locally");
    process.exitCode = 1;
  }
}
