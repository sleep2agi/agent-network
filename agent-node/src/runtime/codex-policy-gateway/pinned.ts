// RFC-030 Wave 1B — pinned Codex binary + protocol schema fixture.
//
// Wave-0 decision: canonical = codex-app-server, binary EXACTLY 0.144.0.
// The same binary must reproduce the protocol schema bundle whose digest is
// pinned below; any version or schema mismatch fails CLOSED (gateway does
// not boot). Regenerate with:
//
//   codex app-server generate-json-schema --out <dir>
//   find <dir> -type f | sort | xargs cat | sha256sum
//
// Digest is over the concatenation of every file in the bundle in sorted
// path order — stable for a given binary, cheap to verify at boot.

export const PINNED_CODEX_VERSION = "0.144.0";

/** `codex --version` output prefix we accept (exact match after trim). */
export const PINNED_CODEX_VERSION_LINE = `codex-cli ${PINNED_CODEX_VERSION}`;

/** sha256 of the sorted-concat of the generate-json-schema bundle (0.144.0). */
export const PINNED_SCHEMA_SHA256 =
  "40519b0f0784302ca4888edbb4a34204a8a0c0fa284b3f1750cfe2a4453c99ae";
