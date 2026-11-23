import { existsSync, readFileSync } from "fs";
import { isAbsolute } from "path";

export type SharedOpenCodeServer = { url: string; passwordFile: string };

export function resolveSharedOpenCodeServer(
  opts: Record<string, string | string[] | undefined>,
  registryPath: string,
): SharedOpenCodeServer | undefined {
  const url = opts["opencode-shared-server-url"];
  const passwordFile = opts["opencode-shared-server-password-file"];
  const newServer = opts["opencode-new-server"] === "true";
  if (newServer && (url !== undefined || passwordFile !== undefined)) {
    throw new Error("--opencode-new-server cannot be combined with shared Server options");
  }
  if (newServer) return undefined;

  let selected: unknown;
  if (url !== undefined || passwordFile !== undefined) {
    selected = { url, passwordFile };
  } else if (existsSync(registryPath)) {
    // Windows PowerShell 5.1 writes UTF-8 files with a byte-order mark; JSON.parse rejects it.
    try { selected = JSON.parse(readFileSync(registryPath, "utf8").replace(/^\uFEFF/, "")); }
    catch { throw new Error(`Shared OpenCode Server registry is not valid JSON: ${registryPath}`); }
  } else {
    return undefined;
  }

  const server = selected as Partial<SharedOpenCodeServer>;
  if (!server || typeof server.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(server.url)
    || typeof server.passwordFile !== "string" || !isAbsolute(server.passwordFile)) {
    throw new Error("Shared OpenCode Server requires a loopback URL and absolute passwordFile path");
  }
  return { url: server.url, passwordFile: server.passwordFile };
}
