import { userInfo } from "node:os";

const MAX_OS_USER_LENGTH = 256;

function normalizeOsUser(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_OS_USER_LENGTH) return null;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

/** Legacy channel reporter: platform identity only, with no env/path fallback. */
export function collectOsUser(
  readUserInfo: () => { username?: unknown } = userInfo,
): string | null {
  try {
    return normalizeOsUser(readUserInfo()?.username);
  } catch {
    return null;
  }
}
