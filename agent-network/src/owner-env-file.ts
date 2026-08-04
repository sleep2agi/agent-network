import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "fs";

/** Load a reviewed owner-only env file without following a planted link. */
export function loadOwnerOnlyEnvFile(
  path: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!path) return;
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error("ANET_COMMHUB_ENV_FILE must be an absolute path");
  }
  const before = lstatSync(path);
  const uid = process.getuid?.();
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || (before.mode & 0o777) !== 0o600
    || (uid !== undefined && before.uid !== uid)
  ) {
    throw new Error("ANET_COMMHUB_ENV_FILE must be an owner-only single-link regular file");
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || (opened.mode & 0o777) !== 0o600
      || (uid !== undefined && opened.uid !== uid)
    ) {
      throw new Error("ANET_COMMHUB_ENV_FILE changed during validation");
    }
    for (const line of readFileSync(fd, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!env[key]) env[key] = value;
    }
  } finally {
    closeSync(fd);
  }
}
