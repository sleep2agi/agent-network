import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = "/repo/agent-network";
function witnessedRed(path, from, to, testFile, witness, cwd = root) {
  const original = readFileSync(path, "utf8");
  if (!original.includes(from)) throw new Error(`mutation anchor missing: ${from}`);
  writeFileSync(path, original.replace(from, to));
  try {
    const result = spawnSync("bun", ["test", testFile], { cwd, encoding: "utf8" });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status === 0 || !output.includes(witness)) {
      throw new Error(`mutation did not fail on assertion (${testFile}, rc=${result.status})\n${output}`);
    }
    console.log(`WITNESSED_RED ${testFile}: ${witness}`);
  } finally {
    writeFileSync(path, original);
  }
}

witnessedRed(
  `${root}/src/codex-copresence-recovery.ts`,
  "const copied = copyAndHashRecoveryFile(source, target);",
  "const copied = info.size > 2 * 1024 ** 3 ? (() => { throw new Error(\"WHOLE_FILE_READ_LIMIT\"); })() : copyAndHashRecoveryFile(source, target);",
  "src/codex-copresence-recovery.test.ts",
  "WHOLE_FILE_READ_LIMIT",
);
witnessedRed(
  `${root}/src/codex-copresence-rpc.ts`,
  'method === "thread/resume" ? Math.max(1, deadline - Date.now()) : 15_000',
  'method === "thread/resume" ? 20 : 15_000',
  "src/codex-copresence-rpc.test.ts",
  "request thread/resume timeout",
);
witnessedRed(
  "/repo/agent-node/src/runtime/codex-app-server-bridge.ts",
  "if (this.isDeferredThreadMaterialized && !await this.isDeferredThreadMaterialized(id)) {",
  "if (false && this.isDeferredThreadMaterialized && !await this.isDeferredThreadMaterialized(id)) {",
  "src/runtime/codex-app-server-bridge.test.ts",
  "an acknowledged but never-materialized fresh candidate",
  "/repo/agent-node",
);
witnessedRed(
  "/repo/agent-node/src/runtime/codex-app-server/runtime.ts",
  "deferredThreadTimeoutMs: resumeTimeoutMs,",
  "deferredThreadTimeoutMs: 20_000,",
  "src/runtime/codex-app-server/resume-timeout.test.ts",
  "one ANET_CODEX_RESUME_TIMEOUT_MS-derived value governs resume and fresh-thread materialization",
  "/repo/agent-node",
);
witnessedRed(
  `${root}/src/codex-pending-thread-restart.ts`,
  "return found.length === 0",
  "return false",
  "src/codex-pending-thread-restart.test.ts",
  "marker on disk and bound to it but no rollout",
);
witnessedRed(
  `${root}/src/codex-copresence-resume-timeout.ts`,
  "return newSession ? undefined : recordedThreadId;",
  "return recordedThreadId;",
  "src/codex-copresence-resume-timeout.test.ts",
  "--new-session suppresses the recorded co-presence thread",
);
