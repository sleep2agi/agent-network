import { expect, test } from "bun:test";
import { describeUmaskRisk, judgeUmask, rejectedPayloads } from "./package-mode-preflight";

// A umask BIT SET means "withhold". Getting this backwards is the whole reason
// this module exists as a tested function rather than an inline expression.
test("0002 — the Debian/Ubuntu default this machine runs — leaks group-write", () => {
  const v = judgeUmask(0o002);
  expect(v.willProduceUnsafeModes).toBe(true);
  expect(v.leaks).toEqual(["group"]);
  expect(v.umaskOctal).toBe("0002");
});

test("0022 withholds both write bits, so a fresh fetch passes the check", () => {
  const v = judgeUmask(0o022);
  expect(v.willProduceUnsafeModes).toBe(false);
  expect(v.leaks).toEqual([]);
  expect(describeUmaskRisk(v)).toBeNull();
});

test("0000 leaks both, and says so", () => {
  const v = judgeUmask(0o000);
  expect(v.leaks).toEqual(["group", "other"]);
  expect(describeUmaskRisk(v)).toContain("group and other-writable");
});

test("0077 is stricter than needed and still passes", () => {
  expect(judgeUmask(0o077).willProduceUnsafeModes).toBe(false);
});

test("the advice names both runtimes and the misleading symptom", () => {
  const msg = describeUmaskRisk(judgeUmask(0o002))!;
  expect(msg).toContain("grok-build-cli");
  expect(msg).toContain("opencode-cli");
  // The operator sees this string, not the mode check — connecting the two is
  // the entire point of surfacing it in doctor.
  expect(msg).toContain("Incompatible runtime");
  expect(msg).toContain("umask 0022");
});

const ME = 1000;

test("an already-extracted 0775/0664 payload is reported as rejected", () => {
  const found = rejectedPayloads([
    { path: "/n/dist/cli.js", uid: ME, mode: 0o775 },
    { path: "/n/package.json", uid: ME, mode: 0o664 },
  ], ME);
  expect(found).toHaveLength(2);
});

test("a correctly-extracted payload is not reported", () => {
  expect(rejectedPayloads([
    { path: "/n/dist/cli.js", uid: ME, mode: 0o755 },
    { path: "/n/package.json", uid: ME, mode: 0o644 },
  ], ME)).toHaveLength(0);
});

test("someone else's payload is rejected even at a safe mode", () => {
  expect(rejectedPayloads([{ path: "/n/dist/cli.js", uid: 0, mode: 0o755 }], ME)).toHaveLength(1);
});

test("nothing extracted yet reports nothing — absence is not a pass", () => {
  expect(rejectedPayloads([], ME)).toHaveLength(0);
});
