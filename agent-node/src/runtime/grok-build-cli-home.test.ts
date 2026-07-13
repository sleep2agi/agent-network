import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  acquireGrokProjectTurnLock,
  assertNoDiscoveredGrokHooks,
  grokCliStateKey,
  prepareGrokCliHome,
} from "./grok-build-cli-home";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prepareGrokCliHome", () => {
  it("derives an opaque path segment and rejects dot identities", () => {
    expect(grokCliStateKey("n_grokcli215")).toMatch(/^node-[a-f0-9]{24}$/);
    expect(grokCliStateKey("node/../../escape")).toMatch(/^node-[a-f0-9]{24}$/);
    expect(() => grokCliStateKey(".")).toThrow("cannot be empty");
    expect(() => grokCliStateKey("..")).toThrow("cannot be empty");
  });

  it("isolates config/trust, preserves a shared auth path, and creates stable sandbox profiles", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-home-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateHome = join(root, "state");
    const secretDir = join(root, "project", ".anet");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(sourceHome, "auth.json"), JSON.stringify({
      "https://auth.example.test::client-123": { key: "secret-auth" },
    }), { mode: 0o600 });

    const first = prepareGrokCliHome({ sourceHome, stateRoot: dirname(stateHome), stateHome, denyPaths: [secretDir] });
    const second = prepareGrokCliHome({ sourceHome, stateRoot: dirname(stateHome), stateHome, denyPaths: [secretDir] });

    expect(first).toEqual(second);
    expect(first.readOnlyProfile).toMatch(/^anet-[a-f0-9]{24}-read-only$/);
    expect(first.authPath).toBe(join(sourceHome, "auth.json"));
    expect(first.oidcIssuer).toBe("https://auth.example.test");
    expect(first.oidcClientId).toBe("client-123");
    expect(statSync(stateHome).mode & 0o777).toBe(0o700);
    const config = readFileSync(join(stateHome, "config.toml"), "utf8");
    expect(config).toContain("[cli]\nuse_leader = false");
    expect(config).not.toContain("default_selected_permission");
    expect(config).toContain("[toolset.bash]\nauto_background_on_timeout = false");
    expect(existsSync(join(stateHome, "requirements.toml"))).toBe(false);
    const sandbox = readFileSync(join(stateHome, "sandbox.toml"), "utf8");
    expect(sandbox).toContain(secretDir);
    expect(sandbox).toContain('extends = "read-only"');
    expect(sandbox).toContain('extends = "workspace"');
  });

  it("refuses broad-mode or symlinked source auth without repairing it", () => {
    const broadRoot = mkdtempSync(join(tmpdir(), "grok-cli-auth-mode-"));
    roots.push(broadRoot);
    const broadSource = join(broadRoot, "source");
    const broadState = join(broadRoot, "state");
    const broadSecret = join(broadRoot, "project", ".anet");
    mkdirSync(broadSource, { recursive: true });
    mkdirSync(broadSecret, { recursive: true });
    const broadAuth = join(broadSource, "auth.json");
    writeFileSync(broadAuth, "{}", { mode: 0o644 });
    expect(() => prepareGrokCliHome({
      sourceHome: broadSource,
      stateRoot: dirname(broadState),
      stateHome: broadState,
      denyPaths: [broadSecret],
    })).toThrow("source auth.json must have mode 0600");
    expect(statSync(broadAuth).mode & 0o777).toBe(0o644);

    const linkRoot = mkdtempSync(join(tmpdir(), "grok-cli-auth-link-"));
    roots.push(linkRoot);
    const linkSource = join(linkRoot, "source");
    const linkState = join(linkRoot, "state");
    const linkSecret = join(linkRoot, "project", ".anet");
    const externalAuth = join(linkRoot, "external-auth.json");
    mkdirSync(linkSource, { recursive: true });
    mkdirSync(linkSecret, { recursive: true });
    writeFileSync(externalAuth, "{}", { mode: 0o600 });
    symlinkSync(externalAuth, join(linkSource, "auth.json"));
    expect(() => prepareGrokCliHome({
      sourceHome: linkSource,
      stateRoot: dirname(linkState),
      stateHome: linkState,
      denyPaths: [linkSecret],
    })).toThrow("source auth.json must be a single-link regular file");
    expect(statSync(externalAuth).mode & 0o777).toBe(0o600);
    expect(readFileSync(externalAuth, "utf8")).toBe("{}");
  });

  it("repairs an existing Grok session store to owner-only modes", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-session-modes-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateHome = join(root, "state");
    const secretDir = join(root, "project", ".anet");
    const sessionDir = join(stateHome, "sessions", "%2Fworkspace", "session-1");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    mkdirSync(join(sessionDir, "terminal"), { recursive: true, mode: 0o777 });
    writeFileSync(join(sessionDir, "chat_history.jsonl"), "task material\n", { mode: 0o666 });
    writeFileSync(join(sessionDir, "terminal", "call.log"), "reply material\n", { mode: 0o666 });
    chmodSync(join(stateHome, "sessions"), 0o777);
    chmodSync(join(stateHome, "sessions", "%2Fworkspace"), 0o777);
    chmodSync(sessionDir, 0o777);

    prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(stateHome),
      stateHome,
      denyPaths: [secretDir],
    });

    for (const dir of [
      join(stateHome, "sessions"),
      join(stateHome, "sessions", "%2Fworkspace"),
      sessionDir,
      join(sessionDir, "terminal"),
    ]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(statSync(join(sessionDir, "chat_history.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(join(sessionDir, "terminal", "call.log")).mode & 0o777).toBe(0o600);
  });

  it("does not follow a symlink while repairing an existing session store", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-session-link-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateHome = join(root, "state");
    const secretDir = join(root, "project", ".anet");
    const external = join(root, "external");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    mkdirSync(join(stateHome, "sessions"), { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "keep"), "unchanged", { mode: 0o644 });
    symlinkSync(external, join(stateHome, "sessions", "redirect"), "dir");

    expect(() => prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(stateHome),
      stateHome,
      denyPaths: [secretDir],
    })).toThrow("symlink in isolated session store");
    expect(readFileSync(join(external, "keep"), "utf8")).toBe("unchanged");
    expect(statSync(join(external, "keep")).mode & 0o777).toBe(0o644);
  });

  it("enables the single TUI leader only for explicit copresence mode", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-home-copres-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateHome = join(root, "state");
    const secretDir = join(root, "project", ".anet");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(secretDir, { recursive: true });

    prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(stateHome),
      stateHome,
      denyPaths: [secretDir],
      projectCwd: join(root, "project"),
      useLeader: true,
    });

    const config = readFileSync(join(stateHome, "config.toml"), "utf8");
    expect(config).toContain("[cli]\nuse_leader = true");
    expect(config).toContain('[ui]\ndefault_selected_permission = "allow_once"');
    expect(config).toContain("remember_tool_approvals = false");
    expect(readFileSync(join(stateHome, "requirements.toml"), "utf8"))
      .toBe("[ui]\ndisable_bypass_permissions_mode = true\nyolo = false\n");
    const sandbox = readFileSync(join(stateHome, "sandbox.toml"), "utf8");
    expect(sandbox).toContain(join(root, "project", ".grok"));
    expect(sandbox).toContain(join(root, "project", ".claude"));
    expect(sandbox).toContain(join(root, "project", ".mcp.json"));

    prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(stateHome),
      stateHome,
      denyPaths: [secretDir],
      projectCwd: join(root, "project"),
      useLeader: false,
    });
    expect(existsSync(join(stateHome, "requirements.toml"))).toBe(false);
    expect(readFileSync(join(stateHome, "config.toml"), "utf8"))
      .not.toContain("default_selected_permission");
  });

  it("refuses to claim sandbox isolation when no deny target exists", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-home-empty-"));
    roots.push(root);
    expect(() => prepareGrokCliHome({
      sourceHome: join(root, "source"),
      stateRoot: root,
      stateHome: join(root, "state"),
      denyPaths: [join(root, "missing")],
    })).toThrow("existing secret path");
  });

  it("removes runtime-owned native hooks before every turn", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-home-hooks-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateHome = join(root, "state");
    const secretDir = join(root, "project", ".anet");
    const hookDir = join(stateHome, "hooks");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, "session-start.json"), "{}");

    prepareGrokCliHome({ sourceHome, stateRoot: dirname(stateHome), stateHome, denyPaths: [secretDir] });

    expect(() => statSync(hookDir)).toThrow();
  });

  it("unlinks a runtime-owned hook symlink without touching its external target", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-hook-link-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateHome = join(root, "state");
    const external = join(root, "external");
    const secretDir = join(root, "project", ".anet");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(stateHome, { recursive: true });
    mkdirSync(external, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(external, "sentinel"), "keep");
    symlinkSync(external, join(stateHome, "hooks"), "dir");

    prepareGrokCliHome({ sourceHome, stateRoot: dirname(stateHome), stateHome, denyPaths: [secretDir] });

    expect(existsSync(join(stateHome, "hooks"))).toBe(false);
    expect(readFileSync(join(external, "sentinel"), "utf8")).toBe("keep");
  });

  it("fails closed when a project native hook path exists", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-project-hooks-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateHome = join(root, "state");
    const projectCwd = join(root, "project");
    const secretDir = join(projectCwd, ".anet");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    mkdirSync(join(projectCwd, ".grok", "hooks"), { recursive: true });

    expect(() => prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(stateHome),
      stateHome,
      projectCwd,
      denyPaths: [secretDir],
    })).toThrow("outside the model tool sandbox");
  });

  it("rejects repo-root hooks from a nested cwd and dangling hook links", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-root-hooks-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateHome = join(root, "state");
    const project = join(root, "project");
    const nested = join(project, "packages", "app");
    const secretDir = join(project, ".anet");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, ".grok"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    symlinkSync(join(root, "missing-hooks"), join(project, ".grok", "hooks"));

    expect(() => prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(stateHome),
      stateHome,
      projectCwd: nested,
      denyPaths: [secretDir],
    })).toThrow("project hooks");
  });

  it("rejects a symlinked project .grok directory", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-project-link-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateHome = join(root, "state");
    const project = join(root, "project");
    const external = join(root, "external-grok");
    const secretDir = join(project, ".anet");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(external, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    symlinkSync(external, join(project, ".grok"), "dir");

    expect(() => prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(stateHome),
      stateHome,
      projectCwd: project,
      denyPaths: [secretDir],
    })).toThrow("expected a real directory");
  });

  it("rejects symlinked isolated homes and generated state without changing targets", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-state-links-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateRoot = join(root, "states");
    const stateHome = join(stateRoot, "node");
    const externalHome = join(root, "external-home");
    const secretDir = join(root, "project", ".anet");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(stateRoot, { recursive: true });
    mkdirSync(externalHome, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(externalHome, "sentinel"), "keep");
    symlinkSync(externalHome, stateHome, "dir");

    expect(() => prepareGrokCliHome({ sourceHome, stateRoot, stateHome, denyPaths: [secretDir] }))
      .toThrow("expected a real directory");
    expect(readFileSync(join(externalHome, "sentinel"), "utf8")).toBe("keep");

    rmSync(stateHome);
    mkdirSync(stateHome);
    const externalConfig = join(root, "external-config");
    writeFileSync(externalConfig, "keep");
    symlinkSync(externalConfig, join(stateHome, "config.toml"));
    expect(() => prepareGrokCliHome({ sourceHome, stateRoot, stateHome, denyPaths: [secretDir] }))
      .toThrow("expected a regular file");
    expect(readFileSync(externalConfig, "utf8")).toBe("keep");
  });

  it("rejects a state-home path escape before chmod, removal, or writes", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-state-escape-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateRoot = join(root, "state-root");
    const escapedHome = resolve(stateRoot, "..");
    const secretDir = join(root, "project", ".anet");
    const sentinel = join(root, "hooks", "sentinel");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(stateRoot, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, "keep");
    const modeBefore = statSync(root).mode & 0o777;

    expect(() => prepareGrokCliHome({
      sourceHome,
      stateRoot,
      stateHome: escapedHome,
      denyPaths: [secretDir],
    })).toThrow("must be one direct child");

    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(statSync(root).mode & 0o777).toBe(modeBefore);
    expect(existsSync(join(root, "config.toml"))).toBe(false);
  });

  it("requires a valid zero-hook inspect response", () => {
    expect(() => assertNoDiscoveredGrokHooks(JSON.stringify({ hooks: [], plugins: [] }))).not.toThrow();
    expect(() => assertNoDiscoveredGrokHooks("not-json")).toThrow("invalid JSON");
    expect(() => assertNoDiscoveredGrokHooks(JSON.stringify({ plugins: [] }))).toThrow("missing the hooks array");
    expect(() => assertNoDiscoveredGrokHooks(JSON.stringify({ hooks: [{ target: "tripwire" }] })))
      .toThrow("discovered 1 executable hook");
    expect(() => assertNoDiscoveredGrokHooks(JSON.stringify({
      hooks: [],
      plugins: [{ name: "tripwire", hookCount: 1 }],
    }))).toThrow("discovered 1 executable hook");
  });

  it("flocks the canonical project inode across symlink aliases and releases cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-turn-lock-"));
    roots.push(root);
    const project = join(root, "project");
    const nested = join(project, "packages", "app");
    const alias = join(root, "project-alias");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, ".anet"), { recursive: true });
    // A nested .anet makes an incorrect lexical-root walk observably lock the
    // wrong inode instead of accidentally failing for a missing directory.
    mkdirSync(join(nested, ".anet"), { recursive: true });
    symlinkSync(nested, alias, "dir");

    const first = await acquireGrokProjectTurnLock(project);
    let busy = "";
    try { await acquireGrokProjectTurnLock(alias); } catch (error: any) { busy = error?.message || String(error); }
    expect(busy).toContain("project is busy");
    await first.release();
    const second = await acquireGrokProjectTurnLock(alias);
    await second.release();
    expect(existsSync(join(project, ".anet", ".grok-build-cli-turn.lock"))).toBe(true);
  });

  it("gives the real flock holder only the exact helper environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-lock-env-"));
    roots.push(root);
    const project = join(root, "project");
    const capture = join(root, "holder.env");
    const wrapper = join(root, "capture-flock");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, ".anet"), { recursive: true });
    writeFileSync(wrapper, [
      "#!/bin/sh",
      `/bin/cat /proc/$$/environ > "${capture}"`,
      "exec /usr/bin/flock \"$@\"",
      "",
    ].join("\n"));
    chmodSync(wrapper, 0o700);

    const injectedEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: "/tmp/reviewed-holder",
      LANG: "C.UTF-8",
      TERM: "xterm-256color",
      HOME: "/private/home",
      GROK_AUTH_PATH: "/private/auth.json",
      DATABASE_URL: "postgres://private",
      AWS_ACCESS_KEY_ID: "aws-private",
      AWS_SECRET_ACCESS_KEY: "aws-secret-private",
      ARBITRARY_TOKEN: "token-private",
      ARBITRARY_SECRET: "secret-private",
      ARBITRARY_KEY: "key-private",
      NTOK: "ntok_private",
      UTOK: "utok_private",
    };
    const lock = await acquireGrokProjectTurnLock(project, wrapper, injectedEnv);
    try {
      expect(parseNulEnvironment(readFileSync(capture))).toEqual({
        PATH: "/usr/local/bin:/usr/bin:/bin",
        TMPDIR: "/tmp/reviewed-holder",
        LANG: "C.UTF-8",
      });
    } finally {
      await lock.release();
    }
  });
});

function parseNulEnvironment(raw: Buffer): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const entry of raw.toString("utf8").split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error(`invalid environment entry: ${entry}`);
    parsed[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return parsed;
}
