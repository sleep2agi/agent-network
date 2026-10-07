import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexCopresenceEnvFileText, codexCopresenceStageEnv } from "./codex-copresence-env";

describe("Codex co-presence config environment", () => {
  test("carries config values while launcher identity wins", () => {
    expect(codexCopresenceStageEnv({
      DEEPSEEK_KEY: "fake-provider-value",
      CODEX_HOME: "/wrong",
      ANET_NODE_MARKER: "wrong",
    }, {
      CODEX_HOME: "/node/codex-home",
      ANET_NODE_MARKER: "marker",
    })).toEqual({
      DEEPSEEK_KEY: "fake-provider-value",
      CODEX_HOME: "/node/codex-home",
      ANET_NODE_MARKER: "marker",
    });
  });

  test("renders values without placing them in tmux arguments", () => {
    const text = codexCopresenceEnvFileText({ FAKE_KEY: "space ' quote" });
    expect(text).toBe(`export FAKE_KEY='space '"'"' quote'\n`);
  });

  test("rejects keys which could become shell syntax", () => {
    expect(() => codexCopresenceStageEnv({ "BAD;echo": "x" }, {})).toThrow("invalid config.env key");
  });

  test("rejects PATH and loader hooks, including Windows case variants", () => {
    for (const key of ["PATH", "path", "NODE_OPTIONS", "node_options", "LD_PRELOAD", "ld_preload", "BUN_OPTIONS", "bash_env"]) {
      expect(() => codexCopresenceStageEnv({ [key]: "unsafe" }, {})).toThrow("is reserved");
    }
  });

  test("Windows case variants cannot replace launcher-owned identity", () => {
    expect(codexCopresenceStageEnv({ codex_home: "wrong", anet_node_marker: "wrong" }, {
      CODEX_HOME: "right", ANET_NODE_MARKER: "marker",
    })).toEqual({ CODEX_HOME: "right", ANET_NODE_MARKER: "marker" });
  });

  test("all three private env files are removed without consulting config PATH", () => {
    const cli = readFileSync(join(import.meta.dir, "../bin/cli.ts"), "utf8");
    expect(cli.match(/`\/bin\/rm -f \$\{shellQuote\([^)]*[Ee]nvFilePath\)\}`/g)).toHaveLength(3);
    expect(cli).not.toMatch(/`rm -f \$\{shellQuote\([^)]*[Ee]nvFilePath\)\}`/);
  });

  test("the launcher rejects reserved config.env before either platform stops the old generation", () => {
    const cli = readFileSync(join(import.meta.dir, "../bin/cli.ts"), "utf8");
    const validation = cli.indexOf("codexCopresenceStageEnv(opts.configEnv, {});");
    const windows = cli.indexOf('if (process.platform === "win32")', validation);
    const posixReap = cli.indexOf("const identityPrep = await prepareIdentityForStart(", validation);
    expect(validation).toBeGreaterThan(0);
    expect(validation).toBeLessThan(windows);
    expect(validation).toBeLessThan(posixReap);
  });
});
