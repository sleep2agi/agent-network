import { describe, expect, test } from "bun:test";
import type { HostSharedGenerationProof } from "./opencode-host-shared-generation.js";
import { fingerprintHostSharedGenerationProof as fingerprint } from "./opencode-host-shared-fingerprint.js";

const proof: HostSharedGenerationProof = {
  binaryPath: "/opt/opencode", dev: "12", ino: "34", size: "9007199254740993",
  sha256: "a".repeat(64), packageName: "@opencode/cli", packageVersion: "2.0.22",
  pid: 777, startTicks: 900, listenInode: "4242",
};

describe("host shared generation proof fingerprint", () => {
  test("is stable regardless of object property order", () => {
    const { listenInode, ...rest } = proof;
    expect(fingerprint({ ...proof })).toBe(fingerprint({ listenInode, ...rest }));
    expect(fingerprint(proof)).toBe("sha256:4d9a80eeda000469c2aa2f79b64f94ed2316cfdbf96bd5b474df0d8ff4e1982d");
  });

  test("every proof field affects the identifier", () => {
    const changes: Partial<HostSharedGenerationProof>[] = [
      { binaryPath: "/opt/other" }, { dev: "13" }, { ino: "35" },
      { size: "9007199254740992" }, { sha256: "b".repeat(64) },
      { packageName: "other" }, { packageVersion: "2.0.23" },
      { pid: 778 }, { startTicks: 901 }, { listenInode: "4243" },
    ];
    for (const change of changes) expect(fingerprint({ ...proof, ...change })).not.toBe(fingerprint(proof));
  });

  test("tuple encoding preserves boundaries and exact string values", () => {
    expect(fingerprint({ ...proof, dev: "1", ino: "23" }))
      .not.toBe(fingerprint({ ...proof, dev: "12", ino: "3" }));
    expect(fingerprint({ ...proof, packageName: 'a", "b', packageVersion: "c" }))
      .not.toBe(fingerprint({ ...proof, packageName: "a", packageVersion: 'b", "c' }));
    expect(fingerprint({ ...proof, dev: "01" })).not.toBe(fingerprint({ ...proof, dev: "1" }));
  });

  test("rejects missing, coerced and imprecise values", () => {
    for (const invalid of [undefined, null, "", 42]) {
      expect(() => fingerprint({ ...proof, dev: invalid } as HostSharedGenerationProof)).toThrow();
    }
    for (const invalid of [NaN, Infinity, -1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, "900"]) {
      expect(() => fingerprint({ ...proof, startTicks: invalid } as HostSharedGenerationProof)).toThrow();
    }
    for (const invalid of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "777"]) {
      expect(() => fingerprint({ ...proof, pid: invalid } as HostSharedGenerationProof)).toThrow();
    }
  });
});
