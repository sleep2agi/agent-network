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
// Digest algorithm (see version-gate.ts digestSchemaBundle): every file in
// sorted path order; `.json` files canonicalized (sorted keys) before
// hashing because codex's generator emits semantically-identical bundles
// with unstable key order run-to-run (verified against 0.144.0). Stable
// for a given binary, cheap to verify at boot.

export const PINNED_CODEX_VERSION = "0.144.0";

/** `codex --version` output prefix we accept (exact match after trim). */
export const PINNED_CODEX_VERSION_LINE = `codex-cli ${PINNED_CODEX_VERSION}`;

/** Canonical sha256 of the generate-json-schema bundle (codex 0.144.0). */
export const PINNED_SCHEMA_SHA256 =
  "d75fb527849a186f03516b235386ee3b9ae3977a178e3d363b1508eeed6e9be7";
