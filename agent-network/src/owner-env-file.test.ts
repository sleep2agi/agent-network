import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadOwnerOnlyEnvFile } from "./owner-env-file";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadOwnerOnlyEnvFile", () => {
  test("loads the isolated commhub credential without overriding explicit identity", () => {
    const root = mkdtempSync(join(tmpdir(), "commhub-owner-env-"));
    roots.push(root);
    const file = join(root, ".env");
    writeFileSync(file, "COMMHUB_URL=http://hub.test\nCOMMHUB_TOKEN=ntok_file\nCOMMHUB_ALIAS=stale\n", { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { COMMHUB_ALIAS: "指挥狗" };
    loadOwnerOnlyEnvFile(file, env);
    expect(env.COMMHUB_URL).toBe("http://hub.test");
    expect(env.COMMHUB_TOKEN).toBe("ntok_file");
    expect(env.COMMHUB_ALIAS).toBe("指挥狗");
  });

  test("rejects relative, broad-mode, and symlinked credential files", () => {
    const root = mkdtempSync(join(tmpdir(), "commhub-owner-env-bad-"));
    roots.push(root);
    const file = join(root, ".env");
    writeFileSync(file, "COMMHUB_TOKEN=ntok_file\n", { mode: 0o600 });
    expect(() => loadOwnerOnlyEnvFile("relative/.env", {})).toThrow("absolute path");
    chmodSync(file, 0o644);
    expect(() => loadOwnerOnlyEnvFile(file, {})).toThrow("owner-only");
    chmodSync(file, 0o600);
    const link = join(root, "linked.env");
    symlinkSync(file, link);
    expect(() => loadOwnerOnlyEnvFile(link, {})).toThrow("owner-only");
  });
});
