import { homedir } from "node:os";
import { join } from "node:path";
import {
  waitForStartResources,
  type StartGateDeps,
  type StartGateResult,
} from "./start-resource-gate";

/** A measured 500 MiB legacy recovery peaked at 8.4x its rollout size. Nine
 * times the rollout leaves a small margin while remaining an explainable,
 * testable admission estimate rather than pretending maxPayload bounds Codex. */
export const CODEX_RECOVERY_MEMORY_MULTIPLIER = 9;
export const CODEX_RECOVERY_MIN_MEMORY_MB = 4096;

export function estimatedCodexRecoveryMemoryMb(rolloutBytes: number | null): number {
  if (rolloutBytes === null || !Number.isFinite(rolloutBytes) || rolloutBytes < 0) {
    return CODEX_RECOVERY_MIN_MEMORY_MB;
  }
  return Math.max(
    CODEX_RECOVERY_MIN_MEMORY_MB,
    Math.ceil((rolloutBytes / 1024 ** 2) * CODEX_RECOVERY_MEMORY_MULTIPLIER),
  );
}

export interface CodexRecoveryGateDeps extends StartGateDeps {
  /** @internal seam: the shared start gate owns locking and stale-lease safety. */
  gate?: typeof waitForStartResources;
}

/** Serialize the memory-heavy legacy resume phase and require enough effective
 * MemAvailable for this rollout. The returned lease stays held through the
 * launcher, bridge and TUI attachment and must then be released. */
export async function waitForCodexRecoveryResources(
  nodeId: string,
  rolloutBytes: number | null,
  deps: CodexRecoveryGateDeps = {},
): Promise<StartGateResult> {
  const requiredMb = estimatedCodexRecoveryMemoryMb(rolloutBytes);
  const env = { ...(deps.env ?? process.env) };
  const configuredFloor = Number(env.ANET_START_MIN_MEM_MB);
  env.ANET_START_MIN_MEM_MB = String(Math.max(
    requiredMb,
    Number.isFinite(configuredFloor) && configuredFloor > 0 ? configuredFloor : 0,
  ));
  // The app-server start lease is deliberately released once the port binds.
  // Recovery has its own host-wide lane because Codex materializes a whole
  // legacy response frame after that point.
  env.ANET_START_MAX_CONCURRENT = "1";
  const slotsDir = deps.slotsDir
    ?? env.ANET_CODEX_RECOVERY_SLOTS_DIR?.trim()
    ?? join(homedir(), ".anet", "run", "codex-recovery-slots");
  deps.log?.(`[recovery-gate] reserving one lane and ${requiredMb} MiB for ${rolloutBytes === null ? "unknown rollout" : `${(rolloutBytes / 1024 ** 2).toFixed(1)} MiB rollout`}`);
  const gate = deps.gate ?? waitForStartResources;
  const { gate: _gate, ...gateDeps } = deps;
  return gate("codex legacy recovery", { ...gateDeps, env, slotsDir, nodeId });
}
