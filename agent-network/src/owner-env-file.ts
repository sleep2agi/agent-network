import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "fs";
import { isAbsolute } from "path";

// NTFS 走 ACL，没有 mode 位；在 Windows 上比较 0o600 恒不成立。
// 跳过的只有模式位，symlink / nlink / 正规文件 / dev+ino 一致仍然全部生效。
const posixFileModes = process.platform !== "win32";

/** Load a reviewed owner-only env file without following a planted link. */
export function loadOwnerOnlyEnvFile(
  path: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!path) return;
  // 🔴 `startsWith("/")` 是 POSIX-only 判据；Windows 的 `C:\\Users\\...\\.env` 不满足它。
  //    实测：MCP server 被 grok spawn 后 85ms 内退出，报
  //      `error: ANET_COMMHUB_ENV_FILE must be an absolute path`
  //    而外层只看到 `handshake failed: connection closed: initialize response` ——
  //    真正的原因被吞在子进程 stderr 里，是用包装脚本落盘才看到的。
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("ANET_COMMHUB_ENV_FILE must be an absolute path");
  }
  const before = lstatSync(path);
  const uid = process.getuid?.();
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || (posixFileModes && (before.mode & 0o777) !== 0o600)
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
      || (posixFileModes && (opened.mode & 0o777) !== 0o600)
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
