// RFC-029 PR③ — persistent opencode-ai version pin.
//
// The default pinned version lives here as `OPENCODE_BUILTIN_PIN`
// (bumped by hand when the maintainers vet a new release). Operators
// can use `anet opencode upgrade-pin <version>` to reinstall and smoke
// the release pin. A locally-smoked DIFFERENT upstream version is not
// equivalent to the maintainer's Docker/E2E vetting, so this release
// refuses to make one effective; accepting a new version requires a
// new agent-network preview with a bumped built-in constant.
//
// The override file is per-machine and does NOT go into the repo,
// so different hosts can hold different pins during a rollout.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

/**
 * Version this branch was validated against by the maintainers.
 * Bumped when a new opencode-ai release passes the full Docker/E2E gate.
 */
export const OPENCODE_BUILTIN_PIN = "1.18.1";

/** Exact upstream remediation shared by every CLI failure path. */
export function opencodeExactInstallCommand(version = OPENCODE_BUILTIN_PIN): string {
  return `npm install -g opencode-ai@${version}`;
}

/** Preserve package-identity diagnostics while always leaving a missing or
 * untrusted install with an actionable exact-pin command. */
export function formatOpencodePackageIdentityFailure(
  expectedVersion: string,
  detail: string,
): string {
  return (
    `Expected trusted opencode-ai@${expectedVersion}; ${detail}\n` +
    `  → Install/reinstall exact: ${opencodeExactInstallCommand(expectedVersion)}`
  );
}

/** Where the per-machine override lives. Kept under `~/.anet/` so
 *  it sits next to the other anet-local state. */
export function opencodePinFilePath(homeDirOverride?: string): string {
  const home = homeDirOverride ?? homedir();
  return join(home, ".anet", "opencode-pin.json");
}

/** Shape of the override file written by `upgrade-pin`. */
export interface OpencodePinOverride {
  version: string;
  /** ISO timestamp when the smoke test passed. Presence of this
   *  field is REQUIRED for `readEffectivePin()` to trust the file —
   *  a hand-edited version without a smoke marker is refused. */
  smokePassedAt: string;
  /** Free-form note about what the smoke checked (initialize +
   *  session/new by default). Kept so a future review can tell what
   *  bar the pin actually cleared. */
  smokeNote?: string;
}

export interface EffectivePin {
  version: string;
  source: "override-file" | "builtin";
  smokePassedAt?: string;
}

/**
 * Recognize a validated override only when it records the exact built-in
 * release pin. A different locally-smoked version is deliberately ignored:
 * the lightweight ACP smoke does not replace the maintainer's full security
 * and reply-path gate. Malformed/stale files also fall back to the built-in.
 */
export function readEffectivePin(homeDirOverride?: string): EffectivePin {
  const path = opencodePinFilePath(homeDirOverride);
  if (!existsSync(path)) {
    return { version: OPENCODE_BUILTIN_PIN, source: "builtin" };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<OpencodePinOverride>;
    // Require both version AND smokePassedAt — a version without a
    // smoke marker is refused (see 通信龙 PR② PR③ flag refinement:
    // "没过 smoke 就拒写 + 报错, 别让用户 pin 到没验过的版本").
    if (parsed.version === OPENCODE_BUILTIN_PIN && typeof parsed.smokePassedAt === "string" &&
        parsed.smokePassedAt.match(/^\d{4}-\d{2}-\d{2}T/)) {
      return {
        version: parsed.version,
        source: "override-file",
        smokePassedAt: parsed.smokePassedAt,
      };
    }
    return { version: OPENCODE_BUILTIN_PIN, source: "builtin" };
  } catch {
    return { version: OPENCODE_BUILTIN_PIN, source: "builtin" };
  }
}

/**
 * Write the override — SHOULD ONLY be called after the smoke test
 * has actually passed. The command layer in `bin/cli.ts` is
 * responsible for gating this; this function does no
 * verification of its own beyond shape.
 */
export function writePinOverride(
  version: string,
  smokePassedAt: string,
  smokeNote?: string,
  homeDirOverride?: string,
): void {
  const path = opencodePinFilePath(homeDirOverride);
  mkdirSync(dirname(path), { recursive: true });
  const body: OpencodePinOverride = { version, smokePassedAt, ...(smokeNote ? { smokeNote } : {}) };
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
}
