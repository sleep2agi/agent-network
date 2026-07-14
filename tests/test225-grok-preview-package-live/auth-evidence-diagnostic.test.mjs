import assert from "node:assert/strict";
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
  makeAuthEvidenceDiagnostic,
  readAndValidateAuthEvidenceDiagnostic,
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

test("emits only canonical reviewed phases and target-role enums", () => {
  assert.deepEqual(diagnostic(), {
    v: 1,
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
      if (role === "scan_boundary" || role === "grok_runtime_socket_state") continue;
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
  }).scanOutcome, "unclassified");
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
    { ...base, v: 2 },
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
  const home = path.join(state, "node");
  const session = path.join(home, "sessions", "cwd", "session");
  const pattern = path.join(root, "patterns");
  const expectedIdentity = path.join(source, "agent_id");
  try {
    for (const directory of [source, state, home, path.dirname(path.dirname(session)), path.dirname(session), session]) {
      try { mkdirSync(directory, { mode: 0o700 }); } catch {}
    }
    writeFileSync(pattern, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    writeFileSync(expectedIdentity, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    const otherIdentity = path.join(source, "other");
    writeFileSync(otherIdentity, "clean\n", { mode: 0o600 });
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
      targets: [
        { role: "__grok_state__", path: state },
        { role: "runtime_log_store", path: directLink },
      ],
    }), {
      v: 1,
      gate: "real_auth_evidence_scan",
      status: "failed",
      phase: "first_turn_post_stop",
      scanOutcome: "mixed",
      matchedRoles: ["grok_identity_state", "grok_session_chat"],
      errorRoles: ["runtime_log_store", "grok_identity_state", "grok_session_other"],
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

test("accepts only the two exact owner-bound one-level runtime sockets", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "test225-auth-evidence-socket-"));
  const state = path.join(root, "state");
  const home = path.join(state, "node");
  const run = path.join(home, "run");
  const nested = path.join(run, "nested");
  const pattern = path.join(root, "patterns");
  const identity = path.join(root, "agent_id");
  const leader = path.join(run, "leader.sock");
  const attach = path.join(run, "attach.sock");
  const wrongName = path.join(run, "other.sock");
  const wrongDepth = path.join(nested, "leader.sock");
  const servers = [];
  try {
    for (const directory of [state, home, run, nested]) mkdirSync(directory, { mode: 0o700 });
    writeFileSync(pattern, "PRIVATE_AUTH_SCALAR_0123456789\n", { mode: 0o600 });
    writeFileSync(identity, "clean\n", { mode: 0o600 });
    servers.push(await listenUnix(leader));
    servers.push(await listenUnix(attach));

    const clean = scanAuthEvidenceTargets({
      phase: "resume_turn_pre_stop",
      patternPath: pattern,
      expectedIdentityPath: identity,
      expectedLeaderSocket: leader,
      expectedAttachSocket: attach,
      targets: [{ role: "__grok_state__", path: state }],
    });
    assert.equal(clean.scanOutcome, "unclassified");
    assert.deepEqual(clean.errorRoles, []);

    assert.deepEqual(scanAuthEvidenceTargets({
      phase: "resume_turn_pre_stop",
      patternPath: pattern,
      expectedIdentityPath: identity,
      expectedLeaderSocket: path.join(run, "wrong-expected-leader.sock"),
      expectedAttachSocket: attach,
      targets: [{ role: "__grok_state__", path: state }],
    }).errorRoles, ["grok_runtime_socket_state"]);

    servers.push(await listenUnix(wrongName));
    servers.push(await listenUnix(wrongDepth));
    assert.deepEqual(scanAuthEvidenceTargets({
      phase: "resume_turn_pre_stop",
      patternPath: pattern,
      expectedIdentityPath: identity,
      expectedLeaderSocket: leader,
      expectedAttachSocket: attach,
      targets: [{ role: "__grok_state__", path: state }],
    }).errorRoles, ["grok_unclassified_state"]);

    await closeUnix(servers.pop());
    await closeUnix(servers.pop());
    await closeUnix(servers.pop());
    rmSync(attach, { force: true });
    writeFileSync(attach, "not-a-socket\n", { mode: 0o600 });
    assert.deepEqual(scanAuthEvidenceTargets({
      phase: "resume_turn_pre_stop",
      patternPath: pattern,
      expectedIdentityPath: identity,
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
