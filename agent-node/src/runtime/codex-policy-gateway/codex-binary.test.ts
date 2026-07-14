import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  CODEX_BINARY_IDENTITY_MISMATCH,
  CODEX_BINARY_RESOLUTION_FAILED,
  assertCodexBinaryIdentity,
  resolveCodexBinaryIdentity,
} from "./codex-binary";

describe("canonical Codex binary identity", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test("bare name uses the supplied PATH once and returns realpath + bigint identity strings", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-binary-test-"));
    dirs.push(root);
    const skipped = join(root, "skipped");
    const selected = join(root, "selected");
    mkdirSync(skipped, { recursive: true });
    mkdirSync(selected, { recursive: true });
    writeFileSync(join(skipped, "codex"), "not executable\n", { mode: 0o600 });
    const target = join(selected, "codex-real");
    writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync("codex-real", join(selected, "codex"));

    const identity = resolveCodexBinaryIdentity("codex", {
      env: { PATH: [skipped, selected].join(delimiter) },
    });
    expect(identity.path).toBe(realpathSync(target));
    expect(identity.dev).toMatch(/^\d+$/);
    expect(identity.ino).toMatch(/^\d+$/);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(assertCodexBinaryIdentity(identity)).toEqual(identity);
  });

  test("replacement is detected without exposing path or filesystem text", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-binary-replace-RAW_PATH-"));
    dirs.push(root);
    const binary = join(root, "codex-secret-name");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(binary, 0o755);
    const identity = resolveCodexBinaryIdentity(binary);

    // Keep the original inode allocated so the replacement cannot receive it.
    renameSync(binary, join(root, "original-kept-alive"));
    writeFileSync(binary, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    chmodSync(binary, 0o755);

    let observed: Error | null = null;
    try {
      assertCodexBinaryIdentity(identity);
    } catch (error) {
      observed = error as Error;
    }
    expect((observed as (Error & { code?: string }) | null)?.code).toBe(
      CODEX_BINARY_IDENTITY_MISMATCH,
    );
    expect(observed?.message).toBe(CODEX_BINARY_IDENTITY_MISMATCH);
    expect(observed?.message).not.toContain(root);
    expect(observed?.message).not.toContain("RAW_PATH");
  });

  test("missing bare name fails with a stable non-disclosing error", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-binary-missing-RAW_PATH-"));
    dirs.push(root);
    let observed: Error | null = null;
    try {
      resolveCodexBinaryIdentity("secret-codex-name", { env: { PATH: root } });
    } catch (error) {
      observed = error as Error;
    }
    expect((observed as (Error & { code?: string }) | null)?.code).toBe(
      CODEX_BINARY_RESOLUTION_FAILED,
    );
    expect(observed?.message).toBe(CODEX_BINARY_RESOLUTION_FAILED);
    expect(observed?.message).not.toContain(root);
    expect(observed?.message).not.toContain("secret-codex-name");
  });
});
