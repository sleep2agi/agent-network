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

function mutateLargePayloadCeiling() {
  const original = readFileSync("/repo/agent-network/src/codex-copresence-resume-timeout.ts", "utf8");
  const before = "export const CODEX_RECOVERY_MAX_PAYLOAD_BYTES = 1536 * 1024 ** 2;";
  if (!original.includes(before)) throw new Error("large-payload mutation anchor missing");
  writeFileSync("/repo/agent-network/src/codex-copresence-resume-timeout.ts", original.replace(before, "export const CODEX_RECOVERY_MAX_PAYLOAD_BYTES = 100 * 1024 ** 2;"));
  try { assertRed("src/codex-copresence-rpc.test.ts", "Node recovery lifts the fixed WebSocket frame ceiling"); }
  finally { writeFileSync("/repo/agent-network/src/codex-copresence-resume-timeout.ts", original); }
}

function mutateTransportClose() {
  const original = readFileSync("/repo/agent-network/src/codex-copresence-rpc.ts", "utf8");
  const before = "    rejectPending(socketFailure ?? new Error(`Codex app-server WebSocket closed (code ${event?.code ?? \"unknown\"})${reason}`));";
  if (!original.includes(before)) throw new Error("transport-close mutation anchor missing");
  writeFileSync("/repo/agent-network/src/codex-copresence-rpc.ts", original.replace(before, "    // mutation: leave requests waiting until the deadline"));
  try { assertRed("src/codex-copresence-rpc.test.ts", "a broken large-payload connection fails immediately"); }
  finally { writeFileSync("/repo/agent-network/src/codex-copresence-rpc.ts", original); }
}

function mutateBridgePayloadCeiling() {
  const original = readFileSync("/repo/agent-node/src/runtime/codex-app-server/runtime.ts", "utf8");
  const before = "      maxPayloadBytes: resolveRecoveryMaxPayloadBytes(opts.threadId, { ...process.env, ...(opts.codexHome ? { CODEX_HOME: opts.codexHome } : {}) }),";
  if (!original.includes(before)) throw new Error("bridge payload mutation anchor missing");
  writeFileSync("/repo/agent-node/src/runtime/codex-app-server/runtime.ts", original.replace(before, "      // mutation: bridge uses the runtime's fixed receive ceiling"));
  try { assertRed("src/runtime/codex-app-server/resume-timeout.test.ts", "runtime gives the bridge the bounded payload option", "/repo/agent-node"); }
  finally { writeFileSync("/repo/agent-node/src/runtime/codex-app-server/runtime.ts", original); }
}

function mutateBridgeTransportClose() {
  const original = readFileSync("/repo/agent-node/src/runtime/codex-app-server-client.ts", "utf8");
  const before = "        for (const [, pending] of this.pending) pending.reject(error);";
  if (!original.includes(before)) throw new Error("bridge transport-close mutation anchor missing");
  writeFileSync("/repo/agent-node/src/runtime/codex-app-server-client.ts", original.replace(before, "        // mutation: leave bridge requests pending until their deadline"));
  try { assertRed("src/runtime/codex-app-server-client.test.ts", "a transport error rejects an in-flight request immediately", "/repo/agent-node"); }
  finally { writeFileSync("/repo/agent-node/src/runtime/codex-app-server-client.ts", original); }
}

function mutateBridgePayloadUpperBound() {
  const original = readFileSync("/repo/agent-node/src/runtime/codex-app-server/resume-timeout.ts", "utf8");
  const before = "    RECOVERY_MAX_PAYLOAD_BYTES,\n    Math.max(RECOVERY_MIN_PAYLOAD_BYTES, rolloutBytes * 2 + 64 * 1024 ** 2),";
  if (!original.includes(before)) throw new Error("bridge payload upper-bound mutation anchor missing");
  writeFileSync("/repo/agent-node/src/runtime/codex-app-server/resume-timeout.ts", original.replace(before, "    Number.MAX_SAFE_INTEGER,\n    Math.max(RECOVERY_MIN_PAYLOAD_BYTES, rolloutBytes * 2 + 64 * 1024 ** 2),"));
  try { assertRed("src/runtime/codex-app-server/resume-timeout.test.ts", "rollout-derived payload sizing is finite and capped", "/repo/agent-node"); }
  finally { writeFileSync("/repo/agent-node/src/runtime/codex-app-server/resume-timeout.ts", original); }
}

function mutateBridgeCloseToNewThread() {
  const original = readFileSync("/repo/agent-node/src/runtime/codex-app-server-bridge.ts", "utf8");
  const before = "        if (!isNoRollout(e)) throw e;";
  if (!original.includes(before)) throw new Error("bridge close fallback mutation anchor missing");
  writeFileSync("/repo/agent-node/src/runtime/codex-app-server-bridge.ts", original.replace(before, "        if (false) throw e;"));
  try { assertRed("src/runtime/codex-app-server/resume-timeout.test.ts", "a transport close during resume fails closed and never starts a replacement thread", "/repo/agent-node"); }
  finally { writeFileSync("/repo/agent-node/src/runtime/codex-app-server-bridge.ts", original); }
}

function mutateRecoveryGateWiring() {
  const original = readFileSync("/repo/agent-network/bin/cli.ts", "utf8");
  const before = "recoveryAdmission = await holdCodexRecovery(nodeId, resumeBudget.rolloutBytes);";
  if (!original.includes(before)) throw new Error("recovery gate wiring mutation anchor missing");
  writeFileSync("/repo/agent-network/bin/cli.ts", original.replace(before, "// mutation: POSIX legacy recovery bypasses the host quota"));
  try { assertRed("src/codex-recovery-resource-gate.test.ts", "both native launchers hold the recovery lease through TUI attribution"); }
  finally { writeFileSync("/repo/agent-network/bin/cli.ts", original); }
}

function mutateRecoveryLeaseHeartbeat() {
  const paths = [
    "/repo/agent-network/src/start-resource-gate.ts",
    "/repo/agent-node/src/runtime/codex-app-server/start-resource-gate.ts",
  ];
  const originals = paths.map((path) => readFileSync(path, "utf8"));
  const before = "    heartbeatTimer = setInterval(() => {";
  if (originals.some((source) => !source.includes(before))) throw new Error("recovery lease heartbeat mutation anchor missing");
  for (let i = 0; i < paths.length; i++) writeFileSync(paths[i], originals[i].replace(before, "    if (false) heartbeatTimer = setInterval(() => {"));
  try { assertRed("src/codex-recovery-resource-gate.test.ts", "a live holder renews past TTL; SIGKILL permits takeover within one TTL"); }
  finally { for (let i = 0; i < paths.length; i++) writeFileSync(paths[i], originals[i]); }
}

function mutateBridgeAttachBudget() {
  const original = readFileSync("/repo/agent-network/bin/cli.ts", "utf8");
  const before = "resolveCopresenceBridgeAttachTimeoutMs(resumeBudget.timeoutMs)";
  if (!original.includes(before)) throw new Error("bridge attach mutation anchor missing");
  writeFileSync("/repo/agent-network/bin/cli.ts", original.replace(before, "25_000"));
  try { assertRed("src/codex-copresence-resume-timeout.test.ts", "both launchers give bridge and TUI the finite payload/recovery budget"); }
  finally { writeFileSync("/repo/agent-network/bin/cli.ts", original); }
}

function mutateTuiRecoveryBudget() {
  const original = readFileSync("/repo/agent-network/bin/cli.ts", "utf8");
  const before = "const TUI_PAINT_TIMEOUT_MS = resolveCopresenceBridgeAttachTimeoutMs(recoveryTimeoutMs);";
  if (!original.includes(before)) throw new Error("TUI recovery-budget mutation anchor missing");
  writeFileSync("/repo/agent-network/bin/cli.ts", original.replace(before, "const TUI_PAINT_TIMEOUT_MS = 40_000;"));
  try { assertRed("src/codex-copresence-resume-timeout.test.ts", "both launchers give bridge and TUI the finite payload/recovery budget"); }
  finally { writeFileSync("/repo/agent-network/bin/cli.ts", original); }
}

function mutateExperimentalFallback() {
  const original = readFileSync("/repo/agent-network/src/codex-copresence-recovery.ts", "utf8");
  const before = "(code === -32602 || code === -32600)";
  if (!original.includes(before)) throw new Error("experimental fallback mutation anchor missing");
  writeFileSync("/repo/agent-network/src/codex-copresence-recovery.ts", original.replace(before, "(code === -32602)"));
  try { assertRed("src/codex-copresence-rpc.test.ts", "falls back once when a real Codex shape rejects excludeTurns"); }
  finally { writeFileSync("/repo/agent-network/src/codex-copresence-recovery.ts", original); }
}

function mutateMetadataOnlyHistory() {
  const original = readFileSync("/repo/agent-network/src/codex-copresence-recovery.ts", "utf8");
  const before = "if (!persistedPath) {";
  if (!original.includes(before)) throw new Error("metadata-only mutation anchor missing");
  writeFileSync("/repo/agent-network/src/codex-copresence-recovery.ts", original.replace(before, "if (!persistedPath || turns.length === 0) {"));
  try { assertRed("src/codex-copresence-recovery.test.ts", "resume requires exact thread identity and persisted history"); }
  finally { writeFileSync("/repo/agent-network/src/codex-copresence-recovery.ts", original); }
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

function mutateWindowsPendingBehavior() {
  const original = readFileSync("/repo/agent-network/src/codex-pending-thread-restart.ts", "utf8");
  const before = 'if (decision.kind !== "drop-unmaterialized") return { ...decision, config, changed: false };';
  if (!original.includes(before)) throw new Error("Windows pending behavior mutation anchor missing");
  writeFileSync("/repo/agent-network/src/codex-pending-thread-restart.ts", original.replace(before, 'if (true) return { ...decision, config, changed: false };'));
  try { assertRed("src/codex-pending-thread-restart.test.ts", "Windows start -> stop -> start drops an unmaterialized pending thread"); }
  finally { writeFileSync("/repo/agent-network/src/codex-pending-thread-restart.ts", original); }
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
mutateLargePayloadCeiling();
mutateTransportClose();
mutateBridgePayloadCeiling();
mutateBridgeTransportClose();
mutateBridgePayloadUpperBound();
mutateBridgeCloseToNewThread();
mutateRecoveryGateWiring();
mutateRecoveryLeaseHeartbeat();
mutateBridgeAttachBudget();
mutateTuiRecoveryBudget();
mutateExperimentalFallback();
mutateMetadataOnlyHistory();
mutateDeferredMaterialization();
mutateDeferredTimeout();
mutatePendingRollout();
mutateNewSession();
mutateWindowsPendingPersistence();
mutateWindowsPendingBehavior();
mutateBackupFailOpen();
mutatePartialBackupCleanup();
mutateReservedEnvironment();
