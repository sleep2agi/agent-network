import { describe, expect, it } from "bun:test";
import { isOwnedTestBuild, observeSharedTestBuild } from "./v2-test-build-identity";

describe("local test build identity", () => {
  const base = { platform: "linux" as const, version: "2.0.22-anet-test.29040e2", childPid: 42, serverPid: 42 };
  const good = async () => "1cf5fcccf345438316db82d4c63c5df5f5010cc94a8465e1a119f9639c53c786";
  it("requires the exact owned process and executable digest, not a version assertion", async () => {
    expect(await isOwnedTestBuild({ ...base, hashExecutable: good })).toBe(true);
    expect(await isOwnedTestBuild({ ...base, childPid: undefined, hashExecutable: good })).toBe(false);
    expect(await isOwnedTestBuild({ ...base, serverPid: 43, hashExecutable: good })).toBe(false);
    expect(await isOwnedTestBuild({ ...base, version: "2.0.22", hashExecutable: good })).toBe(false);
    expect(await isOwnedTestBuild({ ...base, version: `${base.version}.fake`, hashExecutable: good })).toBe(false);
    expect(await isOwnedTestBuild({ ...base, hashExecutable: async () => "0".repeat(64) })).toBe(false);
    expect(await isOwnedTestBuild({ ...base, hashExecutable: async () => { throw Error("denied"); } })).toBe(false);
  });
  it("shared process evidence rejects non-loopback, stock versions and absent listeners", async () => {
    expect(await observeSharedTestBuild("http://localhost:1", base.version)).toBeUndefined();
    expect(await observeSharedTestBuild("http://127.0.0.1:1", "2.0.22")).toBeUndefined();
    expect(await observeSharedTestBuild("http://127.0.0.1:1", base.version)).toBeUndefined();
  });
});
