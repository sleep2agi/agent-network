import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildOpencodeSmokeEnv } from "./opencode-smoke-env";
import {
  createOpencodeSafeExternalRoot,
  OPENCODE_SAFE_ANCESTOR_CANDIDATES,
} from "./opencode-safe-root";

describe("buildOpencodeSmokeEnv", () => {
  test("locks the exact hardened ancestor candidate set", () => {
    expect([...OPENCODE_SAFE_ANCESTOR_CANDIDATES]).toEqual([
      "opencode.jsonc", "opencode.json", ".opencode",
      "AGENTS.md", "CLAUDE.md", "CONTEXT.md",
      ".claude", ".agents", ".git",
    ]);
  });

  test("rejects sticky world-writable /tmp instead of silently degrading", () => {
    expect(() => createOpencodeSafeExternalRoot({
      prefix: ".anet-opencode-negative-",
      base: "/tmp",
    })).toThrow(/untrusted runtime-base ancestor|group\/other writable/);
  });
  test("inherits only transport/locale trust settings and controls all OpenCode roots", () => {
    const root = `/run/user/${process.getuid?.() ?? 0}/anet-opencode-smoke-test`;
    const cwd = join(root, "workspace");
    const env = buildOpencodeSmokeEnv({
      PATH: "/usr/local/bin:/usr/bin",
      LANG: "C.UTF-8",
      HTTPS_PROXY: "http://proxy.invalid:8080",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
      COMMHUB_TOKEN: "must-not-leak",
      GH_TOKEN: "must-not-leak",
      ANTHROPIC_API_KEY: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      NODE_OPTIONS: "--require=/tmp/hostile.js",
      XDG_CONFIG_HOME: "/tmp/hostile-xdg",
      OPENCODE_CONFIG: "/tmp/hostile-opencode.json",
      OPENCODE_CONFIG_DIR: "/tmp/hostile-opencode-dir",
      OPENCODE_CONFIG_CONTENT: "{\"plugin\":[\"hostile\"]}",
    }, root, cwd);

    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.HTTPS_PROXY).toBe("http://proxy.invalid:8080");
    expect(env.SSL_CERT_FILE).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(env.HOME).toBe(root);
    expect(env.PWD).toBe(cwd);
    expect(env.XDG_CONFIG_HOME).toBe(join(root, ".config"));
    expect(env.XDG_DATA_HOME).toBe(join(root, ".local", "share"));
    expect(env.XDG_CACHE_HOME).toBe(join(root, ".cache"));
    expect(env.XDG_STATE_HOME).toBe(join(root, ".local", "state"));
    expect(env.XDG_RUNTIME_DIR).toBe(join(root, ".runtime"));
    expect(env.TMPDIR).toBe(join(root, "tmp"));
    expect(env.TMP).toBe(env.TMPDIR);
    expect(env.TEMP).toBe(env.TMPDIR);

    for (const forbidden of [
      "COMMHUB_TOKEN",
      "GH_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "NODE_OPTIONS",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
    ]) {
      expect(env[forbidden]).toBeUndefined();
    }

    const inlineConfig = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(inlineConfig.tools).toEqual({
      bash: false,
      read: false,
      glob: false,
      grep: false,
      edit: false,
      write: false,
      list: false,
      task: false,
      skill: false,
      question: false,
    });
    expect(inlineConfig.plugin).toEqual([]);
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("true");
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
    expect(env.OPENCODE_PURE).toBe("1");
    expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1");
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect(env.OPENCODE_DISABLE_LSP_DOWNLOAD).toBe("1");
  });

  test("every writable root can be precreated private, including XDG_RUNTIME_DIR", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-smoke-roots-"));
    try {
      for (const relative of [
        "workspace",
        ".config",
        join(".local", "share"),
        ".cache",
        join(".local", "state"),
        ".runtime",
        "tmp",
      ]) {
        mkdirSync(join(root, relative), { recursive: true, mode: 0o700 });
      }
      const cwd = join(root, "workspace");
      const env = buildOpencodeSmokeEnv({}, root, cwd);
      expect(env.PWD).toBe(cwd);
      for (const path of [
        env.HOME,
        env.PWD,
        env.XDG_CONFIG_HOME,
        env.XDG_DATA_HOME,
        env.XDG_CACHE_HOME,
        env.XDG_STATE_HOME,
        env.XDG_RUNTIME_DIR,
        env.TMPDIR,
      ]) {
        expect(statSync(path!).mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
