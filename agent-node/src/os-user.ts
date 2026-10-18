import { userInfo } from "node:os";

export const MAX_OS_USER_LENGTH = 256;

/**
 * Validate the process identity returned by the platform API. This is not an
 * environment-variable fallback: an unavailable platform identity stays null.
 */
export function normalizeOsUser(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_OS_USER_LENGTH) return null;
  if(/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) return null;
  return normalized;
}

export function collectOsUser(
  readUserInfo: () => { username?: unknown } = userInfo,
): string | null {
  try {
    return normalizeOsUser(readUserInfo()?.username);
  } catch {
    return null;
  }
}
