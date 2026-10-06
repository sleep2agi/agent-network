import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  formatScrubbedEnvLine,
  isInheritedSessionIdentityEnvName,
  scrubInheritedSessionIdentityEnv,
} from "./daemon-inherited-env";

// Values are fake placeholders; the point is the NAMES.
const POLLUTED: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/user",
  LANG: "C.UTF-8",
  HTTPS_PROXY: "http://proxy.invalid:3128",
  NO_PROXY: "localhost",
  OPENAI_API_KEY: "fake-provider-key",
  COMMHUB_AUTH_TOKEN: "fake-hub-config",
  ANET_BIN_ABS: "/opt/anet/bin/anet",
  ANET_DAEMON_ALLOW_ENV_BIN: "1",
  CLAUDECODE: "1",
  CLAUDE_PID: "123",
  CLAUDE_EFFORT: "high",
  CLAUDE_PLUGIN_DATA: "/x",
  CLAUDE_CODE_SESSION_ID: "fake-session",
  CLAUDE_CODE_MESSAGING_TOKEN: "fake-token",
  CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth",
  COMMHUB_ALIAS: "some-other-node",
  COMMHUB_TOKEN: "ntok_fake",
  COMMHUB_NODE_ID: "node_fake",
  COMMHUB_RESUME_ID: "fake-resume",
  COMMHUB_URL: "http://127.0.0.1:1",
  ANET_NODE_MARKER: "fake-marker",
  ANET_CODEX_COMMHUB_TOKEN: "ntok_fake2",
  ANET_INTERNAL_GROK_COPRESENCE_PROFILE: "/x",
  ANET_CONFIG_UPDATE_CAPABLE: "1",
  CODEX_HOME: "/x/codex-home",
  CODEX_COMPANION_SESSION_ID: "fake",
  GROK_HOME: "/x/grok",
  TMUX: "/tmp/tmux-1000/default,1,0",
  TMUX_PANE: "%1",
};

const MUST_DROP = [
  "ANET_CODEX_COMMHUB_TOKEN", "ANET_CONFIG_UPDATE_CAPABLE", "ANET_INTERNAL_GROK_COPRESENCE_PROFILE",
  "ANET_NODE_MARKER", "CLAUDECODE", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_EFFORT", "CLAUDE_PID", "CLAUDE_PLUGIN_DATA",
  "CODEX_COMPANION_SESSION_ID", "CODEX_HOME", "COMMHUB_ALIAS", "COMMHUB_NODE_ID",
  "COMMHUB_RESUME_ID", "COMMHUB_TOKEN", "COMMHUB_URL", "GROK_HOME", "TMUX", "TMUX_PANE",
].sort();
const MUST_KEEP = [
  "PATH", "HOME", "LANG", "HTTPS_PROXY", "NO_PROXY", "OPENAI_API_KEY",
  "COMMHUB_AUTH_TOKEN", "ANET_BIN_ABS", "ANET_DAEMON_ALLOW_ENV_BIN",
];

describe("#620 scrubInheritedSessionIdentityEnv", () => {
  test("drops every session-identity name and reports exactly those names, sorted", () => {
    const { env, removed } = scrubInheritedSessionIdentityEnv(POLLUTED);
    expect(removed).toEqual(MUST_DROP);
    for (const k of MUST_DROP) expect(k in env).toBe(false);
  });

  test("keeps what the daemon legitimately needs (PATH/HOME/LANG/proxy/provider keys/daemon pin)", () => {
    const { env } = scrubInheritedSessionIdentityEnv(POLLUTED);
    for (const k of MUST_KEEP) expect(env[k]).toBe(POLLUTED[k]);
  });

  test("does not mutate the input", () => {
    const input = { ...POLLUTED };
    scrubInheritedSessionIdentityEnv(input);
    expect(input).toEqual(POLLUTED);
  });

  test("COMMHUB_* is an explicit list, not a prefix (hub config names survive)", () => {
    expect(isInheritedSessionIdentityEnvName("COMMHUB_AUTH_TOKEN")).toBe(false);
    expect(isInheritedSessionIdentityEnvName("COMMHUB_DB")).toBe(false);
    expect(isInheritedSessionIdentityEnvName("COMMHUB_TOKEN")).toBe(true);
  });

  test("log line carries names only, never values", () => {
    const { removed } = scrubInheritedSessionIdentityEnv(POLLUTED);
    const line = formatScrubbedEnvLine(removed);
    for (const k of MUST_DROP) expect(line).toContain(k);
    for (const k of MUST_DROP) {
      const v = String(POLLUTED[k]);
      if (v.length > 2) expect(line).not.toContain(v);
    }
    expect(formatScrubbedEnvLine([])).toContain("(none)");
  });

  test("stays in lockstep with hub-daemon.sh _scrub_node_identity_env (#558)", () => {
    const sh = readFileSync(new URL("../../deploy/hub/hub-daemon.sh", import.meta.url), "utf8");
    const start = sh.indexOf("_scrub_node_identity_env() {");
    const end = sh.indexOf("esac", start);
    expect(start).toBeGreaterThan(0);
    const patterns = sh.slice(start, end).match(/[A-Z][A-Z0-9_]*\*?(?=[|)\\\s])/g) ?? [];
    const names = patterns.filter((p) => /^[A-Z]/.test(p) && p !== "_scrub_node_identity_env");
    expect(names.length).toBeGreaterThan(10);
    for (const p of names) {
      const probe = p.endsWith("*") ? `${p.slice(0, -1)}X` : p;
      expect({ p, scrubbed: isInheritedSessionIdentityEnvName(probe) }).toEqual({ p, scrubbed: true });
    }
  });
});

describe("#620 wiring — anet node start scrubs before building a host_supervisor's env", () => {
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
  test("the agent-node env is spread from the scrubbed copy, gated on role=host_supervisor", () => {
    const gate = cli.indexOf('if (profile.role === "host_supervisor") {\n      const scrubbed = scrubInheritedSessionIdentityEnv(process.env);');
    const spread = cli.indexOf("const env: NodeJS.ProcessEnv = {\n      ...inheritedEnv,", gate);
    expect(gate).toBeGreaterThan(0);
    expect(spread).toBeGreaterThan(gate);
    expect(cli.slice(gate, spread)).toContain("console.log(formatScrubbedEnvLine(scrubbed.removed));");
  });
});
