import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function assertRed(testFile, witness, cwd = "/repo/agent-network") {
  const result = spawnSync("bun", ["test", testFile], { cwd, encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0 || !output.includes(witness)) {
    throw new Error(`mutation did not fail on assertion (${testFile}, rc=${result.status})\n${output}`);
  }
  console.log(`WITNESSED_RED ${testFile}: ${witness}`);
}

function mutateStreamingCopy() {
  const original = readFileSync("/repo/agent-network/src/codex-copresence-recovery.ts", "utf8");
  const before = "const copied = copyAndHashRecoveryFile(source, target);";
  if (!original.includes(before)) throw new Error("streaming-copy mutation anchor missing");
  writeFileSync("/repo/agent-network/src/codex-copresence-recovery.ts", original.replace(before, "const copied = info.size > 2 * 1024 ** 3 ? (() => { throw new Error(\"WHOLE_FILE_READ_LIMIT\"); })() : copyAndHashRecoveryFile(source, target);"));
  try { assertRed("src/codex-copresence-recovery.test.ts", "WHOLE_FILE_READ_LIMIT"); }
  finally { writeFileSync("/repo/agent-network/src/codex-copresence-recovery.ts", original); }
}

function mutateSharedDeadline() {
  const original = readFileSync("/repo/agent-network/src/codex-copresence-rpc.ts", "utf8");
  const before = '(method, params) => request(method, params, Math.max(1, deadline - Date.now()))';
  if (!original.includes(before)) throw new Error("shared-deadline mutation anchor missing");
  writeFileSync("/repo/agent-network/src/codex-copresence-rpc.ts", original.replace(before, '(method, params) => request(method, params, 15)'));
  try { assertRed("src/codex-copresence-rpc.test.ts", "metadata verification shares the recovery deadline"); }
  finally { writeFileSync("/repo/agent-network/src/codex-copresence-rpc.ts", original); }
}

function mutateDeferredMaterialization() {
  const original = readFileSync("/repo/agent-node/src/runtime/codex-app-server-bridge.ts", "utf8");
  const before = "if (this.isDeferredThreadMaterialized && !await this.isDeferredThreadMaterialized(id)) {";
  if (!original.includes(before)) throw new Error("deferred-materialization mutation anchor missing");
  writeFileSync("/repo/agent-node/src/runtime/codex-app-server-bridge.ts", original.replace(before, "if (false && this.isDeferredThreadMaterialized && !await this.isDeferredThreadMaterialized(id)) {"));
  try { assertRed("src/runtime/codex-app-server-bridge.test.ts", "an acknowledged but never-materialized fresh candidate", "/repo/agent-node"); }
  finally { writeFileSync("/repo/agent-node/src/runtime/codex-app-server-bridge.ts", original); }
}

function mutateDeferredTimeout() {
  const original = readFileSync("/repo/agent-node/src/runtime/codex-app-server/runtime.ts", "utf8");
  const before = "deferredThreadTimeoutMs: resumeTimeoutMs,";
  if (!original.includes(before)) throw new Error("deferred-timeout mutation anchor missing");
  writeFileSync("/repo/agent-node/src/runtime/codex-app-server/runtime.ts", original.replace(before, "deferredThreadTimeoutMs: 20_000,"));
  try { assertRed("src/runtime/codex-app-server/resume-timeout.test.ts", "one ANET_CODEX_RESUME_TIMEOUT_MS-derived value governs resume and fresh-thread materialization", "/repo/agent-node"); }
  finally { writeFileSync("/repo/agent-node/src/runtime/codex-app-server/runtime.ts", original); }
}

function mutatePendingRollout() {
  const original = readFileSync("/repo/agent-network/src/codex-pending-thread-restart.ts", "utf8");
  const before = "return found.length === 0";
  if (!original.includes(before)) throw new Error("pending-rollout mutation anchor missing");
  writeFileSync("/repo/agent-network/src/codex-pending-thread-restart.ts", original.replace(before, "return false"));
  try { assertRed("src/codex-pending-thread-restart.test.ts", "marker on disk and bound to it but no rollout"); }
  finally { writeFileSync("/repo/agent-network/src/codex-pending-thread-restart.ts", original); }
}

function mutateNewSession() {
  const original = readFileSync("/repo/agent-network/src/codex-copresence-resume-timeout.ts", "utf8");
  const before = "return newSession ? undefined : recordedThreadId;";
  if (!original.includes(before)) throw new Error("new-session mutation anchor missing");
  writeFileSync("/repo/agent-network/src/codex-copresence-resume-timeout.ts", original.replace(before, "return recordedThreadId;"));
  try { assertRed("src/codex-copresence-resume-timeout.test.ts", "--new-session suppresses the recorded co-presence thread"); }
  finally { writeFileSync("/repo/agent-network/src/codex-copresence-resume-timeout.ts", original); }
}

function mutateWindowsPendingPersistence() {
  const original = readFileSync("/repo/agent-network/bin/cli.ts", "utf8");
  const before = "      atomicWritePrivateJson(recoveryCfgPath, recoveryCfg);";
  if (!original.includes(before)) throw new Error("Windows-pending mutation anchor missing");
  writeFileSync("/repo/agent-network/bin/cli.ts", original.replace(before, "      // mutation: dropped pending state was not persisted"));
  try { assertRed("src/codex-pending-thread-restart.test.ts", "Windows uses the same pending-thread decision"); }
  finally { writeFileSync("/repo/agent-network/bin/cli.ts", original); }
}

function mutateBackupFailOpen() {
  const original = readFileSync("/repo/agent-network/bin/cli.ts", "utf8");
  const before = "persistCodexRecoveryPoint(resolved, opts.codexHome, opts.skipRecoveryBackup === true)";
  if (!original.includes(before)) throw new Error("backup-fail-open mutation anchor missing");
  writeFileSync("/repo/agent-network/bin/cli.ts", original.replace(before, "persistCodexRecoveryPoint(resolved, opts.codexHome, true)"));
  try { assertRed("src/codex-copresence-recovery.test.ts", "launcher is fail-closed unless the operator explicitly skips recovery backup"); }
  finally { writeFileSync("/repo/agent-network/bin/cli.ts", original); }
}

function mutatePartialBackupCleanup() {
  const original = readFileSync("/repo/agent-network/src/codex-copresence-recovery.ts", "utf8");
  const before = "    rmSync(backupDir, { recursive: true, force: true });";
  if (!original.includes(before)) throw new Error("partial-backup cleanup mutation anchor missing");
  writeFileSync("/repo/agent-network/src/codex-copresence-recovery.ts", original.replace(before, "    // mutation: leave the partial recovery directory behind"));
  try { assertRed("src/codex-copresence-recovery.test.ts", "recursive snapshot rejects symlinks"); }
  finally { writeFileSync("/repo/agent-network/src/codex-copresence-recovery.ts", original); }
}

function mutateReservedEnvironment() {
  const original = readFileSync("/repo/agent-network/src/codex-copresence-env.ts", "utf8");
  const before = "    if (isReservedEnvKey(canonical)) throw new Error(`config.env.${key} is reserved and cannot enter Codex co-presence`);";
  if (!original.includes(before)) throw new Error("reserved-environment mutation anchor missing");
  writeFileSync("/repo/agent-network/src/codex-copresence-env.ts", original.replace(before, "    // mutation: reserved loader variables are allowed"));
  try { assertRed("src/codex-copresence-env.test.ts", "rejects PATH and loader hooks"); }
  finally { writeFileSync("/repo/agent-network/src/codex-copresence-env.ts", original); }
}

mutateStreamingCopy();
mutateSharedDeadline();
mutateDeferredMaterialization();
mutateDeferredTimeout();
mutatePendingRollout();
mutateNewSession();
mutateWindowsPendingPersistence();
mutateBackupFailOpen();
mutatePartialBackupCleanup();
mutateReservedEnvironment();
