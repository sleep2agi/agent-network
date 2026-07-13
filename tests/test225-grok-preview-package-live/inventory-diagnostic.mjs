#!/usr/bin/env node
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DIAGNOSTIC_PHASES = Object.freeze([
  "bootstrap",
  "fresh",
  "resume",
  "mutation_defaults",
  "mutation_read",
  "cleanup",
  "complete",
]);

export const DIAGNOSTIC_CATEGORIES = Object.freeze([
  "ok",
  "profile_invalid",
  "server_bind",
  "process_exit",
  "persistence_timeout",
  "inventory_mismatch",
  "mutation_not_observed",
  "mutation_not_red",
  "leader_cleanup",
  "internal",
  "invalid_or_missing_result",
  "diagnostic_rejected",
  "diagnostic_scan_error",
]);

const FACT_KEYS = Object.freeze([
  "totalRequests",
  "mainRequests",
  "auxiliaryRequests",
  "markerRequests",
  "nonceRequests",
  "exactMainRequests",
  "exactAuxiliaryRequests",
  "unsafeMutationRequests",
  "spawned",
  "exited",
  "leaderObserved",
  "mainRequestObserved",
  "promptNonceObserved",
  "assistantAfterNonce",
  "turnEndedAfterBaseline",
  "completedTurn",
  "exitCode",
  "signalCategory",
]);

const TOP_KEYS = Object.freeze(["category", "facts", "gate", "phase", "schemaVersion", "status"]);
const MAX_COUNT = 4096;

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function boundedInteger(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
}

export function emptyDiagnosticFacts(overrides = {}) {
  return {
    totalRequests: 0,
    mainRequests: 0,
    auxiliaryRequests: 0,
    markerRequests: 0,
    nonceRequests: 0,
    exactMainRequests: 0,
    exactAuxiliaryRequests: 0,
    unsafeMutationRequests: 0,
    spawned: false,
    exited: false,
    leaderObserved: false,
    mainRequestObserved: false,
    promptNonceObserved: false,
    assistantAfterNonce: false,
    turnEndedAfterBaseline: false,
    completedTurn: false,
    exitCode: 256,
    signalCategory: "none",
    ...overrides,
  };
}

export function makeInventoryDiagnostic({ status, phase, category, facts = {} }) {
  const diagnostic = {
    schemaVersion: 1,
    gate: "grok_tui_inventory",
    status,
    phase,
    category,
    facts: emptyDiagnosticFacts(facts),
  };
  if (!validateInventoryDiagnostic(diagnostic)) {
    throw new TypeError("invalid closed inventory diagnostic");
  }
  return diagnostic;
}

export function fallbackInventoryDiagnostic(category = "invalid_or_missing_result") {
  const allowed = new Set([
    "invalid_or_missing_result",
    "diagnostic_rejected",
    "diagnostic_scan_error",
  ]);
  return makeInventoryDiagnostic({
    status: "failed",
    phase: "bootstrap",
    category: allowed.has(category) ? category : "invalid_or_missing_result",
  });
}

export function validateInventoryDiagnostic(value) {
  if (!exactKeys(value, TOP_KEYS)) return false;
  if (value.schemaVersion !== 1 || value.gate !== "grok_tui_inventory") return false;
  if (value.status !== "passed" && value.status !== "failed") return false;
  if (!DIAGNOSTIC_PHASES.includes(value.phase)) return false;
  if (!DIAGNOSTIC_CATEGORIES.includes(value.category)) return false;
  if (!exactKeys(value.facts, FACT_KEYS)) return false;
  for (const key of FACT_KEYS.slice(0, 8)) {
    if (!boundedInteger(value.facts[key])) return false;
  }
  for (const key of FACT_KEYS.slice(8, 16)) {
    if (typeof value.facts[key] !== "boolean") return false;
  }
  if (!Number.isInteger(value.facts.exitCode)
    || value.facts.exitCode < 0 || value.facts.exitCode > 256) return false;
  if (!["none", "term", "kill", "other"].includes(value.facts.signalCategory)) return false;
  if (value.status === "passed") {
    if (value.phase !== "complete" || value.category !== "ok") return false;
    const facts = value.facts;
    if (facts.totalRequests !== facts.mainRequests + facts.auxiliaryRequests
      || facts.markerRequests !== facts.mainRequests
      || facts.nonceRequests !== facts.mainRequests
      || facts.exactAuxiliaryRequests !== facts.auxiliaryRequests
      || facts.exactMainRequests + facts.unsafeMutationRequests !== facts.mainRequests
      || facts.exactMainRequests < 2
      || facts.unsafeMutationRequests < 2
      || !facts.spawned
      || facts.exited
      || !facts.leaderObserved
      || !facts.mainRequestObserved
      || !facts.promptNonceObserved
      || !facts.assistantAfterNonce
      || !facts.turnEndedAfterBaseline
      || !facts.completedTurn
      || facts.exitCode !== 256
      || facts.signalCategory !== "none") return false;
  } else if (value.phase === "complete" || value.category === "ok") {
    return false;
  }
  return true;
}

export function writeInventoryDiagnosticAtomic(outputPath, diagnostic) {
  if (!validateInventoryDiagnostic(diagnostic)) {
    throw new TypeError("refusing to write an invalid inventory diagnostic");
  }
  const directory = path.dirname(outputPath);
  const temporary = path.join(
    directory,
    `.${path.basename(outputPath)}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(diagnostic)}\n`, { encoding: "utf8" });
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, outputPath);
    chmodSync(outputPath, 0o600);
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    rmSync(temporary, { force: true });
  }
}

export function readAndValidateInventoryDiagnostic(inputPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch {
    return null;
  }
  return validateInventoryDiagnostic(parsed) ? parsed : null;
}

function metadataIsPrivateRegularFile(inputPath) {
  try {
    const stat = lstatSync(inputPath);
    const uid = process.getuid?.();
    return stat.isFile()
      && stat.nlink === 1
      && (stat.mode & 0o777) === 0o600
      && (uid === undefined || stat.uid === uid);
  } catch {
    return false;
  }
}

async function cli() {
  const [command, inputPath, category] = process.argv.slice(2);
  if (command === "validate" && inputPath) {
    if (!metadataIsPrivateRegularFile(inputPath)) process.exitCode = 1;
    else if (!readAndValidateInventoryDiagnostic(inputPath)) process.exitCode = 1;
    return;
  }
  if (command === "fallback" && inputPath) {
    writeInventoryDiagnosticAtomic(inputPath, fallbackInventoryDiagnostic(category));
    return;
  }
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cli();
}
