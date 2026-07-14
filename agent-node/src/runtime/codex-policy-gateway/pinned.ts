// RFC-030 Wave 1B — pinned Codex binary + protocol schema fixture.
//
// Wave-0 decision: canonical = codex-app-server, binary EXACTLY 0.144.0.
// The same binary must reproduce the protocol schema bundle whose digest is
// pinned below; any version or schema mismatch fails CLOSED (gateway does
// not boot). Regenerate with:
//
//   codex app-server generate-json-schema --out <dir>
//   bun -e "import{digestSchemaBundle}from'./src/runtime/codex-policy-gateway/version-gate';console.log(digestSchemaBundle('<dir>'))"
//
// Digest algorithm (副指挥 P1-4; see version-gate.ts digestSchemaBundle):
// every file in sorted RELATIVE-path order, each framed as
// relPath ++ NUL ++ byteLength ++ NUL ++ content — rename/move and file-
// boundary sensitive, no concat ambiguity. `.json` content canonicalized
// (sorted keys) before hashing because codex's generator emits
// semantically-identical bundles with unstable key order run-to-run
// (verified against 0.144.0). Stable for a given binary, cheap at boot.

export const PINNED_CODEX_VERSION = "0.144.0";

/** `codex --version` output prefix we accept (exact match after trim). */
export const PINNED_CODEX_VERSION_LINE = `codex-cli ${PINNED_CODEX_VERSION}`;

/** Canonical sha256 of the generate-json-schema bundle (codex 0.144.0),
 *  under the P1-4 domain-separated framing above (regenerated + verified
 *  stable across two runs on 2026-07-12). */
export const PINNED_SCHEMA_SHA256 =
  "03b6fa7416bfadf8874662770f0d30ef950f4eb9b7352f033b144d1065eb839f";
