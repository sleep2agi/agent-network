export interface LocaleDiagnostic {
  effectiveVariable: "LC_ALL" | "LC_CTYPE" | "LANG" | null;
  effectiveValue: string | null;
  shouldWarn: boolean;
}

/**
 * Resolve the locale with the same precedence used by POSIX libc. Windows
 * does not use these variables as its process Unicode boundary, so prescribing
 * a POSIX locale there would be misleading.
 */
export function diagnoseLocale(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): LocaleDiagnostic {
  if (platform === "win32") {
    return { effectiveVariable: null, effectiveValue: null, shouldWarn: false };
  }

  for (const effectiveVariable of ["LC_ALL", "LC_CTYPE", "LANG"] as const) {
    const value = env[effectiveVariable]?.trim();
    if (!value) continue;
    return {
      effectiveVariable,
      effectiveValue: value,
      shouldWarn: !/utf-?8/i.test(value),
    };
  }

  return { effectiveVariable: null, effectiveValue: null, shouldWarn: true };
}
