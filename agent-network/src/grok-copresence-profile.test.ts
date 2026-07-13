import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  agentNodeHelpSupportsGrokCopresence,
  buildGrokAgentNodeEnv,
  buildGrokPreviewResolverEnv,
  GROK_COPRESENCE_CAPABILITY_MARKER,
  GROK_AGENT_NODE_INHERITED_ENV_KEYS,
  GROK_AGENT_NODE_OPTIONAL_ENV_KEYS,
  GROK_PREVIEW_RESOLVER_INHERITED_ENV_KEYS,
  GROK_UNIX_SOCKET_PATH_MAX_BYTES,
  grokBuildCliCreationFields,
  grokCopresenceSocketPaths,
  grokPreviewResolverConfigPaths,
  prepareGrokPreviewResolverConfigs,
} from "./grok-copresence-profile";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Grok copresence profile defaults", () => {
  test("builds the Grok agent-node parent environment from an exact empty allowlist", () => {
    expect(buildGrokAgentNodeEnv({
      PATH: "/reviewed/bin",
      HOME: "/home/preview",
      LANG: "C.UTF-8",
      GROK_BINARY: "/reviewed/grok",
      GROK_CLI_TIMEOUT_MS: "300000",
      DATABASE_URL: "postgres://private",
      AWS_SECRET_ACCESS_KEY: "private",
      PARTNER_TOKEN: "private",
      PARTNER_SECRET: "private",
      PARTNER_KEY: "private",
      ntok: "ntok_private",
      utok: "utok_private",
      COMMHUB_TOKEN: "ntok_private",
      NODE_OPTIONS: "--require=/tmp/private.js",
    })).toEqual({
      PATH: "/reviewed/bin",
      HOME: "/home/preview",
      LANG: "C.UTF-8",
      GROK_BINARY: "/reviewed/grok",
      GROK_CLI_TIMEOUT_MS: "300000",
      ANET_CONFIG_UPDATE_CAPABLE: "1",
    });
    expect(GROK_AGENT_NODE_INHERITED_ENV_KEYS).toEqual([
      "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
      "SHELL", "USER", "LOGNAME", "TERM", "COLORTERM", "NO_COLOR",
    ]);
    expect(GROK_AGENT_NODE_OPTIONAL_ENV_KEYS).toEqual([
      "GROK_BINARY", "GROK_HOME", "FLOCK_BINARY", "SETPRIV_BINARY", "UNSHARE_BINARY",
      "GROK_CLI_TIMEOUT_MS", "GROK_HANDSHAKE_TIMEOUT_MS", "LOG_LEVEL",
      "ANET_GOAL_TICK_MS", "COMMHUB_MAX_GOALS_PER_NODE",
    ]);
  });

  test("does not mistake an old headless-only agent-node for co-presence support", () => {
    expect(agentNodeHelpSupportsGrokCopresence("grok-build-cli — Grok Build CLI headless")).toBe(false);
    expect(agentNodeHelpSupportsGrokCopresence(
      "grok-build-cli — ANET_CAPABILITY_GROK_COPRESENCE_V1 legacy preview",
    )).toBe(false);
    expect(agentNodeHelpSupportsGrokCopresence(
      `grok-build-cli — ${GROK_COPRESENCE_CAPABILITY_MARKER} 模式`,
    )).toBe(true);
  });

  test("builds the npm resolver environment from an exact empty allowlist", () => {
    const env = buildGrokPreviewResolverEnv({
      PATH: "/reviewed/bin",
      TMPDIR: "/reviewed/tmp",
      LANG: "C.UTF-8",
      npm_config_registry: "http://127.0.0.1:4873",
      DATABASE_URL: "postgres://private",
      AWS_SECRET_ACCESS_KEY: "private",
      PARTNER_TOKEN: "private",
      PARTNER_SECRET: "private",
      PARTNER_KEY: "private",
      ntok: "ntok_private",
      utok: "utok_private",
      NODE_OPTIONS: "--require=/tmp/unreviewed.js",
      npm_config_userconfig: "/tmp/private-npmrc",
    }, "/home/preview");
    expect(env).toEqual({
      PATH: "/reviewed/bin",
      TMPDIR: "/reviewed/tmp",
      LANG: "C.UTF-8",
      HOME: "/home/preview",
      npm_config_registry: "http://127.0.0.1:4873/",
      npm_config_cache: "/home/preview/.npm",
      npm_config_userconfig: "/home/preview/.anet/npm-resolver/user.npmrc",
      npm_config_globalconfig: "/home/preview/.anet/npm-resolver/global.npmrc",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    });
    expect(GROK_PREVIEW_RESOLVER_INHERITED_ENV_KEYS).toEqual([
      "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    ]);
    expect(() => buildGrokPreviewResolverEnv({
      npm_config_registry: "http://registry.example.invalid",
    }, "/home/preview")).toThrow("insecure npm registry");
    expect(() => buildGrokPreviewResolverEnv({
      npm_config_registry: "https://user:pass@registry.npmjs.org",
    }, "/home/preview")).toThrow("credential-bearing");
  });

  test("prepares two distinct empty owner-only npm config files without following symlinks", () => {
    const home = mkdtempSync(join(tmpdir(), "anet-grok-npm-"));
    cleanup.push(home);
    prepareGrokPreviewResolverConfigs(home);
    const paths = grokPreviewResolverConfigPaths(home);
    expect(paths.userConfig).not.toBe(paths.globalConfig);
    for (const path of [paths.userConfig, paths.globalConfig]) {
      expect(readFileSync(path, "utf8")).toBe("");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(statSync(paths.directory).mode & 0o777).toBe(0o700);

    writeFileSync(paths.userConfig, "//registry.invalid/:_authToken=private\n");
    prepareGrokPreviewResolverConfigs(home);
    expect(readFileSync(paths.userConfig, "utf8")).toBe("");

    rmSync(paths.userConfig);
    symlinkSync("/dev/null", paths.userConfig);
    expect(() => prepareGrokPreviewResolverConfigs(home)).toThrow();

    rmSync(paths.userConfig);
    linkSync(paths.globalConfig, paths.userConfig);
    expect(() => prepareGrokPreviewResolverConfigs(home)).toThrow();
  });

  test("enables copresence only for non-headless grok-build-cli", () => {
    const fields = grokBuildCliCreationFields("grok-build-cli", "n_preview", false, {
      cwd: "/workspace/project",
      uid: 1234,
      xdgRuntimeDir: "/does/not/exist",
    });
    expect(fields).toEqual({
      grokCopresence: true,
      grokLeaderSocket: expect.stringMatching(/^\/tmp\/anet-u1234\/g\/[a-f0-9]{16}\/l\.sock$/),
      grokAttachSocket: expect.stringMatching(/^\/tmp\/anet-u1234\/g\/[a-f0-9]{16}\/a\.sock$/),
    });
    expect(grokBuildCliCreationFields("grok-build-cli", "n_preview", true)).toEqual({
      grokCopresence: false,
    });
    expect(grokBuildCliCreationFields("grok-build-acp", "n_preview", false)).toEqual({});
  });

  test("uses an owner-only, non-symlink XDG runtime directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "anet-grok-xdg-"));
    cleanup.push(dir);
    chmodSync(dir, 0o700);
    const paths = grokCopresenceSocketPaths("n_preview", {
      cwd: "/workspace/project",
      uid: process.getuid?.(),
      xdgRuntimeDir: dir,
    });
    expect(paths.leaderSocket.startsWith(`${dir}/g/`)).toBe(true);
    expect(paths.attachSocket.startsWith(`${dir}/g/`)).toBe(true);
  });

  test("falls back to a bounded path when XDG is unsafe or too long", () => {
    const dir = mkdtempSync(join(tmpdir(), "anet-grok-world-"));
    cleanup.push(dir);
    chmodSync(dir, 0o755);
    const paths = grokCopresenceSocketPaths("n_preview", {
      cwd: "/".repeat(300),
      uid: 5678,
      xdgRuntimeDir: dir,
    });
    expect(paths.leaderSocket.startsWith("/tmp/anet-u5678/g/")).toBe(true);
    expect(Buffer.byteLength(paths.leaderSocket)).toBeLessThanOrEqual(GROK_UNIX_SOCKET_PATH_MAX_BYTES);
    expect(Buffer.byteLength(paths.attachSocket)).toBeLessThanOrEqual(GROK_UNIX_SOCKET_PATH_MAX_BYTES);
  });
});
