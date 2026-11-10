import { createHash } from "node:crypto";
import type { HostSharedGenerationProof } from "./opencode-host-shared-generation.js";

/**
 * Stable identifier for an already verified proof, not verification itself.
 * It grants no access and proves neither source-node nor session ownership.
 * Callers must independently validate and revalidate the live proof.
 * The versioned JSON tuple preserves field boundaries and exact string values.
 */
export function fingerprintHostSharedGenerationProof(proof: HostSharedGenerationProof): string {
  const strings = [proof.binaryPath, proof.dev, proof.ino, proof.size, proof.sha256,
    proof.packageName, proof.packageVersion, proof.listenInode];
  if (strings.some(value => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("invalid generation proof string");
  }
  if (!Number.isSafeInteger(proof.pid) || proof.pid <= 0 ||
      !Number.isSafeInteger(proof.startTicks) || proof.startTicks < 0 || Object.is(proof.startTicks, -0)) {
    throw new TypeError("invalid generation proof number");
  }
  const tuple = ["anet-host-shared-generation-proof-v1", proof.binaryPath, proof.dev,
    proof.ino, proof.size, proof.sha256, proof.packageName, proof.packageVersion,
    proof.pid, proof.startTicks, proof.listenInode];
  return `sha256:${createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex")}`;
}
