// #186 — unit tests for the lazy-install codex SDK loader. Covers the
// three paths: dep already present, dep missing → install succeeds, and
// dep missing → install fails (operator gets a friendly multi-line
// recovery hint).
import { describe, expect, test } from "bun:test";
import { loadCodexSdk, type CodexLoaderHooks } from "./codex-dep-loader";

const FAKE_SDK = { Codex: class CodexStub {} };

function hooks(overrides: Partial<CodexLoaderHooks>): CodexLoaderHooks {
  return {
    importCodexSdk: async () => FAKE_SDK,
    npmInstall: async () => {
      throw new Error("npmInstall called unexpectedly in this test");
    },
    ...overrides,
  };
}

describe("loadCodexSdk", () => {
  test("returns the imported module without installing when already present", async () => {
    let installAttempts = 0;
    const result = await loadCodexSdk(
      hooks({
        npmInstall: async () => {
          installAttempts++;
        },
      }),
      "/opt/agent-node",
    );
    expect(result.source).toBe("already-installed");
    expect(result.module).toBe(FAKE_SDK);
    expect(installAttempts).toBe(0);
  });

  test("auto-installs and retries when the first import fails", async () => {
    let imports = 0;
    let installed = false;
    const result = await loadCodexSdk(
      hooks({
        importCodexSdk: async () => {
          imports++;
          if (imports === 1) throw new Error("Cannot find module '@openai/codex-sdk'");
          return FAKE_SDK;
        },
        npmInstall: async (prefix, packages) => {
          installed = true;
          expect(prefix).toBe("/opt/agent-node");
          expect(packages.some((p) => p.startsWith("@openai/codex-sdk@"))).toBe(true);
          expect(packages.some((p) => p.startsWith("@openai/codex@"))).toBe(true);
        },
      }),
      "/opt/agent-node",
    );
    expect(installed).toBe(true);
    expect(result.source).toBe("auto-installed");
    expect(result.module).toBe(FAKE_SDK);
    expect(imports).toBe(2);
  });

  test("throws a friendly multi-line error when install fails — includes pasteable npm command + module path + both root causes", async () => {
    let caught: Error | undefined;
    try {
      await loadCodexSdk(
        hooks({
          importCodexSdk: async () => {
            throw new Error("Cannot find module '@openai/codex-sdk'");
          },
          npmInstall: async () => {
            throw new Error("ENETUNREACH: registry unreachable");
          },
        }),
        "/opt/anet/agent-node",
      );
    } catch (e: any) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.name).toBe("CodexSdkUnavailable");
    expect(caught?.message).toContain("@openai/codex-sdk");
    expect(caught?.message).toContain("@openai/codex");
    expect(caught?.message).toContain("/opt/anet/agent-node");
    // Pasteable command — `npm install --prefix ...` is what the docs
    // say to run, the error should produce it verbatim.
    expect(caught?.message).toMatch(/npm install --prefix/);
    // Both upstream reasons surfaced so the operator can distinguish
    // 'package was never installed' from 'install attempt failed'.
    expect(caught?.message).toContain("initial import");
    expect(caught?.message).toContain("auto-install");
    expect(caught?.message).toContain("ENETUNREACH");
  });

  test("install succeeds but post-install import still fails → terminal error names the install-then-resolve mismatch", async () => {
    let installed = false;
    let caught: Error | undefined;
    try {
      await loadCodexSdk(
        hooks({
          importCodexSdk: async () => {
            throw new Error("MODULE_NOT_FOUND");
          },
          npmInstall: async () => {
            installed = true;
          },
        }),
        "/srv/agent-node",
      );
    } catch (e: any) {
      caught = e;
    }
    expect(installed).toBe(true);
    expect(caught?.name).toBe("CodexSdkUnavailable");
    expect(caught?.message).toMatch(/install succeeded but @openai\/codex-sdk still does not resolve/);
  });

  test("module dir with shell metacharacters is single-quoted in the recovery hint", async () => {
    let caught: Error | undefined;
    try {
      await loadCodexSdk(
        hooks({
          importCodexSdk: async () => {
            throw new Error("missing");
          },
          npmInstall: async () => {
            throw new Error("registry blocked");
          },
        }),
        "/Users/foo bar/agent node",
      );
    } catch (e: any) {
      caught = e;
    }
    expect(caught?.message).toContain("'/Users/foo bar/agent node'");
  });
});
