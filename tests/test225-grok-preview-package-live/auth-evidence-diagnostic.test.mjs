import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import {
  AUTH_EVIDENCE_PHASES,
  AUTH_EVIDENCE_ROLES,
  PINNED_VENDOR_STATE_POLICY,
  makeAuthEvidenceDiagnostic,
  readAndValidateAuthEvidenceDiagnostic,
  refreshAuthPatternFiles,
  scanAuthEvidenceTargets,
  validateAuthEvidenceDiagnostic,
  writeAuthEvidenceDiagnosticAtomic,
} from "./auth-evidence-diagnostic.mjs";

const diagnostic = () => makeAuthEvidenceDiagnostic({
  phase: "first_turn_post_stop",
  matchedRoles: ["grok_identity_state", "first_start_output"],
});

function cliValidate(output) {
  return spawnSync(process.execPath, [
    new URL("./auth-evidence-diagnostic.mjs", import.meta.url).pathname,
    "validate",
    output,
  ]).status;
}

async function listenUnix(socketPath) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  return server;
}

async function closeUnix(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("timed out waiting for mutation helper");
}

const TEST_SESSION_ID = "11111111-1111-4111-8111-111111111111";

function expectedLockPaths({ home, leader, cwd, sessionId = TEST_SESSION_ID }) {
  const leaderHash = createHash("sha256").update(leader).digest("hex").slice(0, 20);
  const sessionHash = createHash("sha256")
    .update(realpathSync(home))
    .update("\0")
    .update(path.resolve(cwd))
    .update("\0")
    .update(sessionId)
    .digest("hex")
    .slice(0, 24);
  return {
    session: path.join(home, "copresence-locks", `.session-${sessionHash}.lock`),
    leader: path.join(path.dirname(leader), `.leader-${leaderHash}.lock`),
    bridge: path.join(path.dirname(leader), `.bridge-${leaderHash}-${sessionId}.lock`),
  };
}

function installExpectedLocks(values) {
  const locks = expectedLockPaths(values);
  mkdirSync(path.dirname(locks.session), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(locks.leader), { recursive: true, mode: 0o700 });
  for (const lockPath of Object.values(locks)) {
    writeFileSync(lockPath, "", { mode: 0o600 });
  }
  return locks;
}

function stateFixture(label = "state") {
  const root = mkdtempSync(path.join(tmpdir(), `test225-auth-${label}-`));
  const state = path.join(root, "state");
  const home = path.join(state, `node-${"a".repeat(24)}`);
  const run = path.join(root, "runtime");
  const pattern = path.join(root, "patterns");
  const metadataManifest = path.join(root, "auth-metadata-manifest.json");
  const identity = path.join(root, "agent_id");
  const leader = path.join(run, "l.sock");
  const attach = path.join(run, "a.sock");
  const cwd = path.join(root, "workspace");
  const sessionId = TEST_SESSION_ID;
  const session = path.join(home, "sessions", encodeURIComponent(cwd), sessionId);
  for (const directory of [state, home, run, cwd]) mkdirSync(directory, { mode: 0o700 });
  writeFileSync(pattern, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
  writeFileSync(metadataManifest, '{"v":1,"tuples":[]}\n', { mode: 0o600 });
  writeFileSync(identity, "clean identity\n", { mode: 0o600 });
  const locks = installExpectedLocks({ home, leader, cwd, sessionId });
  return {
    root, state, home, run, pattern, metadataManifest, identity, leader, attach, cwd,
    sessionId, session, locks,
  };
}

function scanStateFixture(fixture, overrides = {}) {
  return scanAuthEvidenceTargets({
    phase: "first_turn_post_stop",
    patternPath: fixture.pattern,
    metadataManifestPath: fixture.metadataManifest,
    expectedIdentityPath: fixture.identity,
    expectedStateHome: fixture.home,
    expectedSessionId: fixture.sessionId,
    expectedCwd: fixture.cwd,
    expectedLeaderSocket: fixture.leader,
    expectedAttachSocket: fixture.attach,
    targets: [{ role: "__grok_state__", path: fixture.state }],
    ...overrides,
  });
}

const AUTH_METADATA_FIXTURE = Object.freeze({
  scope: "TEST225_SCOPE_EXACT_0123456789",
  userId: "TEST225_USER_ID_EXACT_0123456789",
  principalId: "TEST225_PRINCIPAL_ID_EXACT_0123456789",
  issuer: "https://issuer.test225.invalid",
  clientId: "TEST225_CLIENT_ID_EXACT_0123456789",
  secret: "TEST225_AUTH_SECRET_0123456789",
});

function metadataStateFixture(label = "metadata") {
  const fixture = stateFixture(label);
  const auth = path.join(fixture.root, "auth.json");
  const unsafe = path.join(fixture.root, "unsafe-patterns");
  const logs = path.join(fixture.home, "logs");
  const unified = path.join(logs, "unified.jsonl");
  writeFileSync(auth, `${JSON.stringify({
    [AUTH_METADATA_FIXTURE.scope]: {
      user_id: AUTH_METADATA_FIXTURE.userId,
      principal_id: AUTH_METADATA_FIXTURE.principalId,
      oidc_issuer: AUTH_METADATA_FIXTURE.issuer,
      oidc_client_id: AUTH_METADATA_FIXTURE.clientId,
      key: AUTH_METADATA_FIXTURE.secret,
    },
  })}\n`, { mode: 0o600 });
  refreshAuthPatternFiles({
    authPath: auth,
    patternPath: fixture.pattern,
    unsafePatternPath: unsafe,
    metadataManifestPath: fixture.metadataManifest,
  });
  mkdirSync(logs, { mode: 0o700 });
  return { ...fixture, auth, unsafe, logs, unified };
}

function writeUnifiedFrames(fixture, frames) {
  writeRawUnifiedFrames(fixture, frames.map((frame) => JSON.stringify(frame)));
}

function writeRawUnifiedFrames(fixture, rawFrames) {
  writeFileSync(
    fixture.unified,
    Buffer.from(`${rawFrames.join("\n")}\n`, "utf8"),
    { mode: 0o600 },
  );
}

function knownMetadataFrames() {
  return [
    { ctx: { user_id: AUTH_METADATA_FIXTURE.userId } },
    {
      ctx: {
        issuer: AUTH_METADATA_FIXTURE.issuer,
        client_id: AUTH_METADATA_FIXTURE.clientId,
      },
    },
    { ctx: { scope: AUTH_METADATA_FIXTURE.scope } },
    { ctx: { target_scope: AUTH_METADATA_FIXTURE.scope } },
    { ctx: { scopes_on_disk: [AUTH_METADATA_FIXTURE.scope] } },
    { ctx: { client_id: 225 } },
  ];
}

async function concurrentDirectoryMutation(kind) {
  const root = mkdtempSync(path.join(tmpdir(), "test225-auth-evidence-race-"));
  const pattern = path.join(root, "patterns");
  const target = path.join(root, "target");
  const victim = path.join(target, "000-earlier");
  const nested = path.join(target, "001-nested");
  const large = path.join(target, "999-large-clean");
  const ready = path.join(root, "ready");
  const go = path.join(root, "go");
  let child;
  try {
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(pattern, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    if (["delete", "rename", "append", "truncate", "overwrite", "replace"].includes(kind)) {
      writeFileSync(victim, "clean\n", { mode: 0o600 });
    }
    if (kind === "nested_add") {
      mkdirSync(nested, { mode: 0o700 });
      writeFileSync(path.join(nested, "clean"), "clean\n", { mode: 0o600 });
    }
    writeFileSync(large, "", { mode: 0o600 });
    truncateSync(large, 512 * 1024 * 1024);
    child = spawn(process.execPath, [
      "-e",
      `
        const fs = require("node:fs");
        const [kind, target, victim, ready, go] = process.argv.slice(1);
        fs.writeFileSync(ready, "ready\\n", { mode: 0o600 });
        while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        if (kind === "add") fs.writeFileSync(target + "/002-late", "PRIVATE_AUTH_SCALAR_0123456789\\n", { mode: 0o600 });
        else if (kind === "delete") fs.rmSync(victim);
        else if (kind === "rename") fs.renameSync(victim, target + "/002-renamed");
        else if (kind === "append") fs.appendFileSync(victim, "PRIVATE_AUTH_SCALAR_0123456789\\n");
        else if (kind === "truncate") fs.truncateSync(victim, 0);
        else if (kind === "overwrite") fs.writeFileSync(victim, "PRIVATE_AUTH_SCALAR_0123456789\\n", { mode: 0o600 });
        else if (kind === "nested_add") fs.writeFileSync(target + "/001-nested/late", "PRIVATE_AUTH_SCALAR_0123456789\\n", { mode: 0o600 });
        else if (kind === "aba") {
          const transient = target + "/002-transient";
          fs.writeFileSync(transient, "PRIVATE_AUTH_SCALAR_0123456789\\n", { mode: 0o600 });
          fs.rmSync(transient);
        } else if (kind === "replace") {
          const replacement = target + "/.replacement";
          fs.writeFileSync(replacement, "PRIVATE_AUTH_SCALAR_0123456789\\n", { mode: 0o600 });
          fs.renameSync(replacement, victim);
        }
      `,
      kind,
      target,
      victim,
      ready,
      go,
    ], { stdio: "ignore" });
    await waitForFile(ready);
    writeFileSync(go, "go\n", { mode: 0o600 });
    const result = scanAuthEvidenceTargets({
      phase: "resume_turn_pre_stop",
      patternPath: pattern,
      expectedIdentityPath: path.join(root, "identity"),
      targets: [{ role: "runtime_log_store", path: target }],
    });
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 0);
    assert.equal(result.scanOutcome, "scan_error");
    assert.deepEqual(result.matchedRoles, []);
    assert.deepEqual(result.errorRoles, ["runtime_log_store"]);
    assert.equal(JSON.stringify(result).includes("PRIVATE_AUTH_SCALAR"), false);
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}

async function concurrentAbsentMutation(kind) {
  const root = mkdtempSync(path.join(tmpdir(), "test225-auth-evidence-absent-"));
  const pattern = path.join(root, "patterns");
  const parent = path.join(root, "optional");
  const missing = path.join(parent, "pending.json");
  const large = path.join(root, "large-clean");
  const ready = path.join(root, "ready");
  const go = path.join(root, "go");
  let child;
  try {
    mkdirSync(parent, { mode: 0o700 });
    writeFileSync(pattern, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    writeFileSync(large, "", { mode: 0o600 });
    truncateSync(large, 512 * 1024 * 1024);
    child = spawn(process.execPath, [
      "-e",
      `
        const fs = require("node:fs");
        const [kind, parent, missing, ready, go] = process.argv.slice(1);
        fs.writeFileSync(ready, "ready\\n", { mode: 0o600 });
        while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        if (kind === "create") {
          fs.writeFileSync(missing, "PRIVATE_AUTH_SCALAR_0123456789\\n", { mode: 0o600 });
        } else if (kind === "aba") {
          fs.writeFileSync(missing, "PRIVATE_AUTH_SCALAR_0123456789\\n", { mode: 0o600 });
          fs.rmSync(missing);
        } else {
          const moved = parent + ".old";
          fs.renameSync(parent, moved);
          fs.mkdirSync(parent, { mode: 0o700 });
        }
      `,
      kind,
      parent,
      missing,
      ready,
      go,
    ], { stdio: "ignore" });
    await waitForFile(ready);
    writeFileSync(go, "go\n", { mode: 0o600 });
    const result = scanAuthEvidenceTargets({
      phase: "resume_turn_pre_stop",
      patternPath: pattern,
      expectedIdentityPath: path.join(root, "identity"),
      targets: [
        { role: "pending_reply_store", path: missing },
        { role: "gate_report", path: large },
      ],
    });
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 0);
    assert.equal(result.scanOutcome, "scan_error");
    assert.deepEqual(result.matchedRoles, []);
    assert.deepEqual(result.errorRoles, ["pending_reply_store"]);
    assert.equal(JSON.stringify(result).includes("PRIVATE_AUTH_SCALAR"), false);
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}

async function concurrentStateSnapshotMutation(scope) {
  const fixture = stateFixture(`snapshot-${scope}`);
  const session = fixture.session;
  const large = path.join(session, "updates.jsonl");
  const ready = path.join(fixture.root, "ready");
  const go = path.join(fixture.root, "go");
  let child;
  try {
    mkdirSync(session, { recursive: true, mode: 0o700 });
    writeFileSync(large, "", { mode: 0o600 });
    truncateSync(large, 512 * 1024 * 1024);
    child = spawn(process.execPath, [
      "-e",
      `
        const fs = require("node:fs");
        const [scope, state, home, ready, go] = process.argv.slice(1);
        fs.writeFileSync(ready, "ready\\n", { mode: 0o600 });
        while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        if (scope === "root") fs.mkdirSync(state + "/prior-added", { mode: 0o700 });
        else fs.writeFileSync(home + "/late-clean", "clean\\n", { mode: 0o600 });
      `,
      scope,
      fixture.state,
      fixture.home,
      ready,
      go,
    ], { stdio: "ignore" });
    await waitForFile(ready);
    writeFileSync(go, "go\n", { mode: 0o600 });
    const result = scanStateFixture(fixture);
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 0);
    assert.deepEqual(result.matchedRoles, []);
    assert.deepEqual(result.errorRoles, [
      scope === "root" ? "grok_state_root_snapshot" : "grok_current_home_snapshot",
    ]);
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("emits only canonical reviewed phases and target-role enums", () => {
  assert.deepEqual(diagnostic(), {
    v: 2,
    gate: "real_auth_evidence_scan",
    status: "failed",
    phase: "first_turn_post_stop",
    scanOutcome: "match",
    matchedRoles: ["first_start_output", "grok_identity_state"],
    errorRoles: [],
    detailWithheld: true,
  });
  for (const phase of AUTH_EVIDENCE_PHASES) {
    for (const role of AUTH_EVIDENCE_ROLES) {
      if (new Set([
        "scan_boundary",
        "grok_runtime_socket_state",
        "grok_runtime_lock_scan",
        "grok_runtime_directory_scan",
        "grok_unified_log_scan",
        "grok_current_state_completeness",
        "grok_current_state_structure",
        "grok_current_home_snapshot",
        "grok_prior_node_structure",
        "grok_state_root_structure",
        "grok_state_root_snapshot",
      ]).has(role)) continue;
      assert.equal(validateAuthEvidenceDiagnostic(makeAuthEvidenceDiagnostic({
        phase,
        matchedRoles: [role],
      })), true);
    }
  }
  assert.equal(makeAuthEvidenceDiagnostic({
    phase: "final_scan",
    errorRoles: ["stop_output_store"],
  }).scanOutcome, "scan_error");
  assert.equal(makeAuthEvidenceDiagnostic({
    phase: "final_scan",
    matchedRoles: ["gate_report"],
    errorRoles: ["stop_output_store"],
  }).scanOutcome, "mixed");
  assert.equal(makeAuthEvidenceDiagnostic({
    phase: "final_scan",
  }).scanOutcome, "clean");
});

test("rejects unknown, duplicate, reordered, or extended values", () => {
  assert.equal(validateAuthEvidenceDiagnostic(makeAuthEvidenceDiagnostic({
    phase: "final_scan",
  })), true);
  assert.throws(() => makeAuthEvidenceDiagnostic({
    phase: "PRIVATE_PHASE",
    matchedRoles: ["first_start_output"],
  }));
  assert.throws(() => makeAuthEvidenceDiagnostic({
    phase: "first_turn_post_stop",
    matchedRoles: ["PRIVATE_ACCOUNT_LOG"],
  }));
  assert.throws(() => makeAuthEvidenceDiagnostic({
    phase: "first_turn_post_stop",
    matchedRoles: ["first_start_output", "first_start_output"],
  }));
  assert.throws(() => makeAuthEvidenceDiagnostic({
    phase: "first_turn_post_stop",
    matchedRoles: ["scan_boundary"],
  }));
  assert.throws(() => makeAuthEvidenceDiagnostic({
    phase: "first_turn_post_stop",
    matchedRoles: ["grok_runtime_socket_state"],
  }));
  assert.deepEqual(makeAuthEvidenceDiagnostic({
    phase: "first_turn_post_stop",
    matchedRoles: ["first_start_output"],
    errorRoles: ["first_start_output"],
  }).scanOutcome, "mixed");

  const base = diagnostic();
  const mutations = [
    { ...base, v: 1 },
    { ...base, gate: "PRIVATE_GATE" },
    { ...base, status: "passed" },
    { ...base, phase: "PRIVATE_PHASE" },
    { ...base, scanOutcome: "scan_error" },
    { ...base, scanOutcome: "PRIVATE_OUTCOME" },
    { ...base, detailWithheld: false },
    { ...base, matchedRoles: ["PRIVATE_ACCOUNT_LOG"] },
    { ...base, matchedRoles: ["grok_identity_state", "first_start_output"] },
    { ...base, matchedRoles: ["first_start_output", "first_start_output"] },
    { ...base, errorRoles: ["first_start_output"], scanOutcome: "match" },
    { ...base, errorRoles: ["PRIVATE_ACCOUNT_LOG"], scanOutcome: "mixed" },
    { ...base, errorRoles: ["stop_output_store", "stop_output_store"], scanOutcome: "mixed" },
    { ...base, errorRoles: ["stop_output_store", "gate_report"], scanOutcome: "mixed" },
    { ...base, raw: "DATABASE_URL=postgres://private.invalid/db" },
    { ...base, path: "/private/state" },
    { ...base, hash: "sha256:private" },
    { ...base, pid: 918273 },
    { ...base, model: "private-model" },
  ];
  for (const mutation of mutations) {
    assert.equal(validateAuthEvidenceDiagnostic(mutation), false);
  }
});

test("cannot serialize caller supplied credential, path, hash, pid, or model text", () => {
  const serialized = JSON.stringify(diagnostic());
  for (const forbidden of [
    "postgres://private.invalid",
    "PRIVATE_TOKEN_VALUE",
    "/home/private/auth.json",
    "918273",
    "model-private",
    "sha256",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("atomic writer produces one owner-only regular file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test225-auth-evidence-test-"));
  const output = path.join(root, "result.json");
  try {
    writeFileSync(output, "stale\n", { mode: 0o644 });
    const staleInode = statSync(output).ino;
    writeAuthEvidenceDiagnosticAtomic(output, diagnostic());
    const stat = statSync(output);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.notEqual(stat.ino, staleInode);
    assert.deepEqual(readAndValidateAuthEvidenceDiagnostic(output), diagnostic());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomic writer replaces, rather than follows, destination links", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test225-auth-evidence-test-"));
  const output = path.join(root, "result.json");
  const victim = path.join(root, "victim");
  const sibling = path.join(root, "sibling");
  try {
    writeFileSync(victim, "victim-unchanged\n", { mode: 0o600 });
    symlinkSync(victim, output);
    assert.equal(cliValidate(output), 1);
    writeAuthEvidenceDiagnosticAtomic(output, diagnostic());
    assert.equal(readFileSync(victim, "utf8"), "victim-unchanged\n");
    assert.deepEqual(readAndValidateAuthEvidenceDiagnostic(output), diagnostic());

    rmSync(output);
    linkSync(victim, output);
    linkSync(victim, sibling);
    assert.equal(cliValidate(output), 1);
    writeAuthEvidenceDiagnosticAtomic(output, diagnostic());
    assert.equal(readFileSync(victim, "utf8"), "victim-unchanged\n");
    assert.equal(readFileSync(sibling, "utf8"), "victim-unchanged\n");
    assert.deepEqual(readAndValidateAuthEvidenceDiagnostic(output), diagnostic());
    assert.equal(statSync(output).nlink, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state scanner binds one-level identity target and never follows other links", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test225-auth-evidence-scan-"));
  const source = path.join(root, "source");
  const state = path.join(root, "state");
  const home = path.join(state, `node-${"a".repeat(24)}`);
  const cwd = path.join(root, "workspace");
  const sessionId = TEST_SESSION_ID;
  const session = path.join(home, "sessions", encodeURIComponent(cwd), sessionId);
  const leader = path.join(home, "run", "leader.sock");
  const attach = path.join(home, "run", "attach.sock");
  const pattern = path.join(root, "patterns");
  const expectedIdentity = path.join(source, "agent_id");
  try {
    for (const directory of [source, state, home, path.dirname(leader), cwd, path.dirname(path.dirname(session)), path.dirname(session), session]) {
      try { mkdirSync(directory, { mode: 0o700 }); } catch {}
    }
    writeFileSync(pattern, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    writeFileSync(expectedIdentity, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    const otherIdentity = path.join(source, "other");
    writeFileSync(otherIdentity, "clean\n", { mode: 0o600 });
    installExpectedLocks({ home, leader, cwd, sessionId });
    symlinkSync(expectedIdentity, path.join(home, "agent_id"));
    writeFileSync(path.join(session, "chat_history.jsonl"), "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    symlinkSync(otherIdentity, path.join(session, "agent_id"));
    const wrongHome = path.join(state, "wrong");
    mkdirSync(wrongHome, { mode: 0o700 });
    symlinkSync(otherIdentity, path.join(wrongHome, "agent_id"));
    const directLink = path.join(root, "direct-link");
    symlinkSync(otherIdentity, directLink);

    assert.deepEqual(scanAuthEvidenceTargets({
      phase: "first_turn_post_stop",
      patternPath: pattern,
      expectedIdentityPath: expectedIdentity,
      expectedStateHome: home,
      expectedSessionId: sessionId,
      expectedCwd: cwd,
      expectedLeaderSocket: leader,
      expectedAttachSocket: attach,
      targets: [
        { role: "__grok_state__", path: state },
        { role: "runtime_log_store", path: directLink },
      ],
    }), {
      v: 2,
      gate: "real_auth_evidence_scan",
      status: "failed",
      phase: "first_turn_post_stop",
      scanOutcome: "mixed",
      matchedRoles: ["grok_identity_state", "grok_session_chat"],
      errorRoles: [
        "runtime_log_store",
        "grok_current_state_structure",
        "grok_prior_node_structure",
        "grok_state_root_structure",
      ],
      detailWithheld: true,
    });

    writeFileSync(pattern, "", { mode: 0o600 });
    assert.deepEqual(scanAuthEvidenceTargets({
      phase: "first_turn_post_stop",
      patternPath: pattern,
      expectedIdentityPath: expectedIdentity,
      targets: [{ role: "runtime_log_store", path: root }],
    }).errorRoles, ["scan_boundary"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binds the exact current home and accepts only its two owner-bound runtime sockets", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "test225-auth-evidence-socket-"));
  const state = path.join(root, "state");
  const home = path.join(state, `node-${"a".repeat(24)}`);
  const run = path.join(home, "run");
  const pattern = path.join(root, "patterns");
  const identity = path.join(root, "agent_id");
  const leader = path.join(run, "leader.sock");
  const attach = path.join(run, "attach.sock");
  const wrongName = path.join(run, "other.sock");
  const cwd = path.join(root, "workspace");
  const sessionId = TEST_SESSION_ID;
  const servers = [];
  try {
    for (const directory of [state, home, run, cwd]) mkdirSync(directory, { mode: 0o700 });
    writeFileSync(pattern, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    writeFileSync(identity, "clean\n", { mode: 0o600 });
    installExpectedLocks({ home, leader, cwd, sessionId });
    servers.push(await listenUnix(leader));
    servers.push(await listenUnix(attach));

    const clean = scanAuthEvidenceTargets({
      phase: "resume_turn_pre_stop",
      patternPath: pattern,
      expectedIdentityPath: identity,
      expectedStateHome: home,
      expectedSessionId: sessionId,
      expectedCwd: cwd,
      expectedLeaderSocket: leader,
      expectedAttachSocket: attach,
      targets: [{ role: "__grok_state__", path: state }],
    });
    assert.equal(clean.scanOutcome, "clean");
    assert.equal(clean.status, "passed");
    assert.deepEqual(clean.errorRoles, []);

    assert.deepEqual(scanAuthEvidenceTargets({
      phase: "resume_turn_pre_stop",
      patternPath: pattern,
      expectedIdentityPath: identity,
      expectedStateHome: home,
      expectedSessionId: sessionId,
      expectedCwd: cwd,
      expectedLeaderSocket: path.join(run, "wrong-expected-leader.sock"),
      expectedAttachSocket: attach,
      targets: [{ role: "__grok_state__", path: state }],
    }).errorRoles, ["grok_runtime_lock_scan", "grok_runtime_directory_scan"]);

    servers.push(await listenUnix(wrongName));
    assert.deepEqual(scanAuthEvidenceTargets({
      phase: "resume_turn_pre_stop",
      patternPath: pattern,
      expectedIdentityPath: identity,
      expectedStateHome: home,
      expectedSessionId: sessionId,
      expectedCwd: cwd,
      expectedLeaderSocket: leader,
      expectedAttachSocket: attach,
      targets: [{ role: "__grok_state__", path: state }],
    }).errorRoles, ["grok_runtime_directory_scan"]);

    await closeUnix(servers.pop());
    await closeUnix(servers.pop());
    rmSync(attach, { force: true });
    assert.deepEqual(scanAuthEvidenceTargets({
      phase: "resume_turn_pre_stop",
      patternPath: pattern,
      expectedIdentityPath: identity,
      expectedStateHome: home,
      expectedSessionId: sessionId,
      expectedCwd: cwd,
      expectedLeaderSocket: leader,
      expectedAttachSocket: attach,
      targets: [{ role: "__grok_state__", path: state }],
    }).errorRoles, []);

    writeFileSync(attach, "not-a-socket\n", { mode: 0o600 });
    assert.deepEqual(scanAuthEvidenceTargets({
      phase: "resume_turn_pre_stop",
      patternPath: pattern,
      expectedIdentityPath: identity,
      expectedStateHome: home,
      expectedSessionId: sessionId,
      expectedCwd: cwd,
      expectedLeaderSocket: leader,
      expectedAttachSocket: attach,
      targets: [{ role: "__grok_state__", path: state }],
    }).errorRoles, ["grok_runtime_socket_state"]);

    if (process.getuid?.() === 0) {
      rmSync(attach, { force: true });
      servers.push(await listenUnix(attach));
      chownSync(attach, 65534, 65534);
      assert.deepEqual(scanAuthEvidenceTargets({
        phase: "resume_turn_pre_stop",
        patternPath: pattern,
        expectedIdentityPath: identity,
        expectedStateHome: home,
        expectedSessionId: sessionId,
        expectedCwd: cwd,
        expectedLeaderSocket: leader,
        expectedAttachSocket: attach,
        targets: [{ role: "__grok_state__", path: state }],
      }).errorRoles, ["grok_runtime_socket_state"]);
    }
  } finally {
    while (servers.length) {
      try { await closeUnix(servers.pop()); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const OBSERVED_PINNED_STATE_FILES = Object.freeze([
  ".metadata_version",
  "active_sessions.json",
  "active_sessions.lock",
  "managed_config.lock",
  "models_cache.json",
]);
const OBSERVED_PINNED_STATE_DIRECTORIES = Object.freeze(["docs", "skills"]);

test("production pinned vendor policy equals the audited observed inventory", () => {
  assert.deepEqual(PINNED_VENDOR_STATE_POLICY, {
    stateFiles: OBSERVED_PINNED_STATE_FILES,
    stateDirectories: OBSERVED_PINNED_STATE_DIRECTORIES,
    nativeLeaderLockBinding: {
      source: "expectedLeaderSocket",
      replaceExtension: ".lock",
    },
  });
});

function assertCleanStateFixture(fixture) {
  assert.deepEqual(scanStateFixture(fixture), {
    v: 2,
    gate: "real_auth_evidence_scan",
    status: "passed",
    phase: "first_turn_post_stop",
    scanOutcome: "clean",
    matchedRoles: [],
    errorRoles: [],
    detailWithheld: true,
  });
}

function assertExactStatePatternMatch(fixture, role) {
  assert.deepEqual(scanStateFixture(fixture), {
    v: 2,
    gate: "real_auth_evidence_scan",
    status: "failed",
    phase: "first_turn_post_stop",
    scanOutcome: "match",
    matchedRoles: [role],
    errorRoles: [],
    detailWithheld: true,
  });
}

function installObservedPinnedVendorState(fixture) {
  for (const directory of OBSERVED_PINNED_STATE_DIRECTORIES) {
    const nested = path.join(fixture.home, directory, "nested");
    mkdirSync(nested, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(nested, "clean"), "clean\n", { mode: 0o600 });
  }
  for (const basename of OBSERVED_PINNED_STATE_FILES) {
    writeFileSync(path.join(fixture.home, basename), "clean\n", { mode: 0o600 });
  }
  writeFileSync(path.join(fixture.run, "l.lock"), "1\n", { mode: 0o600 });
}

test("scans only the observed pinned vendor state without structural false positives", () => {
  const fixture = stateFixture("pinned-vendor-state");
  try {
    installObservedPinnedVendorState(fixture);
    assertCleanStateFixture(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const basename of OBSERVED_PINNED_STATE_FILES) {
  test(`rejects an auth pattern inside observed pinned state file ${basename}`, () => {
    const fixture = stateFixture(`pinned-file-${basename.replaceAll(".", "-")}`);
    try {
      installObservedPinnedVendorState(fixture);
      assertCleanStateFixture(fixture);
      writeFileSync(path.join(fixture.home, basename),
        "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
      assertExactStatePatternMatch(fixture, "grok_current_home_other_state");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

for (const directory of OBSERVED_PINNED_STATE_DIRECTORIES) {
  test(`rejects an auth pattern inside observed pinned state directory ${directory}`, () => {
    const fixture = stateFixture(`pinned-directory-${directory}`);
    try {
      installObservedPinnedVendorState(fixture);
      assertCleanStateFixture(fixture);
      writeFileSync(path.join(fixture.home, directory, "nested", "clean"),
        "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
      assertExactStatePatternMatch(fixture, "grok_current_home_other_state");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("rejects an auth pattern inside the native lock derived from l.sock", () => {
  const fixture = stateFixture("pinned-runtime-leader-lock");
  try {
    installObservedPinnedVendorState(fixture);
    assertCleanStateFixture(fixture);
    writeFileSync(path.join(fixture.run, "l.lock"),
      "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    assertExactStatePatternMatch(fixture, "grok_runtime_directory_other_state");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const basename of [
  "CHANGELOG.json",
  "CHANGELOG.md",
  "README.md",
  "leader.log",
  "sandbox-events.jsonl",
]) {
  test(`suppressed post-stop file ${basename} stays red if cleanup is bypassed`, () => {
    const fixture = stateFixture(`suppressed-${basename.replaceAll(".", "-")}`);
    const candidate = path.join(fixture.home, basename);
    try {
      writeFileSync(candidate, "clean\n", { mode: 0o600 });
      let result = scanStateFixture(fixture);
      assert.deepEqual(result.matchedRoles, []);
      assert.deepEqual(result.errorRoles, ["grok_current_state_completeness"]);
      writeFileSync(candidate, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
      result = scanStateFixture(fixture);
      assert.equal(result.scanOutcome, "mixed");
      assert.deepEqual(result.matchedRoles, ["grok_current_home_other_state"]);
      assert.deepEqual(result.errorRoles, ["grok_current_state_completeness"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

for (const [label, candidatePath] of [
  ["prompt_history.jsonl", (fixture) => path.join(
    fixture.home,
    "sessions",
    encodeURIComponent(fixture.cwd),
    "prompt_history.jsonl",
  )],
  ["session_search.sqlite", (fixture) => path.join(
    fixture.home,
    "sessions",
    "session_search.sqlite",
  )],
]) {
  test(`prompt-bearing cache ${label} stays red if cleanup is bypassed`, () => {
    const fixture = stateFixture(`suppressed-${label.replaceAll(".", "-")}`);
    const candidate = candidatePath(fixture);
    try {
      mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
      writeFileSync(candidate, "clean\n", { mode: 0o600 });
      let result = scanStateFixture(fixture);
      assert.deepEqual(result.matchedRoles, []);
      assert.deepEqual(result.errorRoles, ["grok_current_state_structure"]);
      writeFileSync(candidate, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
      result = scanStateFixture(fixture);
      assert.equal(result.scanOutcome, "mixed");
      assert.deepEqual(result.matchedRoles, ["grok_session_other"]);
      assert.deepEqual(result.errorRoles, ["grok_current_state_structure"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("observed PID-bound sandbox placeholder stays red when cleanup is bypassed", () => {
  const fixture = stateFixture("suppressed-sandbox-placeholder");
  const blocked = path.join(fixture.home, "sandbox-blocked-dir.3308");
  try {
    mkdirSync(blocked, { mode: 0o700 });
    writeFileSync(path.join(blocked, "unknown"),
      "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    const result = scanStateFixture(fixture);
    assert.equal(result.scanOutcome, "mixed");
    assert.deepEqual(result.matchedRoles, ["grok_current_home_other_state"]);
    assert.deepEqual(result.errorRoles, ["grok_current_state_completeness"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("native l.lock must be hardened from its observed 0644 mode", () => {
  const fixture = stateFixture("runtime-leader-lock-mode");
  const leaderLock = path.join(fixture.run, "l.lock");
  try {
    writeFileSync(leaderLock, "1\n", { mode: 0o644 });
    chmodSync(leaderLock, 0o644);
    assert.deepEqual(scanStateFixture(fixture).errorRoles, ["grok_runtime_directory_scan"]);
    chmodSync(leaderLock, 0o600);
    assertCleanStateFixture(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a legacy leader.lock sibling when the exact socket derives l.lock", () => {
  const fixture = stateFixture("runtime-native-lock-wrong-name");
  const nativeLock = path.join(fixture.run, "l.lock");
  const wrongLock = path.join(fixture.run, "leader.lock");
  try {
    writeFileSync(nativeLock, "1\n", { mode: 0o600 });
    writeFileSync(wrongLock, "clean\n", { mode: 0o600 });
    let result = scanStateFixture(fixture);
    assert.equal(result.scanOutcome, "scan_error");
    assert.deepEqual(result.matchedRoles, []);
    assert.deepEqual(result.errorRoles, ["grok_runtime_directory_scan"]);

    writeFileSync(wrongLock, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    result = scanStateFixture(fixture);
    assert.equal(result.scanOutcome, "mixed");
    assert.deepEqual(result.matchedRoles, ["grok_runtime_directory_other_state"]);
    assert.deepEqual(result.errorRoles, ["grok_runtime_directory_scan"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("pinned vendor directories must be hardened from observed public modes", () => {
  const fixture = stateFixture("pinned-vendor-modes");
  try {
    installObservedPinnedVendorState(fixture);
    const docs = path.join(fixture.home, "docs");
    const nested = path.join(docs, "nested");
    const file = path.join(nested, "clean");
    chmodSync(docs, 0o755);
    chmodSync(nested, 0o755);
    chmodSync(file, 0o644);
    assert.deepEqual(scanStateFixture(fixture).errorRoles, ["grok_current_state_structure"]);
    chmodSync(docs, 0o700);
    chmodSync(nested, 0o700);
    chmodSync(file, 0o600);
    assertCleanStateFixture(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("requires a direct real current home and exact socket paths in both API and CLI", () => {
  const fixture = stateFixture("expected-home");
  const output = path.join(fixture.root, "cli-result.json");
  try {
    const missing = path.join(fixture.state, "missing-node");
    assert.deepEqual(scanStateFixture(fixture, {
      expectedStateHome: missing,
      expectedLeaderSocket: path.join(missing, "run", "leader.sock"),
      expectedAttachSocket: path.join(missing, "run", "attach.sock"),
    }).errorRoles, ["grok_state_root_structure"]);

    assert.deepEqual(scanStateFixture(fixture, {
      expectedLeaderSocket: path.join(fixture.run, "not-leader.sock"),
    }).errorRoles, ["grok_runtime_lock_scan"]);

    assert.ok(scanStateFixture(fixture, {
      expectedCwd: `${fixture.cwd}/../workspace`,
    }).errorRoles.includes("grok_state_root_structure"));
    assert.ok(scanStateFixture(fixture, {
      expectedSessionId: "not-a-session",
    }).errorRoles.includes("grok_state_root_structure"));

    chmodSync(fixture.run, 0o750);
    assert.ok(scanStateFixture(fixture).errorRoles.includes("grok_state_root_structure"));
    chmodSync(fixture.run, 0o700);
    chmodSync(fixture.state, 0o750);
    assert.deepEqual(scanStateFixture(fixture).errorRoles, ["grok_state_root_structure"]);
    chmodSync(fixture.state, 0o700);

    const status = spawnSync(process.execPath, [
      new URL("./auth-evidence-diagnostic.mjs", import.meta.url).pathname,
      "scan",
      output,
      "first_turn_post_stop",
      fixture.pattern,
      fixture.metadataManifest,
      fixture.identity,
      fixture.home,
      fixture.sessionId,
      fixture.cwd,
      fixture.leader,
      fixture.attach,
      "__grok_state__",
      fixture.state,
    ]).status;
    assert.equal(status, 0);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.deepEqual(readAndValidateAuthEvidenceDiagnostic(output)?.errorRoles, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("separates current summary, unknown current state, and prior-node matches", () => {
  const fixture = stateFixture("current-prior");
  const session = fixture.session;
  const sibling = path.join(fixture.state, `node-${"b".repeat(24)}`);
  try {
    mkdirSync(session, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(sibling, "nested"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(session, "summary.json"), "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    writeFileSync(path.join(fixture.home, "unknown-current"), "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    writeFileSync(path.join(sibling, "nested", "state"), "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    writeFileSync(fixture.identity, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    symlinkSync(fixture.identity, path.join(sibling, "agent_id"));

    assert.deepEqual(scanStateFixture(fixture), {
      v: 2,
      gate: "real_auth_evidence_scan",
      status: "failed",
      phase: "first_turn_post_stop",
      scanOutcome: "mixed",
      matchedRoles: [
        "grok_session_summary",
        "grok_current_home_other_state",
        "grok_prior_node_state",
      ],
      errorRoles: ["grok_current_state_completeness"],
      detailWithheld: true,
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed on an unknown current regular file even when it is clean", () => {
  const fixture = stateFixture("unknown-clean");
  try {
    writeFileSync(path.join(fixture.home, "new-vendor-state"), "clean\n", { mode: 0o600 });
    const result = scanStateFixture(fixture);
    assert.deepEqual(result.matchedRoles, []);
    assert.deepEqual(result.errorRoles, ["grok_current_state_completeness"]);

    const outside = path.join(fixture.root, "outside");
    writeFileSync(outside, "clean\n", { mode: 0o600 });
    symlinkSync(outside, path.join(fixture.home, "unknown-link"));
    assert.deepEqual(scanStateFixture(fixture).errorRoles, [
      "grok_current_state_completeness",
      "grok_current_state_structure",
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("binds known session files to the exact normalized cwd and session depth", () => {
  const fixture = stateFixture("session-exact");
  try {
    mkdirSync(fixture.session, { recursive: true, mode: 0o700 });
    for (const basename of ["chat_history.jsonl", "events.jsonl", "updates.jsonl", "summary.json"]) {
      writeFileSync(path.join(fixture.session, basename),
        "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    }
    assert.deepEqual(scanStateFixture(fixture).matchedRoles, [
      "grok_session_chat",
      "grok_session_events",
      "grok_session_updates",
      "grok_session_summary",
    ]);
    assert.deepEqual(scanStateFixture(fixture).errorRoles, []);

    const nested = path.join(fixture.session, "nested");
    mkdirSync(nested, { mode: 0o700 });
    writeFileSync(path.join(nested, "chat_history.jsonl"),
      "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    const nestedResult = scanStateFixture(fixture);
    assert.ok(nestedResult.matchedRoles.includes("grok_session_other"));
    assert.ok(nestedResult.errorRoles.includes("grok_current_state_structure"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }

  for (const mutation of ["wrong-cwd", "wrong-session"]) {
    const wrong = stateFixture(`session-${mutation}`);
    try {
      const cwdComponent = mutation === "wrong-cwd" ? "wrong-cwd" : encodeURIComponent(wrong.cwd);
      const sessionComponent = mutation === "wrong-session"
        ? "22222222-2222-4222-8222-222222222222"
        : wrong.sessionId;
      const directory = path.join(wrong.home, "sessions", cwdComponent, sessionComponent);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(directory, "events.jsonl"),
        "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
      const result = scanStateFixture(wrong);
      assert.deepEqual(result.matchedRoles, ["grok_session_other"]);
      assert.deepEqual(result.errorRoles, ["grok_current_state_structure"]);
    } finally {
      rmSync(wrong.root, { recursive: true, force: true });
    }
  }
});

test("exact unified-log path, fields, and observed metadata values produce clean", () => {
  const fixture = metadataStateFixture("metadata-clean");
  try {
    writeUnifiedFrames(fixture, knownMetadataFrames());
    const result = scanStateFixture(fixture);
    assert.equal(result.status, "passed");
    assert.equal(result.scanOutcome, "clean");
    assert.deepEqual(result.matchedRoles, []);
    assert.deepEqual(result.errorRoles, []);

    const outside = path.join(fixture.root, "outside.jsonl");
    writeFileSync(outside, `${AUTH_METADATA_FIXTURE.userId}\n`, { mode: 0o600 });
    const outsideResult = scanAuthEvidenceTargets({
      phase: "first_turn_post_stop",
      patternPath: fixture.pattern,
      metadataManifestPath: fixture.metadataManifest,
      expectedIdentityPath: fixture.identity,
      targets: [{ role: "runtime_log_store", path: outside }],
    });
    assert.equal(outsideResult.scanOutcome, "match");
    assert.deepEqual(outsideResult.matchedRoles, ["runtime_log_store"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, rawFrame] of [
  ["unknown path", `{"ctx":{"nested":{"user_id":${JSON.stringify(AUTH_METADATA_FIXTURE.userId)}}}}`],
  ["unknown field", `{"ctx":{"account_id":${JSON.stringify(AUTH_METADATA_FIXTURE.userId)}}}`],
  ["unknown value", '{"ctx":{"user_id":"TEST225_USER_ID_UNKNOWN_0123456789"}}'],
]) {
  test(`raw-frame mutation: ${label} -> grok_unified_log_state match`, () => {
    const fixture = metadataStateFixture(`metadata-${label}`);
    try {
      // The mutation enters through the exact on-disk producer boundary. The
      // scanner must read these bytes, decode/parse them, project exact paths,
      // and verify the scope-bound tuple; no sanitized object is injected.
      writeRawUnifiedFrames(fixture, [rawFrame]);
      const result = scanStateFixture(fixture);
      assert.equal(result.status, "failed", label);
      assert.equal(result.scanOutcome, "match", label);
      assert.deepEqual(result.matchedRoles, ["grok_unified_log_state"], label);
      assert.deepEqual(result.errorRoles, [], label);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("raw-frame mutation: unknown role -> scan_boundary scan_error", () => {
  const fixture = metadataStateFixture("metadata-unknown-role");
  try {
    writeRawUnifiedFrames(fixture, knownMetadataFrames().map((frame) => JSON.stringify(frame)));
    const result = scanAuthEvidenceTargets({
      phase: "first_turn_post_stop",
      patternPath: fixture.pattern,
      metadataManifestPath: fixture.metadataManifest,
      expectedIdentityPath: fixture.identity,
      targets: [{ role: "grok_unknown_role", path: fixture.unified }],
    });
    assert.equal(result.status, "failed");
    assert.equal(result.scanOutcome, "scan_error");
    assert.deepEqual(result.matchedRoles, []);
    assert.deepEqual(result.errorRoles, ["scan_boundary"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("unified-log allowlist never hides a secret, moved value, or unknown log path", () => {
  for (const [label, frames, expectedOutcome] of [
    ["secret", [{ ctx: { user_id: AUTH_METADATA_FIXTURE.userId }, msg: AUTH_METADATA_FIXTURE.secret }], "match"],
    ["moved", [{ msg: AUTH_METADATA_FIXTURE.clientId }], "match"],
    ["scope-extra", [{ ctx: { scopes_on_disk: [AUTH_METADATA_FIXTURE.scope, "UNKNOWN_SCOPE_0123456789"] } }], "match"],
  ]) {
    const fixture = metadataStateFixture(`metadata-${label}`);
    try {
      writeUnifiedFrames(fixture, frames);
      assert.equal(scanStateFixture(fixture).scanOutcome, expectedOutcome, label);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  const fixture = metadataStateFixture("metadata-extra-log");
  try {
    writeUnifiedFrames(fixture, knownMetadataFrames());
    writeFileSync(path.join(fixture.logs, "other.jsonl"), "{}\n", { mode: 0o600 });
    const result = scanStateFixture(fixture);
    assert.ok(result.errorRoles.includes("grok_unified_log_scan"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("state files and directories enforce owner-only metadata at the scan boundary", () => {
  for (const mutation of ["file-mode", "file-special", "file-hardlink",
    "directory-mode", "directory-special",
    ...(process.getuid?.() === 0 ? ["file-owner", "directory-owner"] : [])]) {
    const fixture = stateFixture(`state-metadata-${mutation}`);
    try {
      mkdirSync(fixture.session, { recursive: true, mode: 0o700 });
      const target = path.join(fixture.session, "events.jsonl");
      writeFileSync(target, "clean\n", { mode: 0o600 });
      if (mutation === "file-mode") chmodSync(target, 0o640);
      if (mutation === "file-special") chmodSync(target, 0o4600);
      if (mutation === "file-hardlink") linkSync(target, path.join(fixture.root, "hardlink"));
      if (mutation === "directory-mode") chmodSync(fixture.session, 0o750);
      if (mutation === "directory-special") chmodSync(fixture.session, 0o1700);
      if (mutation === "file-owner") chownSync(target, 65534, 65534);
      if (mutation === "directory-owner") chownSync(fixture.session, 65534, 65534);
      assert.ok(scanStateFixture(fixture).errorRoles.includes("grok_current_state_structure"));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("rejects a clean state-root sibling whose name is not exact node-24hex", () => {
  const fixture = stateFixture("invalid-sibling");
  try {
    const invalid = path.join(fixture.state, `node-${"b".repeat(23)}`);
    mkdirSync(invalid, { mode: 0o700 });
    writeFileSync(path.join(invalid, "clean"), "clean\n", { mode: 0o600 });
    assert.ok(scanStateFixture(fixture).errorRoles.includes("grok_state_root_structure"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("requires the three exactly derived empty runtime locks", () => {
  const fixture = stateFixture("locks-exact");
  try {
    assert.deepEqual(scanStateFixture(fixture).errorRoles, []);
    writeFileSync(fixture.locks.session, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    const malicious = scanStateFixture(fixture);
    assert.deepEqual(malicious.matchedRoles, ["grok_runtime_lock_state"]);
    assert.deepEqual(malicious.errorRoles, ["grok_runtime_lock_scan"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects missing, extra, wrong-name, metadata, and link lock mutations", () => {
  for (const key of ["session", "leader", "bridge"]) {
    const fixture = stateFixture(`lock-missing-${key}`);
    try {
      rmSync(fixture.locks[key]);
      assert.deepEqual(scanStateFixture(fixture).errorRoles, ["grok_runtime_lock_scan"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  for (const [scope, basename] of [
    ["state", `.session-${"a".repeat(24)}.lock.suffix`],
    ["runtime", `.leader-${"b".repeat(20)}.lock.suffix`],
    ["runtime", `.bridge-${"c".repeat(20)}-${TEST_SESSION_ID}.lock`],
  ]) {
    const fixture = stateFixture("lock-extra");
    try {
      const directory = scope === "state"
        ? path.dirname(fixture.locks.session)
        : path.dirname(fixture.locks.leader);
      writeFileSync(path.join(directory, basename), "clean\n", { mode: 0o600 });
      const result = scanStateFixture(fixture);
      assert.ok(result.errorRoles.includes(
        "grok_runtime_lock_scan",
      ));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  for (const kind of ["mode", "special", "hardlink", "symlink",
    ...(process.getuid?.() === 0 ? ["owner"] : [])]) {
    const fixture = stateFixture(`lock-${kind}`);
    const lock = fixture.locks.session;
    const outside = path.join(fixture.root, "outside-lock");
    try {
      writeFileSync(outside, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
      rmSync(lock);
      if (kind === "hardlink") linkSync(outside, lock);
      else if (kind === "symlink") symlinkSync(outside, lock);
      else {
        writeFileSync(lock, "", { mode: 0o600 });
        if (kind === "mode") chmodSync(lock, 0o644);
        if (kind === "special") chmodSync(lock, 0o4600);
        if (kind === "owner") chownSync(lock, 65534, 65534);
      }
      assert.deepEqual(scanStateFixture(fixture).errorRoles, ["grok_runtime_lock_scan"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("binds state-root and current-home snapshots independently", async () => {
  await concurrentStateSnapshotMutation("root");
  await concurrentStateSnapshotMutation("home");
});

test("directory and earlier-file mutations fail closed at final commit", async () => {
  for (const kind of [
    "add",
    "delete",
    "rename",
    "append",
    "truncate",
    "overwrite",
    "nested_add",
    "aba",
    "replace",
  ]) {
    await concurrentDirectoryMutation(kind);
  }
});

test("absent targets stay bound through create, ABA, and parent replacement", async () => {
  for (const kind of ["create", "aba", "parent_replace"]) {
    await concurrentAbsentMutation(kind);
  }
});

test("malformed, truncated, permissive-mode, and extended files are rejected", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test225-auth-evidence-test-"));
  const output = path.join(root, "result.json");
  try {
    const canonical = JSON.stringify(diagnostic());
    const duplicateStatus = canonical.replace(
      '"status":"failed"',
      '"status":"passed","status":"failed"',
    );
    const reordered = JSON.stringify({
      gate: diagnostic().gate,
      v: diagnostic().v,
      status: diagnostic().status,
      phase: diagnostic().phase,
      scanOutcome: diagnostic().scanOutcome,
      matchedRoles: diagnostic().matchedRoles,
      errorRoles: diagnostic().errorRoles,
      detailWithheld: diagnostic().detailWithheld,
    });
    for (const value of [
      "",
      "{",
      JSON.stringify({ ...diagnostic(), account: "private" }),
      `${duplicateStatus}\n`,
      `${reordered}\n`,
    ]) {
      writeFileSync(output, value, { mode: 0o600 });
      assert.equal(readAndValidateAuthEvidenceDiagnostic(output), null);
    }
    writeFileSync(output, `${JSON.stringify(diagnostic())}\n`, { mode: 0o644 });
    chmodSync(output, 0o644);
    assert.equal(statSync(output).mode & 0o777, 0o644);
    // readAndValidate validates schema only; the CLI also enforces file metadata.
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), diagnostic());
    assert.equal(cliValidate(output), 1);
    chmodSync(output, 0o4600);
    assert.equal(cliValidate(output), 1);
    if (process.getuid?.() === 0) {
      chmodSync(output, 0o600);
      chownSync(output, 65534, 65534);
      assert.equal(cliValidate(output), 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
