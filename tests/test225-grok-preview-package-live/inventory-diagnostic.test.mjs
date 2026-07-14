import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fallbackInventoryDiagnostic,
  makeInventoryDiagnostic,
  readAndValidateInventoryDiagnostic,
  validateInventoryDiagnostic,
  writeInventoryDiagnosticAtomic,
} from "./inventory-diagnostic.mjs";

const passing = () => makeInventoryDiagnostic({
  status: "passed",
  phase: "complete",
  category: "ok",
  facts: {
    totalRequests: 8,
    mainRequests: 4,
    auxiliaryRequests: 4,
    markerRequests: 4,
    nonceRequests: 4,
    exactMainRequests: 2,
    exactAuxiliaryRequests: 4,
    unsafeMutationRequests: 2,
    spawned: true,
    leaderObserved: true,
    mainRequestObserved: true,
    promptNonceObserved: true,
    assistantAfterNonce: true,
    turnEndedAfterBaseline: true,
    completedTurn: true,
  },
});

test("closed schema rejects arbitrary strings, keys, enums, and ranges", () => {
  const base = passing();
  const mutations = [
    { ...base, schemaVersion: 1 },
    { ...base, raw: "PARTNER_TOKEN=TEST225_TOKEN_CANARY" },
    { ...base, category: "PRIVATE_CUSTOMER_CATEGORY" },
    { ...base, phase: "PRIVATE_PHASE" },
    { ...base, facts: { ...base.facts, message: "AWS_SECRET_ACCESS_KEY=canary" } },
    { ...base, facts: { ...base.facts, totalRequests: -1 } },
    { ...base, facts: { ...base.facts, totalRequests: 4097 } },
    { ...base, status: "failed" },
    { ...base, facts: { ...base.facts, totalRequests: 0, mainRequests: 0,
      auxiliaryRequests: 0, markerRequests: 0, nonceRequests: 0,
      exactMainRequests: 0, exactAuxiliaryRequests: 0, unsafeMutationRequests: 0 } },
    { ...base, facts: { ...base.facts, totalRequests: base.facts.totalRequests + 1 } },
    { ...base, facts: { ...base.facts, unsafeMutationRequests: 0 } },
    { ...base, facts: { ...base.facts, completedTurn: false } },
    { ...base, status: "failed", phase: "fresh", category: "client_cleanup" },
    { ...base, status: "failed", phase: "cleanup", category: "request_timeout" },
  ];
  for (const mutation of mutations) assert.equal(validateInventoryDiagnostic(mutation), false);
});

test("keeps transport and cleanup failures as value-free fail-closed categories", () => {
  for (const category of [
    "request_timeout",
    "response_timeout",
    "leader_readiness",
    "client_cleanup",
    "listener_cleanup",
    "server_cleanup",
  ]) {
    const diagnostic = makeInventoryDiagnostic({
      status: "failed",
      phase: category.endsWith("_cleanup") ? "cleanup" : "mutation_read",
      category,
      facts: {
        spawned: true,
        leaderObserved: category !== "leader_readiness",
      },
    });
    assert.equal(validateInventoryDiagnostic(diagnostic), true);
    assert.equal(diagnostic.schemaVersion, 2);
    assert.equal(JSON.stringify(diagnostic).includes("PRIVATE"), false);
  }
});

test("unknown error content cannot enter a fallback diagnostic", () => {
  const canary = "DATABASE_URL=postgres://PRIVATE PARTNER_TOKEN=PRIVATE ntok_PRIVATE";
  const diagnostic = fallbackInventoryDiagnostic(canary);
  const serialized = JSON.stringify(diagnostic);
  assert.equal(diagnostic.category, "invalid_or_missing_result");
  assert.equal(serialized.includes(canary), false);
  assert.equal(serialized.includes("PRIVATE"), false);
});

test("atomic writer produces one owner-only regular file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test225-diagnostic-test-"));
  const output = path.join(root, "result.json");
  try {
    writeInventoryDiagnosticAtomic(output, passing());
    const stat = statSync(output);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.deepEqual(readAndValidateInventoryDiagnostic(output), passing());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed, truncated, and extended result files are rejected", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test225-diagnostic-test-"));
  const output = path.join(root, "result.json");
  try {
    for (const value of ["", "{", JSON.stringify({ ...passing(), stack: "private" })]) {
      writeFileSync(output, value, { mode: 0o600 });
      assert.equal(readAndValidateInventoryDiagnostic(output), null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
