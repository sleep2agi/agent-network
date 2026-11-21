import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgyReadiness } from "./readiness";

// 2026-11-22 — agy 的自动升级关不掉，版本只能当「建议」用：
// 既不能因为版本不匹配把节点打死（那是以前的行为），
// 也要留一个显式的严格开关给回归基线用。
//
// 用 stub 二进制跑真实 spawn，覆盖的是 checkAgyReadiness 的判定本身，
// 不是 parseAgyVersion 这种纯函数。

const isWindows = process.platform === "win32";

function writeStub(dir: string, opts: { version: string | null; acp: boolean }): string {
  const bin = join(dir, "agy-stub.sh");
  const versionLine = opts.version ? `echo "${opts.version}"` : `echo "not a version"`;
  const acpLine = opts.acp ? `echo "Agent Client Protocol"` : `echo "unknown subcommand"; exit 1`;
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then ${versionLine}; exit 0; fi
if [ "$1" = "acp" ]; then ${acpLine}; fi
exit 0
`,
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe.skipIf(isWindows)("agy readiness — version is advisory", () => {
  let dir: string;
  const originalStrict = process.env.AGY_STRICT_VERSION;
  const originalAccepted = process.env.AGY_ACCEPTED_VERSION;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agy-ready-"));
    delete process.env.AGY_STRICT_VERSION;
    delete process.env.AGY_ACCEPTED_VERSION;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalStrict === undefined) delete process.env.AGY_STRICT_VERSION;
    else process.env.AGY_STRICT_VERSION = originalStrict;
    if (originalAccepted === undefined) delete process.env.AGY_ACCEPTED_VERSION;
    else process.env.AGY_ACCEPTED_VERSION = originalAccepted;
  });

  it("a newer version warns but does not block", () => {
    const bin = writeStub(dir, { version: "1.5.14", acp: true });
    const r = checkAgyReadiness(bin);
    expect(r.state).toBe("newer");
    expect(r.ok).toBe(true);
    expect(r.message).toContain("不阻断");
  });

  it("an older version warns but does not block", () => {
    const bin = writeStub(dir, { version: "1.5.12", acp: true });
    const r = checkAgyReadiness(bin);
    expect(r.state).toBe("older");
    expect(r.ok).toBe(true);
  });

  it("AGY_STRICT_VERSION=1 still blocks a newer version", () => {
    const bin = writeStub(dir, { version: "1.5.14", acp: true });
    process.env.AGY_STRICT_VERSION = "1";
    const r = checkAgyReadiness(bin);
    expect(r.state).toBe("newer");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("AGY_STRICT_VERSION=1");
  });

  it("AGY_ACCEPTED_VERSION moves the baseline instead of accepting anything", () => {
    const bin = writeStub(dir, { version: "1.5.14", acp: true });
    process.env.AGY_ACCEPTED_VERSION = "1.5.14";
    const r = checkAgyReadiness(bin);
    expect(r.state).toBe("pinned");
    expect(r.ok).toBe(true);
  });

  it("still hard-fails when the build has no acp subcommand", () => {
    const bin = writeStub(dir, { version: "1.5.13", acp: false });
    const r = checkAgyReadiness(bin);
    expect(r.hasAcp).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("still hard-fails when the version cannot be read", () => {
    const bin = writeStub(dir, { version: null, acp: true });
    const r = checkAgyReadiness(bin);
    expect(r.state).toBe("unknown");
    expect(r.ok).toBe(false);
  });
});