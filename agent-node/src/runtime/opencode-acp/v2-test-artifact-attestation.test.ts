import { expect, test } from "bun:test";
import { resolvePinnedOpencodeBinaryAttestation, revalidatePinnedOpencodeBinary } from "./binary";
import { chmodSync, copyFileSync, mkdirSync, openSync, closeSync, writeSync, unlinkSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";

const path = "/tmp/opencode/anet-4099-test-only-29040e2/cli/cli-linux-x64/bin/opencode";
test.skipIf(process.env.ANET_TEST_ARTIFACT_COPY === "1")("isolated explicit TEST-ONLY artifact provenance is exact and revalidated", () => {
  const previous = process.env.ANET_VARIANT_TEST_ONLY;
  try {
    delete process.env.ANET_VARIANT_TEST_ONLY;
    expect(() => resolvePinnedOpencodeBinaryAttestation({ generation: "v2", requestedBinary: path })).toThrow();
    process.env.ANET_VARIANT_TEST_ONLY = "1";
    expect(() => resolvePinnedOpencodeBinaryAttestation({ generation: "v2", requestedBinary: `${path}-other` })).toThrow();
    expect(() => resolvePinnedOpencodeBinaryAttestation({ generation: "v2", requestedBinary: path, forbiddenRoots: ["/tmp/opencode"] })).toThrow(/overlaps/);
    const attestation = resolvePinnedOpencodeBinaryAttestation({ generation: "v2", requestedBinary: path, probeEnv: { HOME: "/safe", PATH: "/usr/bin:/bin" }, probeCwd: "/safe" });
    expect(attestation.provenance).toBe("anet-test-only-artifact");
    expect(attestation.expectedVersion).toBe("2.0.22-anet-test.29040e2");
    expect(revalidatePinnedOpencodeBinary(attestation)).toBe(path);
    expect(() => revalidatePinnedOpencodeBinary({ ...attestation, expectedVersion: "2.0.22" })).toThrow();
    delete process.env.ANET_VARIANT_TEST_ONLY;
    expect(() => revalidatePinnedOpencodeBinary(attestation)).toThrow();
  } finally {
    if (previous === undefined) delete process.env.ANET_VARIANT_TEST_ONLY;
    else process.env.ANET_VARIANT_TEST_ONLY = previous;
  }
});

test.skipIf(process.env.ANET_TEST_ARTIFACT_COPY !== "1")("isolated artifact byte replacement and symlink fail closed", () => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  copyFileSync("/source/opencode", path);
  chmodSync(path, 0o755);
  process.env.ANET_VARIANT_TEST_ONLY = "1";
  const attestation = resolvePinnedOpencodeBinaryAttestation({ generation: "v2", requestedBinary: path, probeEnv: { HOME: "/safe", PATH: "/usr/bin:/bin" }, probeCwd: "/safe" });
  const fd = openSync(path, "r+");
  try { writeSync(fd, Buffer.from([0]), 0, 1, 0); } finally { closeSync(fd); }
  expect(() => revalidatePinnedOpencodeBinary(attestation)).toThrow(/hash/);
  expect(() => resolvePinnedOpencodeBinaryAttestation({ generation: "v2", requestedBinary: path })).toThrow(/hash/);
  unlinkSync(path);
  symlinkSync("/source/opencode", path);
  expect(() => revalidatePinnedOpencodeBinary(attestation)).toThrow();
  expect(() => resolvePinnedOpencodeBinaryAttestation({ generation: "v2", requestedBinary: path })).toThrow();
  delete process.env.ANET_VARIANT_TEST_ONLY;
});
