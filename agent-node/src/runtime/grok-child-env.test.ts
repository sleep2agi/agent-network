import { describe, expect, it } from "bun:test";
import {
  buildGrokChildEnv,
  buildGrokHelperEnv,
  buildGrokPtyEnv,
  GROK_CHILD_INHERITED_ENV_KEYS,
  GROK_HELPER_INHERITED_ENV_KEYS,
  GROK_PTY_CONTROLLED_ENV_KEYS,
  projectGrokChildEnv,
} from "./grok-child-env";

describe("Grok child environment boundary", () => {
  it("builds the exact reviewed key set and drops every unreviewed credential", () => {
    const parentEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: "/tmp/grok-test",
      LANG: "C.UTF-8",
      TERM: "xterm-256color",
      DATABASE_URL: "postgres://private",
      AWS_ACCESS_KEY_ID: "AKIA_PRIVATE",
      AWS_SECRET_ACCESS_KEY: "aws-private",
      GOOGLE_API_TOKEN: "google-private",
      VENDOR_SECRET: "vendor-private",
      APP_SIGNING_KEY: "key-private",
      NODE_TOKEN_ALIAS: "ntok_private",
      USER_TOKEN_ALIAS: "utok_private",
      LEGACY_TOKEN_ALIAS: "atok_private",
      COMMHUB_TOKEN: "ntok_private",
      COMMHUB_AUTH_TOKEN: "utok_private",
      CURRENT_TASK_ID: "task-private",
      GROK_AGENT: "/tmp/unreviewed-agent.md",
      GROK_SANDBOX: "off",
      GROK_DISABLE_AUTOUPDATER: "0",
      GROK_SUBAGENTS: "1",
      GROK_WEB_FETCH: "1",
      GROK_MEMORY: "1",
    };

    const actual = buildGrokChildEnv({
      parentEnv,
      cwd: "/workspace/project",
      home: "/runtime/grok-home",
      authPath: "/runtime/grok-home/auth.json",
      oidcIssuer: "https://accounts.example.invalid",
      oidcClientId: "reviewed-public-client-id",
      expectedParentPid: 4321,
      defaultSelectedPermission: "allow_once",
    });

    expect(actual).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: "/tmp/grok-test",
      LANG: "C.UTF-8",
      TERM: "xterm-256color",
      HOME: "/runtime/grok-home",
      PWD: "/workspace/project",
      GROK_HOME: "/runtime/grok-home",
      GROK_AUTH_PATH: "/runtime/grok-home/auth.json",
      GROK_CLAUDE_MCPS_ENABLED: "false",
      GROK_CURSOR_MCPS_ENABLED: "false",
      GROK_CLAUDE_HOOKS_ENABLED: "false",
      GROK_CURSOR_HOOKS_ENABLED: "false",
      GROK_FOLDER_TRUST: "1",
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_SUBAGENTS: "0",
      GROK_WEB_FETCH: "0",
      GROK_MEMORY: "0",
      GROK_OIDC_ISSUER: "https://accounts.example.invalid",
      GROK_OIDC_CLIENT_ID: "reviewed-public-client-id",
      ANET_EXPECTED_PARENT_PID: "4321",
      GROK_DEFAULT_SELECTED_PERMISSION: "allow_once",
    });
    expect(Object.keys(actual).sort()).toEqual([
      "ANET_EXPECTED_PARENT_PID",
      "GROK_AUTH_PATH",
      "GROK_CLAUDE_HOOKS_ENABLED",
      "GROK_CLAUDE_MCPS_ENABLED",
      "GROK_CURSOR_HOOKS_ENABLED",
      "GROK_CURSOR_MCPS_ENABLED",
      "GROK_DEFAULT_SELECTED_PERMISSION",
      "GROK_DISABLE_AUTOUPDATER",
      "GROK_FOLDER_TRUST",
      "GROK_HOME",
      "GROK_MEMORY",
      "GROK_OIDC_CLIENT_ID",
      "GROK_OIDC_ISSUER",
      "GROK_SUBAGENTS",
      "GROK_WEB_FETCH",
      "HOME",
      "LANG",
      "PATH",
      "PWD",
      "TERM",
      "TMPDIR",
    ]);
    expect(actual.GROK_AGENT).toBeUndefined();
    expect(actual.GROK_SANDBOX).toBeUndefined();
  });

  it("re-projects a beforeSpawn result instead of trusting arbitrary keys", () => {
    const actual = projectGrokChildEnv({
      PATH: "/bin",
      HOME: "/runtime/home",
      GROK_HOME: "/runtime/home",
      GROK_AUTH_PATH: "/runtime/home/auth.json",
      DATABASE_URL: "postgres://private",
      AWS_SESSION_TOKEN: "aws-private",
      ARBITRARY_TOKEN: "token-private",
      ARBITRARY_SECRET: "secret-private",
      ARBITRARY_KEY: "key-private",
      NODE_TOKEN_ALIAS: "ntok_private",
      USER_TOKEN_ALIAS: "utok_private",
    });

    expect(actual).toEqual({
      PATH: "/bin",
      HOME: "/runtime/home",
      GROK_HOME: "/runtime/home",
      GROK_AUTH_PATH: "/runtime/home/auth.json",
    });
  });

  it("rejects a beforeSpawn callback that changes a controlled value", () => {
    const baseline = buildGrokChildEnv({
      parentEnv: { PATH: "/bin" },
      cwd: "/workspace/project",
      home: "/runtime/home",
      authPath: "/runtime/home/auth.json",
      defaultSelectedPermission: "allow_once",
    });
    expect(() => projectGrokChildEnv({
      ...baseline,
      GROK_AUTH_PATH: "/tmp/unreviewed-auth.json",
    }, baseline)).toThrow("GROK_AUTH_PATH");
    expect(() => projectGrokChildEnv({
      ...baseline,
      GROK_CLAUDE_HOOKS_ENABLED: "true",
    }, baseline)).toThrow("GROK_CLAUDE_HOOKS_ENABLED");
    expect(() => projectGrokChildEnv({
      ...baseline,
      GROK_DEFAULT_SELECTED_PERMISSION: "always_allow_all_sessions",
    }, baseline)).toThrow("GROK_DEFAULT_SELECTED_PERMISSION");
    expect(() => projectGrokChildEnv({
      ...baseline,
      GROK_SUBAGENTS: "1",
    }, baseline)).toThrow("GROK_SUBAGENTS");
    expect(projectGrokChildEnv({
      ...baseline,
      GROK_AGENT: "/tmp/unreviewed-agent.md",
      GROK_SANDBOX: "off",
    }, baseline)).toEqual(baseline);
    expect(() => projectGrokChildEnv({
      ...baseline,
      PATH: "/tmp/unreviewed-bin:/bin",
    }, baseline)).toThrow("PATH");
    expect(() => projectGrokChildEnv({
      ...baseline,
      TERM: "token-shaped-terminal-value",
    }, baseline)).toThrow("TERM");
  });

  it("keeps the inherited list exact and reviewable", () => {
    expect(GROK_CHILD_INHERITED_ENV_KEYS).toEqual([
      "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
      "TZ", "SHELL", "USER", "LOGNAME", "TERM", "COLORTERM", "NO_COLOR",
    ]);
  });

  it("keeps PTY PWD equal and adds only reviewed terminal/sandbox controls", () => {
    const baseline = buildGrokChildEnv({
      parentEnv: { PATH: "/bin", TERM: "ambient-term", DATABASE_URL: "private" },
      cwd: "/workspace/project",
      home: "/runtime/home",
      authPath: "/runtime/home/auth.json",
    });
    expect(buildGrokPtyEnv(
      { ...baseline, GROK_SANDBOX: "off" },
      baseline,
      "/workspace/project",
      "xterm-256color",
      "anet-workspace",
    )).toEqual({
      PATH: "/bin",
      HOME: "/runtime/home",
      GROK_HOME: "/runtime/home",
      GROK_AUTH_PATH: "/runtime/home/auth.json",
      GROK_CLAUDE_MCPS_ENABLED: "false",
      GROK_CURSOR_MCPS_ENABLED: "false",
      GROK_CLAUDE_HOOKS_ENABLED: "false",
      GROK_CURSOR_HOOKS_ENABLED: "false",
      GROK_FOLDER_TRUST: "1",
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_SUBAGENTS: "0",
      GROK_WEB_FETCH: "0",
      GROK_MEMORY: "0",
      PWD: "/workspace/project",
      TERM: "xterm-256color",
      GROK_SANDBOX: "anet-workspace",
    });
    expect(GROK_PTY_CONTROLLED_ENV_KEYS).toEqual(["TERM", "GROK_SANDBOX"]);
    expect(() => buildGrokPtyEnv(
      baseline,
      baseline,
      "/workspace/project",
      "xterm-256color",
      "off\nDATABASE_URL=private",
    )).toThrow("valid cwd, terminal name, and sandbox profile");
  });

  it("builds the narrower helper environment from an empty object", () => {
    expect(buildGrokHelperEnv({
      PATH: "/reviewed/bin",
      TMPDIR: "/reviewed/tmp",
      LANG: "C.UTF-8",
      TERM: "xterm-256color",
      HOME: "/private/home",
      GROK_AUTH_PATH: "/private/auth.json",
      DATABASE_URL: "postgres://private",
      AWS_SESSION_TOKEN: "aws-private",
      ARBITRARY_TOKEN: "token-private",
      ARBITRARY_SECRET: "secret-private",
      ARBITRARY_KEY: "key-private",
      NTOK: "ntok_private",
      UTOK: "utok_private",
    })).toEqual({
      PATH: "/reviewed/bin",
      TMPDIR: "/reviewed/tmp",
      LANG: "C.UTF-8",
    });
    expect(GROK_HELPER_INHERITED_ENV_KEYS).toEqual([
      "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    ]);
  });
});
