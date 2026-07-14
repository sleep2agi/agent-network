// RFC-030 Stage 2 — canonical Codex executable identity.
//
// A bare executable name is resolved against one caller-supplied PATH
// snapshot, then collapsed to an absolute real path.  The real path and its
// device/inode pair are the identity used by the baseline gate, owned
// app-server provider, and production TUI launcher.  Public failures carry a
// stable code only; candidate paths and filesystem errors are never rendered.

import {
  accessSync,
  constants,
  realpathSync,
  statSync,
} from "node:fs";
import {
  delimiter,
  isAbsolute,
  resolve as resolvePath,
} from "node:path";

export const CODEX_BINARY_RESOLUTION_FAILED =
  "codex_gateway_binary_resolution_failed";
export const CODEX_BINARY_IDENTITY_MISMATCH =
  "codex_gateway_binary_identity_mismatch";

type CodexBinaryErrorCode =
  | typeof CODEX_BINARY_RESOLUTION_FAILED
  | typeof CODEX_BINARY_IDENTITY_MISMATCH;

export interface CodexBinaryIdentity {
  /** Absolute, symlink-free path selected once from the caller's PATH. */
  readonly path: string;
  /** Decimal strings preserve Node's bigint stat fields across realms/JSON. */
  readonly dev: string;
  readonly ino: string;
}

export interface ResolveCodexBinaryOptions {
  /** PATH is read from this exact environment snapshot for a bare name. */
  readonly env?: NodeJS.ProcessEnv;
  /** Base for an explicit relative path or an empty PATH component. */
  readonly cwd?: string;
}

class CodexBinaryIdentityError extends Error {
  readonly code: CodexBinaryErrorCode;

  constructor(code: CodexBinaryErrorCode) {
    super(code);
    this.name = "CodexBinaryIdentityError";
    this.code = code;
  }
}

function stableError(code: CodexBinaryErrorCode): CodexBinaryIdentityError {
  return new CodexBinaryIdentityError(code);
}

function identityAt(candidate: string): CodexBinaryIdentity {
  const path = realpathSync(candidate);
  if (!isAbsolute(path)) throw stableError(CODEX_BINARY_RESOLUTION_FAILED);
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw stableError(CODEX_BINARY_RESOLUTION_FAILED);
  accessSync(path, constants.X_OK);
  return Object.freeze({
    path,
    dev: stat.dev.toString(10),
    ino: stat.ino.toString(10),
  });
}

function snapshotPath(env: NodeJS.ProcessEnv): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(env, "PATH");
  if (descriptor === undefined || !("value" in descriptor)) return null;
  return typeof descriptor.value === "string" ? descriptor.value : null;
}

function isBareName(binary: string): boolean {
  return !binary.includes("/") &&
    (process.platform !== "win32" || !binary.includes("\\"));
}

/**
 * Resolve `binary` exactly once.  Bare names never reach exec/spawn and are
 * never re-looked-up through a potentially changed process PATH.
 */
export function resolveCodexBinaryIdentity(
  binary = "codex",
  opts: ResolveCodexBinaryOptions = {},
): CodexBinaryIdentity {
  if (typeof binary !== "string" || binary.length === 0 || binary.includes("\0")) {
    throw stableError(CODEX_BINARY_RESOLUTION_FAILED);
  }

  const cwd = opts.cwd ?? process.cwd();
  if (!isBareName(binary)) {
    try {
      return identityAt(isAbsolute(binary) ? binary : resolvePath(cwd, binary));
    } catch {
      throw stableError(CODEX_BINARY_RESOLUTION_FAILED);
    }
  }

  const pathSnapshot = snapshotPath(opts.env ?? process.env);
  if (pathSnapshot === null) throw stableError(CODEX_BINARY_RESOLUTION_FAILED);
  for (const entry of pathSnapshot.split(delimiter)) {
    const directory = entry.length === 0
      ? cwd
      : isAbsolute(entry)
        ? entry
        : resolvePath(cwd, entry);
    try {
      return identityAt(resolvePath(directory, binary));
    } catch {
      // Match executable PATH lookup: an absent/non-file/non-executable
      // candidate does not prevent a later PATH entry from being selected.
    }
  }
  throw stableError(CODEX_BINARY_RESOLUTION_FAILED);
}

function snapshotIdentity(identity: CodexBinaryIdentity): CodexBinaryIdentity {
  if (identity === null || typeof identity !== "object") {
    throw stableError(CODEX_BINARY_IDENTITY_MISMATCH);
  }
  const descriptors = Object.getOwnPropertyDescriptors(identity);
  const takeString = (key: "path" | "dev" | "ino"): string => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw stableError(CODEX_BINARY_IDENTITY_MISMATCH);
    }
    if (typeof descriptor.value !== "string" || descriptor.value.length === 0) {
      throw stableError(CODEX_BINARY_IDENTITY_MISMATCH);
    }
    return descriptor.value;
  };
  return {
    path: takeString("path"),
    dev: takeString("dev"),
    ino: takeString("ino"),
  };
}

/** Re-stat the canonical path and require the same device/inode identity. */
export function assertCodexBinaryIdentity(
  expected: CodexBinaryIdentity,
): CodexBinaryIdentity {
  const snapshot = snapshotIdentity(expected);
  if (!isAbsolute(snapshot.path)) {
    throw stableError(CODEX_BINARY_IDENTITY_MISMATCH);
  }
  try {
    const current = identityAt(snapshot.path);
    if (
      current.path !== snapshot.path ||
      current.dev !== snapshot.dev ||
      current.ino !== snapshot.ino
    ) {
      throw stableError(CODEX_BINARY_IDENTITY_MISMATCH);
    }
    // Return the one-read snapshot, not a potentially mutable/hostile input
    // object whose accessors could change after validation.
    return Object.freeze(snapshot);
  } catch {
    throw stableError(CODEX_BINARY_IDENTITY_MISMATCH);
  }
}
