import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface DaemonAnetPin {
  ANET_BIN_ABS: string;
  ANET_BIN_SHA256: string;
  ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1";
}

/**
 * Pin the canonical currently-running CLI by absolute path + content hash.
 * The daemon runtime never resolves `anet` from PATH after boot and rechecks
 * the hash before every lifecycle action.
 */
export function prepareDaemonAnetPin(input: { projectRoot: string; cliPath: string }): DaemonAnetPin {
  const source = realpathSync(resolve(input.cliPath));
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile()) throw new Error("daemon_pin_source_not_file");
  if ((sourceStat.mode & 0o022) !== 0) throw new Error("daemon_pin_source_writable_by_group_or_other");
  if ((sourceStat.mode & 0o111) === 0) throw new Error("daemon_pin_source_not_executable");
  const bytes = readFileSync(source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  void input.projectRoot; // retained in the API for future per-project policy/audit metadata
  return { ANET_BIN_ABS: source, ANET_BIN_SHA256: sha256, ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1" };
}
