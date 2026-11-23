import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { modeIsJudgeable } from "../shared/posix-modes";
import { assertPrivateFile } from "../shared/private-file";

export type HostSharedOpenCodeServer = {
  opencodeSharedServerUrl: string;
  opencodeSharedServerPasswordFile: string;
  clientBinDir?: string;
};

export function readHostSharedOpenCodeServer(path: string): HostSharedOpenCodeServer | undefined {
  if (!existsSync(path)) return undefined;
  let entry: any;
  // Windows PowerShell 5.1 writes UTF-8 files with a byte-order mark; JSON.parse rejects it.
  try { entry = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }
  catch { throw new Error("shared_opencode_registry_invalid: the file is not valid JSON"); }
  if (!entry || typeof entry.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(entry.url)
    || typeof entry.passwordFile !== "string" || !isAbsolute(entry.passwordFile)) {
    throw new Error("shared_opencode_registry_invalid: expected loopback url and absolute passwordFile");
  }
  // Mode bits on POSIX, the access list on Windows (shared/private-file.ts).
  assertPrivateFile(entry.passwordFile, "shared_opencode_password_file_not_private");
  let clientBinDir: string | undefined;
  if (entry.clientBinDir !== undefined) {
    if (typeof entry.clientBinDir !== "string" || !isAbsolute(entry.clientBinDir)
      // The directory is prepended to PATH: it must not contain the PATH separator (":" on POSIX,
      // ";" on Windows, where every absolute path has a drive colon).
      || entry.clientBinDir.includes(delimiter) || entry.clientBinDir.includes("\0")) {
      throw new Error("shared_opencode_client_bin_dir_invalid");
    }
    clientBinDir = resolve(entry.clientBinDir);
    const binDirStat = lstatSync(clientBinDir);
    // Mode bits and uid mean nothing on Windows (see shared/posix-modes.ts); there the directory is
    // only required to be a real directory, and drive-letter case does not make it a different path.
    const sameDir = modeIsJudgeable() ? realpathSync(clientBinDir) === clientBinDir
      : realpathSync(clientBinDir).toLowerCase() === clientBinDir.toLowerCase();
    if (!binDirStat.isDirectory() || binDirStat.isSymbolicLink() || !sameDir
      || (modeIsJudgeable() && ((binDirStat.mode & 0o022) !== 0 || (process.getuid && binDirStat.uid !== process.getuid())))) {
      throw new Error("shared_opencode_client_bin_dir_unsafe");
    }
  }
  return { opencodeSharedServerUrl: entry.url, opencodeSharedServerPasswordFile: entry.passwordFile,
    ...(clientBinDir ? { clientBinDir } : {}) };
}

export function withHostOpenCodeV2ClientPath<T extends { PATH?: string }>(env: T, server: HostSharedOpenCodeServer | undefined): T {
  if (!server?.clientBinDir) return env;
  return { ...env, PATH: `${server.clientBinDir}${delimiter}${env.PATH ?? ""}` };
}
