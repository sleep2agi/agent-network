import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeAuthEvidenceDiagnostic,
  scanAuthEvidenceTargets,
} from "./auth-evidence-diagnostic.mjs";
import {
  AUTH_EVIDENCE_GATE_CHANNELS,
  PREVIEW_STRUCTURE_WARNING_ROLES,
  classifyAuthEvidenceGate,
} from "./auth-evidence-gate-policy.mjs";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PRIVATE_SCALAR = "PRIVATE_AUTH_SCALAR_0123456789";

function installExpectedLocks({ home, leader, cwd }) {
  const leaderHash = createHash("sha256").update(leader).digest("hex").slice(0, 20);
  const sessionHash = createHash("sha256")
    .update(realpathSync(home))
    .update("\0")
    .update(path.resolve(cwd))
    .update("\0")
    .update(SESSION_ID)
    .digest("hex")
    .slice(0, 24);
  const lockPaths = [
    path.join(home, "copresence-locks", `.session-${sessionHash}.lock`),
    path.join(path.dirname(leader), `.leader-${leaderHash}.lock`),
    path.join(path.dirname(leader), `.bridge-${leaderHash}-${SESSION_ID}.lock`),
  ];
  for (const lockPath of lockPaths) {
    mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, "", { mode: 0o600 });
  }
}

function stateFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "test225-preview-gate-"));
  const state = path.join(root, "state");
  const home = path.join(state, `node-${"a".repeat(24)}`);
  const runtime = path.join(root, "runtime");
  const cwd = path.join(root, "workspace");
  const pattern = path.join(root, "patterns");
  const metadataManifest = path.join(root, "auth-metadata-manifest.json");
  const identity = path.join(root, "agent_id");
  const leader = path.join(runtime, "l.sock");
  const attach = path.join(runtime, "a.sock");
  for (const directory of [state, home, runtime, cwd]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  writeFileSync(pattern, `${PRIVATE_SCALAR}\n`, { mode: 0o600 });
  writeFileSync(metadataManifest, '{"v":1,"tuples":[]}\n', { mode: 0o600 });
  writeFileSync(identity, "clean identity\n", { mode: 0o600 });
  installExpectedLocks({ home, leader, cwd });
  return { root, state, home, runtime, cwd, pattern, metadataManifest, identity, leader, attach };
}

function scanFixture(fixture) {
  return scanAuthEvidenceTargets({
    phase: "first_turn_post_stop",
    patternPath: fixture.pattern,
    metadataManifestPath: fixture.metadataManifest,
    expectedIdentityPath: fixture.identity,
    expectedStateHome: fixture.home,
    expectedSessionId: SESSION_ID,
    expectedCwd: fixture.cwd,
    expectedLeaderSocket: fixture.leader,
    expectedAttachSocket: fixture.attach,
    targets: [{ role: "__grok_state__", path: fixture.state }],
  });
}

test("preview warning policy is a closed exact role and latest/prod stay strict", () => {
  assert.deepEqual(AUTH_EVIDENCE_GATE_CHANNELS, ["preview", "latest", "prod"]);
  assert.deepEqual(PREVIEW_STRUCTURE_WARNING_ROLES, ["grok_current_state_structure"]);
  const structural = makeAuthEvidenceDiagnostic({
    phase: "first_turn_post_stop",
    errorRoles: ["grok_current_state_structure"],
  });
  assert.equal(classifyAuthEvidenceGate("preview", structural), "warning");
  assert.equal(classifyAuthEvidenceGate("latest", structural), "fatal");
  assert.equal(classifyAuthEvidenceGate("prod", structural), "fatal");
  assert.equal(classifyAuthEvidenceGate("preview", makeAuthEvidenceDiagnostic({
    phase: "first_turn_post_stop",
  })), "pass");
});

test("preview remains fatal for boundary errors, extra errors, and every credential match", () => {
  for (const errorRoles of [
    ["scan_boundary"],
    ["grok_runtime_directory_scan"],
    ["grok_current_state_structure", "grok_state_root_structure"],
  ]) {
    assert.equal(classifyAuthEvidenceGate("preview", makeAuthEvidenceDiagnostic({
      phase: "first_turn_post_stop",
      errorRoles,
    })), "fatal");
  }
  for (const matchedRoles of [
    ["runtime_log_store"],
    ["grok_current_home_other_state"],
  ]) {
    assert.equal(classifyAuthEvidenceGate("preview", makeAuthEvidenceDiagnostic({
      phase: "first_turn_post_stop",
      matchedRoles,
      errorRoles: ["grok_current_state_structure"],
    })), "fatal");
  }
  assert.throws(() => classifyAuthEvidenceGate("unknown", makeAuthEvidenceDiagnostic({
    phase: "first_turn_post_stop",
  })));
});

test("raw state credential mutation changes preview structure warning to fatal", () => {
  const fixture = stateFixture();
  const unknownState = path.join(fixture.home, "unreviewed.data");
  try {
    writeFileSync(unknownState, "clean\n", { mode: 0o600 });
    const cleanUnknown = scanFixture(fixture);
    assert.equal(cleanUnknown.scanOutcome, "scan_error");
    assert.deepEqual(cleanUnknown.matchedRoles, []);
    assert.deepEqual(cleanUnknown.errorRoles, ["grok_current_state_structure"]);
    assert.equal(classifyAuthEvidenceGate("preview", cleanUnknown), "warning");

    // The mutation enters at the raw on-disk state boundary. The unchanged
    // scanner must read the bytes and add a matched storage role; the preview
    // policy must therefore become fatal even though the structural role is
    // still present and warning-eligible by itself.
    writeFileSync(unknownState, `${PRIVATE_SCALAR}\n`, { mode: 0o600 });
    const leaked = scanFixture(fixture);
    assert.equal(leaked.scanOutcome, "mixed");
    assert.deepEqual(leaked.matchedRoles, ["grok_current_home_other_state"]);
    assert.deepEqual(leaked.errorRoles, ["grok_current_state_structure"]);
    assert.equal(classifyAuthEvidenceGate("preview", leaked), "fatal");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
