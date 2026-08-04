import { readFileSync, writeFileSync } from "fs";

const path = "/workspace/agent-network/src/grok-copresence-profile.ts";
const source = readFileSync(path, "utf8");
const start = source.indexOf("export function grokCopresenceSocketPaths(");
const end = source.indexOf("\nexport function grokBuildCliCreationFields(", start);
if (start < 0 || end < 0) throw new Error("test231 mutation anchor missing");

const legacy = `export function grokCopresenceSocketPaths(
  nodeId: string,
  options: GrokSocketPathOptions = {},
): { leaderSocket: string; attachSocket: string } {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const uid = options.uid ?? process.getuid?.();
  const platform = options.platform ?? process.platform;
  const xdgRuntime = options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR;
  const key = createHash("sha256")
    .update(cwd)
    .update("\\0")
    .update(nodeId)
    .digest("hex")
    .slice(0, 16);
  const roots: string[] = [];

  if (xdgRuntime && isAbsolute(xdgRuntime) && !xdgRuntime.includes("\\0")) {
    try {
      const stat = lstatSync(xdgRuntime);
      const real = realpathSync(xdgRuntime);
      if (
        !stat.isSymbolicLink()
        && stat.isDirectory()
        && real === xdgRuntime
        && (stat.mode & 0o077) === 0
        && (uid === undefined || stat.uid === uid)
      ) roots.push(xdgRuntime);
    } catch {}
  }

  const privateTmp = platform === "darwin" ? "/private/tmp" : "/tmp";
  const ownerKey = uid === undefined
    ? createHash("sha256").update(home).digest("hex").slice(0, 8)
    : String(uid);
  roots.push(join(privateTmp, \`anet-u\${ownerKey}\`));
  for (const root of roots) {
    const runtimeDir = join(root, "g", key);
    const leaderSocket = join(runtimeDir, "l.sock");
    const attachSocket = join(runtimeDir, "a.sock");
    if (
      Buffer.byteLength(leaderSocket) <= GROK_UNIX_SOCKET_PATH_MAX_BYTES
      && Buffer.byteLength(attachSocket) <= GROK_UNIX_SOCKET_PATH_MAX_BYTES
    ) return { leaderSocket, attachSocket };
  }
  throw new Error("cannot allocate a Grok copresence socket path shorter than 100 bytes");
}
`;

writeFileSync(path, source.slice(0, start) + legacy + source.slice(end));
