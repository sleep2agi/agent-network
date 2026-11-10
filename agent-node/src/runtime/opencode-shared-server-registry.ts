import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type HostSharedOpenCodeServer = {
  opencodeSharedServerUrl: string;
  opencodeSharedServerPasswordFile: string;
  clientBinDir?: string;
};

export function readHostSharedOpenCodeServer(path: string): HostSharedOpenCodeServer | undefined {
  if (!existsSync(path)) return undefined;
  const entry = JSON.parse(readFileSync(path, "utf8"));
  if (!entry || typeof entry.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(entry.url)
    || typeof entry.passwordFile !== "string" || !isAbsolute(entry.passwordFile)) {
    throw new Error("shared_opencode_registry_invalid: expected loopback url and absolute passwordFile");
  }
  const passwordStat = statSync(entry.passwordFile);
  if (!passwordStat.isFile() || (passwordStat.mode & 0o077) !== 0) {
    throw new Error("shared_opencode_password_file_not_private");
  }
  let clientBinDir: string | undefined;
  if (entry.clientBinDir !== undefined) {
    if (typeof entry.clientBinDir !== "string" || !isAbsolute(entry.clientBinDir)
      || entry.clientBinDir.includes(":") || entry.clientBinDir.includes("\0")) {
      throw new Error("shared_opencode_client_bin_dir_invalid");
    }
    clientBinDir = resolve(entry.clientBinDir);
    const binDirStat = lstatSync(clientBinDir);
    if (!binDirStat.isDirectory() || binDirStat.isSymbolicLink() || realpathSync(clientBinDir) !== clientBinDir
      || (binDirStat.mode & 0o022) !== 0 || (process.getuid && binDirStat.uid !== process.getuid())) {
      throw new Error("shared_opencode_client_bin_dir_unsafe");
    }
  }
  return { opencodeSharedServerUrl: entry.url, opencodeSharedServerPasswordFile: entry.passwordFile,
    ...(clientBinDir ? { clientBinDir } : {}) };
}

export function withHostOpenCodeV2ClientPath<T extends { PATH?: string }>(env: T, server: HostSharedOpenCodeServer | undefined): T {
  if (!server?.clientBinDir) return env;
  return { ...env, PATH: `${server.clientBinDir}:${env.PATH ?? ""}` };
}
