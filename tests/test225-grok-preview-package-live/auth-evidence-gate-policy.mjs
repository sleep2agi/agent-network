#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  readAndValidateAuthEvidenceDiagnostic,
  validateAuthEvidenceDiagnostic,
} from "./auth-evidence-diagnostic.mjs";

export const AUTH_EVIDENCE_GATE_CHANNELS = Object.freeze([
  "preview",
  "latest",
  "prod",
]);

// Preview carries one narrowly scoped completeness exception while A fixes
// the pinned native state inventory. The scanner emits this role only after
// credential bytes were fully scanned or an empty mode-000 file was proven
// stable. This is an exact role list, not a name pattern: adding another
// warning requires an explicit security review.
export const PREVIEW_STRUCTURE_WARNING_ROLES = Object.freeze([
  "grok_current_state_completeness",
]);

const CHANNEL_SET = new Set(AUTH_EVIDENCE_GATE_CHANNELS);
const PREVIEW_WARNING_SET = new Set(PREVIEW_STRUCTURE_WARNING_ROLES);

/**
 * Classify an already-closed scanner result for one release channel.
 *
 * The scanner and its credential matching remain authoritative and unchanged:
 * any matched storage role is fatal on every channel. Preview may warn only
 * when there are no matches and every error is the single reviewed, scan-
 * complete structural role. Unreadable/wrong-mode/racy structure keeps its
 * separate fatal role. Latest/prod accept only a fully clean scan.
 */
export function classifyAuthEvidenceGate(channel, diagnostic) {
  if (!CHANNEL_SET.has(channel)) {
    throw new TypeError("invalid auth evidence release channel");
  }
  if (!validateAuthEvidenceDiagnostic(diagnostic)) {
    throw new TypeError("invalid closed auth evidence diagnostic");
  }
  if (diagnostic.matchedRoles.length > 0) return "fatal";
  if (diagnostic.errorRoles.length === 0) return "pass";
  if (channel === "preview"
    && diagnostic.errorRoles.every((role) => PREVIEW_WARNING_SET.has(role))) {
    return "warning";
  }
  return "fatal";
}

async function cli() {
  const [command, channel, inputPath, ...extra] = process.argv.slice(2);
  if (command !== "classify" || extra.length > 0
    || typeof inputPath !== "string" || inputPath.length === 0) {
    process.exitCode = 2;
    return;
  }
  const diagnostic = readAndValidateAuthEvidenceDiagnostic(inputPath);
  if (!diagnostic) {
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${classifyAuthEvidenceGate(channel, diagnostic)}\n`);
  } catch {
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cli();
}
