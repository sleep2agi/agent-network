import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import {
  acquireGrokProjectTurnLock,
  assertNoDiscoveredGrokHooks,
  cleanupGrokCliPostStopState,
  cleanupGrokCliStoppedTuiGeneration,
  grokCliStateKey,
  GROK_POST_STOP_CLEANUP_POLICY,
  prepareGrokCliHome,
} from "./grok-build-cli-home";
import { assertGrokCopresenceAgentProfile } from "./grok-copresence/policy";

const roots: string[] = [];
const TUI_PID = 42;

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
    expect(config).toContain("[session]\nload_envrc = false");
    expect(config).toContain("[features]\ntelemetry = false");
    expect(config).toContain("[telemetry]\nmixpanel_enabled = false\ntrace_upload = false");
    expect(existsSync(join(stateHome, "requirements.toml"))).toBe(false);
    expect(existsSync(join(stateHome, "trusted_folders.toml"))).toBe(false);
    expect(first.copresenceAgentProfile).toBeUndefined();
    expect(existsSync(join(stateHome, "anet-copresence-preview.md"))).toBe(false);
    const sandbox = readFileSync(join(stateHome, "sandbox.toml"), "utf8");
    expect(sandbox).toContain(secretDir);
    expect(sandbox).toContain(join(sourceHome, "auth.json"));
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

  it("keeps the post-stop cleanup policy exact and reviewable", () => {
    expect(GROK_POST_STOP_CLEANUP_POLICY).toEqual({
      stateFiles: ["CHANGELOG.json", "CHANGELOG.md", "README.md", "sandbox-events.jsonl"],
      emptyStateFiles: ["leader.log"],
      cwdSessionFiles: ["prompt_history.jsonl"],
      sessionRootFiles: ["session_search.sqlite"],
      projectSandboxPlaceholders: {
        basenames: [".grok", ".claude", ".cursor", ".mcp.json", ".envrc"],
        type: "single-link-empty-regular-file",
        mode: "0444",
        owner: "currentUid",
      },
      sandboxBlockedDirectoryBinding: {
        source: "confirmedTuiProcessIds",
        prefix: "sandbox-blocked-dir.",
      },
      nativeLeaderLockBinding: {
        source: "leaderSocket",
        replaceExtension: ".lock",
      },
    });
  });

  it("removes exact empty read-only project placeholders before resume without admitting executable sources", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-post-stop-project-placeholders-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateHome = join(root, "state");
    const resumedStateHome = join(root, "resumed-state");
    const runtime = join(root, "runtime");
    const project = join(root, "project");
    const secretDir = join(project, ".anet");
    for (const directory of [sourceHome, stateHome, runtime, secretDir]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }

    const pinnedPlaceholders = [".grok", ".claude", ".cursor", ".mcp.json", ".envrc"];
    for (const name of pinnedPlaceholders) {
      const placeholder = join(project, name);
      writeFileSync(placeholder, "", { mode: 0o444 });
      chmodSync(placeholder, 0o444);
    }
    const unknownPlaceholder = join(project, ".grok-future-placeholder");
    writeFileSync(unknownPlaceholder, "", { mode: 0o444 });
    chmodSync(unknownPlaceholder, 0o444);

    cleanupGrokCliPostStopState({
      stateHome,
      projectCwd: project,
      leaderSocket: join(runtime, "leader.sock"),
      tuiProcessIds: [],
    });

    for (const name of pinnedPlaceholders) {
      expect(existsSync(join(project, name)), name).toBe(false);
    }
    expect(existsSync(unknownPlaceholder)).toBe(true);
    expect(statSync(unknownPlaceholder).mode & 0o777).toBe(0o444);

    // A real source at the same basename is not a benign placeholder. Resume
    // must still reject it at the unchanged folder-trust boundary.
    mkdirSync(join(project, ".grok"), { mode: 0o700 });
    writeFileSync(join(project, ".grok", "config.toml"), "[tools]\nallow = true\n", { mode: 0o600 });
    expect(() => prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(resumedStateHome),
      stateHome: resumedStateHome,
      projectCwd: project,
      useLeader: true,
      denyPaths: [secretDir],
    })).toThrow("project executable configuration");
    expect(existsSync(resumedStateHome)).toBe(false);
  });

  it("validates every exact project placeholder before unlinking any sibling", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-project-placeholders-batch-"));
    roots.push(root);
    const stateHome = join(root, "state");
    const runtime = join(root, "runtime");
    const project = join(root, "project");
    for (const directory of [stateHome, runtime, project]) mkdirSync(directory, { mode: 0o700 });
    for (const name of [".grok", ".claude"]) {
      writeFileSync(join(project, name), "", { mode: 0o444 });
      chmodSync(join(project, name), 0o444);
    }
    const wrongMode = join(project, ".cursor");
    writeFileSync(wrongMode, "", { mode: 0o644 });
    chmodSync(wrongMode, 0o644);

    expect(() => cleanupGrokCliPostStopState({
      stateHome,
      projectCwd: project,
      leaderSocket: join(runtime, "leader.sock"),
      tuiProcessIds: [],
    })).toThrow("mode 0444");

    for (const name of [".grok", ".claude", ".cursor"]) {
      expect(lstatSync(join(project, name)).isFile(), name).toBe(true);
    }
    expect(statSync(join(project, ".grok")).mode & 0o7777).toBe(0o444);
    expect(statSync(join(project, ".claude")).mode & 0o7777).toBe(0o444);
    expect(statSync(wrongMode).mode & 0o7777).toBe(0o644);
  });

  it("preserves nonempty, linked, wrong-mode, and wrong-type project counterexamples", () => {
    const cases: Array<{
      label: string;
      basename: string;
      seed(path: string, root: string): void;
    }> = [
      {
        label: "nonempty",
        basename: ".grok",
        seed(path) {
          writeFileSync(path, "executable source\n", { mode: 0o444 });
          chmodSync(path, 0o444);
        },
      },
      {
        label: "symlink",
        basename: ".claude",
        seed(path, root) {
          const external = join(root, "external-symlink-target");
          writeFileSync(external, "external stays\n", { mode: 0o600 });
          symlinkSync(external, path);
        },
      },
      {
        label: "hardlink",
        basename: ".cursor",
        seed(path, root) {
          const external = join(root, "external-hardlink-target");
          writeFileSync(external, "", { mode: 0o444 });
          chmodSync(external, 0o444);
          linkSync(external, path);
        },
      },
      {
        label: "wrong-mode",
        basename: ".mcp.json",
        seed(path) {
          writeFileSync(path, "", { mode: 0o444 });
          chmodSync(path, 0o400);
        },
      },
      {
        label: "directory",
        basename: ".envrc",
        seed(path) {
          mkdirSync(path, { mode: 0o700 });
        },
      },
    ];

    for (const scenario of cases) {
      const root = mkdtempSync(join(tmpdir(), `grok-cli-project-placeholder-${scenario.label}-`));
      roots.push(root);
      const stateHome = join(root, "state");
      const runtime = join(root, "runtime");
      const project = join(root, "project");
      for (const directory of [stateHome, runtime, project]) mkdirSync(directory, { mode: 0o700 });
      const candidate = join(project, scenario.basename);
      scenario.seed(candidate, root);
      const before = lstatSync(candidate);

      expect(() => cleanupGrokCliPostStopState({
        stateHome,
        projectCwd: project,
        leaderSocket: join(runtime, "leader.sock"),
        tuiProcessIds: [],
      }), scenario.label).toThrow("expected an empty owner-held single-link regular file with mode 0444");

      const after = lstatSync(candidate);
      expect(after.dev, scenario.label).toBe(before.dev);
      expect(after.ino, scenario.label).toBe(before.ino);
    }
  });

  it("preserves real project extension directories and still rejects executable contents on resume", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-project-real-extension-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateHome = join(root, "state");
    const resumedStateHome = join(root, "resumed-state");
    const runtime = join(root, "runtime");
    const project = join(root, "project");
    const secretDir = join(project, ".anet");
    for (const directory of [sourceHome, stateHome, runtime, secretDir]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    for (const name of [".grok", ".claude", ".cursor"]) {
      mkdirSync(join(project, name), { mode: 0o700 });
    }
    const hook = join(project, ".grok", "hooks", "hook.json");
    mkdirSync(dirname(hook), { recursive: true, mode: 0o700 });
    writeFileSync(hook, "{\"command\":\"tripwire\"}\n", { mode: 0o600 });

    cleanupGrokCliPostStopState({
      stateHome,
      projectCwd: project,
      leaderSocket: join(runtime, "leader.sock"),
      tuiProcessIds: [],
    });

    expect(readFileSync(hook, "utf8")).toBe("{\"command\":\"tripwire\"}\n");
    for (const name of [".grok", ".claude", ".cursor"]) {
      expect(lstatSync(join(project, name)).isDirectory(), name).toBe(true);
    }
    expect(() => prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(resumedStateHome),
      stateHome: resumedStateHome,
      projectCwd: project,
      useLeader: true,
      denyPaths: [secretDir],
    })).toThrow("project executable configuration");
    expect(existsSync(resumedStateHome)).toBe(false);
  });

  it("removes only exact transient state and hardens retained post-stop state", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-post-stop-"));
    roots.push(root);
    const stateHome = join(root, "state");
    const runtime = join(root, "runtime");
    const cwd = join(root, "project");
    const encodedCwd = encodeURIComponent(cwd);
    const cwdSessions = join(stateHome, "sessions", encodedCwd);
    const session = join(cwdSessions, "11111111-1111-4111-8111-111111111111");
    const identity = join(root, "identity");
    for (const directory of [stateHome, runtime, cwd, session, join(stateHome, "logs"), join(stateHome, "docs")]) {
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      chmodSync(directory, directory === stateHome || directory === runtime || directory === cwd ? 0o700 : 0o755);
    }
    for (const name of GROK_POST_STOP_CLEANUP_POLICY.stateFiles) {
      writeFileSync(join(stateHome, name), "pinned vendor state\n", { mode: 0o644 });
    }
    writeFileSync(join(stateHome, "leader.log"), "", { mode: 0o644 });
    writeFileSync(join(cwdSessions, "prompt_history.jsonl"), "raw prompt\n", { mode: 0o644 });
    writeFileSync(join(stateHome, "sessions", "session_search.sqlite"), "search index\n", { mode: 0o644 });
    writeFileSync(join(session, "updates.jsonl"), "authoritative state\n", { mode: 0o644 });
    writeFileSync(join(stateHome, "logs", "unified.jsonl"), "retained log\n", { mode: 0o644 });
    writeFileSync(join(stateHome, "docs", "guide.md"), "static guide\n", { mode: 0o644 });
    writeFileSync(join(stateHome, "unknown-future-state"), "leave for scanner\n", { mode: 0o644 });
    writeFileSync(join(runtime, "l.lock"), "1\n", { mode: 0o644 });
    writeFileSync(identity, "identity\n", { mode: 0o644 });
    symlinkSync(identity, join(stateHome, "agent_id"));
    const blocked = join(stateHome, `sandbox-blocked-dir.${TUI_PID}`);
    // An empty mode-000 marker under Grok's own (non node-pty) pid must be
    // reclaimed PID-independently by the harden walk, not survive as a fatal
    // structural anomaly, and an empty sandbox-blocked file marker likewise.
    const untrackedBlocked = join(stateHome, `sandbox-blocked-dir.${TUI_PID + 1}`);
    const untrackedBlockedFile = join(stateHome, `sandbox-blocked.${TUI_PID + 2}`);
    mkdirSync(blocked, { mode: 0o700 });
    chmodSync(blocked, 0o000);
    mkdirSync(untrackedBlocked, { mode: 0o700 });
    chmodSync(untrackedBlocked, 0o000);
    writeFileSync(untrackedBlockedFile, "", { mode: 0o600 });
    chmodSync(untrackedBlockedFile, 0o000);

    cleanupGrokCliPostStopState({
      stateHome,
      projectCwd: cwd,
      leaderSocket: join(runtime, "l.sock"),
      tuiProcessIds: [TUI_PID],
    });

    for (const name of [
      ...GROK_POST_STOP_CLEANUP_POLICY.stateFiles,
      ...GROK_POST_STOP_CLEANUP_POLICY.emptyStateFiles,
    ]) expect(existsSync(join(stateHome, name)), name).toBe(false);
    expect(existsSync(join(cwdSessions, "prompt_history.jsonl"))).toBe(false);
    expect(existsSync(join(stateHome, "sessions", "session_search.sqlite"))).toBe(false);
    expect(existsSync(blocked)).toBe(false);
    expect(existsSync(untrackedBlocked)).toBe(false);
    expect(existsSync(untrackedBlockedFile)).toBe(false);
    for (const file of [
      join(session, "updates.jsonl"),
      join(stateHome, "logs", "unified.jsonl"),
      join(stateHome, "docs", "guide.md"),
      join(stateHome, "unknown-future-state"),
      join(runtime, "l.lock"),
    ]) expect(statSync(file).mode & 0o777, file).toBe(0o600);
    for (const directory of [stateHome, join(stateHome, "sessions"), cwdSessions, session,
      join(stateHome, "logs"), join(stateHome, "docs")]) {
      expect(statSync(directory).mode & 0o777, directory).toBe(0o700);
    }
    expect(lstatSync(join(stateHome, "agent_id")).isSymbolicLink()).toBe(true);
    expect(readFileSync(identity, "utf8")).toBe("identity\n");
    expect(statSync(identity).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(stateHome, "unknown-future-state"), "utf8"))
      .toBe("leave for scanner\n");
  });

  it("hardens only the native lock derived from the exact leader socket", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-post-stop-native-lock-"));
    roots.push(root);
    const stateHome = join(root, "state");
    const runtime = join(root, "runtime");
    const cwd = join(root, "project");
    for (const directory of [stateHome, runtime, cwd]) mkdirSync(directory, { mode: 0o700 });
    const nativeLock = join(runtime, "l.lock");
    const unknownSibling = join(runtime, "leader.lock");
    writeFileSync(nativeLock, "1\n", { mode: 0o644 });
    writeFileSync(unknownSibling, "unknown\n", { mode: 0o644 });

    cleanupGrokCliPostStopState({
      stateHome,
      projectCwd: cwd,
      leaderSocket: join(runtime, "l.sock"),
      tuiProcessIds: [],
    });

    expect(statSync(nativeLock).mode & 0o777).toBe(0o600);
    expect(statSync(unknownSibling).mode & 0o777).toBe(0o644);
  });

  it("retains a non-empty leader log and rejects post-stop link attacks", () => {
    const nonemptyRoot = mkdtempSync(join(tmpdir(), "grok-cli-post-stop-log-"));
    roots.push(nonemptyRoot);
    const nonemptyHome = join(nonemptyRoot, "state");
    const nonemptyRuntime = join(nonemptyRoot, "runtime");
    const nonemptyCwd = join(nonemptyRoot, "project");
    for (const directory of [nonemptyHome, nonemptyRuntime, nonemptyCwd]) {
      mkdirSync(directory, { mode: 0o700 });
    }
    const leaderLog = join(nonemptyHome, "leader.log");
    writeFileSync(leaderLog, "must remain visible to scanner\n", { mode: 0o644 });
    expect(() => cleanupGrokCliPostStopState({
      stateHome: nonemptyHome,
      projectCwd: nonemptyCwd,
      leaderSocket: join(nonemptyRuntime, "leader.sock"),
      tuiProcessIds: [],
    })).toThrow("expected size 0");
    expect(readFileSync(leaderLog, "utf8")).toBe("must remain visible to scanner\n");

    const linkRoot = mkdtempSync(join(tmpdir(), "grok-cli-post-stop-link-"));
    roots.push(linkRoot);
    const linkHome = join(linkRoot, "state");
    const linkRuntime = join(linkRoot, "runtime");
    const linkCwd = join(linkRoot, "project");
    const cwdSessions = join(linkHome, "sessions", encodeURIComponent(linkCwd));
    const external = join(linkRoot, "external-prompt");
    mkdirSync(cwdSessions, { recursive: true, mode: 0o700 });
    mkdirSync(linkRuntime, { mode: 0o700 });
    mkdirSync(linkCwd, { mode: 0o700 });
    writeFileSync(external, "external stays\n", { mode: 0o644 });
    symlinkSync(external, join(cwdSessions, "prompt_history.jsonl"));
    expect(() => cleanupGrokCliPostStopState({
      stateHome: linkHome,
      projectCwd: linkCwd,
      leaderSocket: join(linkRuntime, "leader.sock"),
      tuiProcessIds: [],
    })).toThrow("single-link regular file");
    expect(readFileSync(external, "utf8")).toBe("external stays\n");
    expect(statSync(external).mode & 0o777).toBe(0o644);

    rmSync(join(cwdSessions, "prompt_history.jsonl"));
    linkSync(external, join(cwdSessions, "prompt_history.jsonl"));
    expect(() => cleanupGrokCliPostStopState({
      stateHome: linkHome,
      projectCwd: linkCwd,
      leaderSocket: join(linkRuntime, "leader.sock"),
      tuiProcessIds: [],
    })).toThrow("single-link regular file");
    expect(readFileSync(external, "utf8")).toBe("external stays\n");
  });

  it("refuses a non-empty exact sandbox placeholder", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-post-stop-blocked-"));
    roots.push(root);
    const stateHome = join(root, "state");
    const runtime = join(root, "runtime");
    const cwd = join(root, "project");
    const blocked = join(stateHome, `sandbox-blocked-dir.${TUI_PID}`);
    mkdirSync(blocked, { recursive: true, mode: 0o700 });
    mkdirSync(runtime, { mode: 0o700 });
    mkdirSync(cwd, { mode: 0o700 });
    writeFileSync(join(blocked, "unknown"), "counterexample\n", { mode: 0o600 });
    expect(() => cleanupGrokCliPostStopState({
      stateHome,
      projectCwd: cwd,
      leaderSocket: join(runtime, "leader.sock"),
      tuiProcessIds: [TUI_PID],
    })).toThrow("expected an empty real directory");
    expect(readFileSync(join(blocked, "unknown"), "utf8")).toBe("counterexample\n");
  });

  it("reclaims an empty mode-000 sandbox marker under a foreign pid without aborting", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-post-stop-foreign-blocked-"));
    roots.push(root);
    const stateHome = join(root, "state");
    const runtime = join(root, "runtime");
    const cwd = join(root, "project");
    for (const directory of [stateHome, runtime, cwd]) mkdirSync(directory, { mode: 0o700 });
    // Grok plants these under ITS OWN pid, which never matches the node-pty ids
    // passed as tuiProcessIds, so the exact PID-bound cleanup never sees them.
    const foreignDir = join(stateHome, `sandbox-blocked-dir.${TUI_PID + 7}`);
    const foreignFile = join(stateHome, `sandbox-blocked.${TUI_PID + 8}`);
    mkdirSync(foreignDir, { mode: 0o700 });
    chmodSync(foreignDir, 0o000);
    writeFileSync(foreignFile, "", { mode: 0o600 });
    chmodSync(foreignFile, 0o000);

    cleanupGrokCliPostStopState({
      stateHome,
      projectCwd: cwd,
      leaderSocket: join(runtime, "l.sock"),
      tuiProcessIds: [TUI_PID],
    });

    expect(existsSync(foreignDir)).toBe(false);
    expect(existsSync(foreignFile)).toBe(false);
    expect(statSync(stateHome).mode & 0o777).toBe(0o700);
  });

  it("keeps a non-empty foreign sandbox marker unreadable so it fails closed", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-post-stop-foreign-nonempty-"));
    roots.push(root);
    const stateHome = join(root, "state");
    const runtime = join(root, "runtime");
    const cwd = join(root, "project");
    for (const directory of [stateHome, runtime, cwd]) mkdirSync(directory, { mode: 0o700 });
    const foreignDir = join(stateHome, `sandbox-blocked-dir.${TUI_PID + 7}`);
    const foreignFile = join(stateHome, `sandbox-blocked.${TUI_PID + 8}`);
    mkdirSync(foreignDir, { mode: 0o700 });
    writeFileSync(join(foreignDir, "residue"), "unexpected\n", { mode: 0o600 });
    chmodSync(foreignDir, 0o000);
    writeFileSync(foreignFile, "unexpected\n", { mode: 0o600 });
    chmodSync(foreignFile, 0o000);

    // A non-empty marker is not the benign sandbox placeholder; the harden walk
    // must neither abort nor remove it. It is left unreadable and owner-only so
    // the containment scanner maps it to the fatal structural role.
    cleanupGrokCliPostStopState({
      stateHome,
      projectCwd: cwd,
      leaderSocket: join(runtime, "l.sock"),
      tuiProcessIds: [TUI_PID],
    });

    expect(existsSync(foreignDir)).toBe(true);
    expect(existsSync(foreignFile)).toBe(true);
    expect(statSync(foreignDir).mode & 0o777).toBe(0o000);
    expect(statSync(foreignFile).mode & 0o777).toBe(0o000);
    chmodSync(foreignDir, 0o700);
    expect(readdirSync(foreignDir)).toEqual(["residue"]);
    chmodSync(foreignFile, 0o600);
    expect(readFileSync(foreignFile, "utf8")).toBe("unexpected\n");
  });

  it("validates exact TUI process ids before mutation and refuses a placeholder symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-post-stop-pid-binding-"));
    roots.push(root);
    const stateHome = join(root, "state");
    const runtime = join(root, "runtime");
    const cwd = join(root, "project");
    for (const directory of [stateHome, runtime, cwd]) mkdirSync(directory, { mode: 0o700 });
    const leaderLog = join(stateHome, "leader.log");
    const blocked = join(stateHome, `sandbox-blocked-dir.${TUI_PID}`);
    writeFileSync(leaderLog, "", { mode: 0o600 });
    mkdirSync(blocked, { mode: 0o000 });

    expect(() => cleanupGrokCliPostStopState({
      stateHome,
      projectCwd: cwd,
      leaderSocket: join(runtime, "leader.sock"),
      tuiProcessIds: [-1],
    })).toThrow("positive integer TUI process ids");
    expect(existsSync(leaderLog)).toBe(true);
    expect(existsSync(blocked)).toBe(true);
    cleanupGrokCliStoppedTuiGeneration({ stateHome, tuiProcessId: TUI_PID });
    expect(existsSync(blocked)).toBe(false);
    expect(existsSync(leaderLog)).toBe(true);

    const linkRoot = mkdtempSync(join(tmpdir(), "grok-cli-post-stop-pid-link-"));
    roots.push(linkRoot);
    const linkHome = join(linkRoot, "state");
    const external = join(linkRoot, "external");
    for (const directory of [linkHome, external]) {
      mkdirSync(directory, { mode: 0o700 });
    }
    writeFileSync(join(external, "keep"), "unchanged\n", { mode: 0o600 });
    symlinkSync(external, join(linkHome, `sandbox-blocked-dir.${TUI_PID}`), "dir");
    expect(() => cleanupGrokCliStoppedTuiGeneration({
      stateHome: linkHome,
      tuiProcessId: TUI_PID,
    })).toThrow("expected an empty real directory");
    expect(readFileSync(join(external, "keep"), "utf8")).toBe("unchanged\n");
  });

  it("enables the single TUI leader only for explicit copresence mode", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-home-copres-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateHome = join(root, "state");
    const secretDir = join(root, "project", ".anet");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    const sourceAuth = join(sourceHome, "auth.json");
    writeFileSync(sourceAuth, "{}\n", { mode: 0o600 });
    for (const extensionDir of ["agents", "skills", "commands", "lsp", "lsp-servers"]) {
      mkdirSync(join(stateHome, extensionDir), { recursive: true });
      writeFileSync(join(stateHome, extensionDir, "stale"), "must be removed\n");
    }
    writeFileSync(join(stateHome, "lsp.json"), "{}\n");

    const prepared = prepareGrokCliHome({
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
    const trustStore = join(stateHome, "trusted_folders.toml");
    const trust = readFileSync(trustStore, "utf8");
    expect(trust).toContain(`[folders.${JSON.stringify(join(root, "project"))}]`);
    expect(trust).toContain("trusted = true");
    expect(trust).toMatch(/decided_at = \d+/);
    expect(statSync(trustStore).mode & 0o777).toBe(0o600);
    const sandbox = readFileSync(join(stateHome, "sandbox.toml"), "utf8");
    expect(sandbox).toContain(join(root, "project", ".grok"));
    expect(sandbox).toContain(join(root, "project", ".claude"));
    expect(sandbox).toContain(join(root, "project", ".mcp.json"));
    expect(sandbox).not.toContain(sourceAuth);
    for (const extensionDir of ["agents", "skills", "commands", "lsp", "lsp-servers"]) {
      expect(existsSync(join(stateHome, extensionDir))).toBe(false);
    }
    expect(existsSync(join(stateHome, "lsp.json"))).toBe(false);
    expect(prepared.copresenceAgentProfile).toBe(join(stateHome, "anet-copresence-preview.md"));
    const agentProfile = readFileSync(prepared.copresenceAgentProfile!, "utf8");
    expect(agentProfile).toContain("injectDefaultTools: false");
    expect(agentProfile).toContain("discoverSkills: false");
    expect(agentProfile).toContain("inheritSkills: false");
    expect(agentProfile).toContain("ANET_COPRESENCE_PROFILE_V1");
    expect(agentProfile).toContain("tools:\n  - todo_write\n");
    expect(agentProfile).toContain("disallowedTools:\n  - search_tool\n  - use_tool\n");
    expect(agentProfile).not.toMatch(/^  - (?:read_file|search_replace|run_terminal|web_|image_|video_)/m);
    expect(statSync(prepared.copresenceAgentProfile!).mode & 0o777).toBe(0o600);
    expect(() => assertGrokCopresenceAgentProfile(prepared.copresenceAgentProfile!, stateHome))
      .not.toThrow();
    chmodSync(prepared.copresenceAgentProfile!, 0o666);
    expect(() => assertGrokCopresenceAgentProfile(prepared.copresenceAgentProfile!, stateHome))
      .toThrow("owner-only regular file");
    prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(stateHome),
      stateHome,
      denyPaths: [secretDir],
      projectCwd: join(root, "project"),
      useLeader: true,
    });
    writeFileSync(prepared.copresenceAgentProfile!, "---\nname: changed\n---\n", { mode: 0o600 });
    expect(() => assertGrokCopresenceAgentProfile(prepared.copresenceAgentProfile!, stateHome))
      .toThrow("differs from the fixed preview policy");
    prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(stateHome),
      stateHome,
      denyPaths: [secretDir],
      projectCwd: join(root, "project"),
      useLeader: true,
    });
    expect(() => assertGrokCopresenceAgentProfile(prepared.copresenceAgentProfile!, stateHome))
      .not.toThrow();
    const externalProfile = join(root, "external-agent.md");
    writeFileSync(externalProfile, "external\n", { mode: 0o644 });
    rmSync(prepared.copresenceAgentProfile!);
    symlinkSync(externalProfile, prepared.copresenceAgentProfile!);
    expect(() => prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(stateHome),
      stateHome,
      denyPaths: [secretDir],
      projectCwd: join(root, "project"),
      useLeader: true,
    })).toThrow("expected a regular file");
    expect(readFileSync(externalProfile, "utf8")).toBe("external\n");
    expect(statSync(externalProfile).mode & 0o777).toBe(0o644);
    rmSync(prepared.copresenceAgentProfile!);
    prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(stateHome),
      stateHome,
      denyPaths: [secretDir],
      projectCwd: join(root, "project"),
      useLeader: true,
    });

    prepareGrokCliHome({
      sourceHome,
      stateRoot: dirname(stateHome),
      stateHome,
      denyPaths: [secretDir],
      projectCwd: join(root, "project"),
      useLeader: false,
    });
    expect(existsSync(join(stateHome, "requirements.toml"))).toBe(false);
    expect(existsSync(trustStore)).toBe(false);
    expect(existsSync(join(stateHome, "anet-copresence-preview.md"))).toBe(false);
    expect(readFileSync(join(stateHome, "config.toml"), "utf8"))
      .not.toContain("default_selected_permission");
    expect(readFileSync(join(stateHome, "sandbox.toml"), "utf8")).toContain(sourceAuth);
  });

  it("rejects a shared auth path covered by a required sandbox deny before state mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-home-auth-overlap-"));
    roots.push(root);
    const protectedRoot = join(root, "protected");
    const sourceHome = join(protectedRoot, "source");
    const stateRoot = join(root, "state-root");
    const stateHome = join(stateRoot, "node");
    const project = join(root, "project");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(sourceHome, "auth.json"), "{}\n", { mode: 0o600 });

    expect(() => prepareGrokCliHome({
      sourceHome,
      stateRoot,
      stateHome,
      denyPaths: [protectedRoot],
      projectCwd: project,
      useLeader: true,
    })).toThrow("auth path overlaps a required sandbox deny");
    expect(existsSync(stateRoot)).toBe(false);
  });

  it("refuses to claim sandbox isolation when no deny target exists", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-home-empty-"));
    roots.push(root);
    mkdirSync(join(root, "source"));
    expect(() => prepareGrokCliHome({
      sourceHome: join(root, "source"),
      stateRoot: root,
      stateHome: join(root, "state"),
      denyPaths: [join(root, "missing")],
    })).toThrow("existing secret path");
  });

  it("rejects a source GROK_HOME reached through an ancestor symlink before state mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-source-ancestor-link-"));
    roots.push(root);
    const project = join(root, "project");
    const sourceHome = join(project, ".grok-auth");
    const alias = join(root, "project-alias");
    const aliasedSourceHome = join(alias, ".grok-auth");
    const stateRoot = join(root, "states");
    const stateHome = join(stateRoot, "node");
    const authPath = join(sourceHome, "auth.json");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(join(project, ".anet"), { recursive: true });
    writeFileSync(authPath, "{\"sentinel\":true}\n", { mode: 0o600 });
    symlinkSync(project, alias, "dir");

    expect(() => prepareGrokCliHome({
      sourceHome: aliasedSourceHome,
      stateRoot,
      stateHome,
      projectCwd: project,
      useLeader: true,
      denyPaths: [join(project, ".anet")],
    })).toThrow("must not traverse a symlinked ancestor");
    expect(existsSync(stateHome)).toBe(false);
    expect(readFileSync(authPath, "utf8")).toBe("{\"sentinel\":true}\n");
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
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
    })).toThrow("project executable configuration");
  });

  it("trusts only the exact canonical nested cwd and atomically replaces stale grants", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-trust-exact-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateRoot = join(root, "states");
    const stateHome = join(stateRoot, "node");
    const project = join(root, "project");
    const nested = join(project, "packages", "quoted-\"line\napp");
    const secretDir = join(project, ".anet");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    mkdirSync(stateHome, { recursive: true });
    const trustStore = join(stateHome, "trusted_folders.toml");
    writeFileSync(trustStore, [
      `[folders.${JSON.stringify(project)}]`,
      "trusted = true",
      "decided_at = 1",
      "",
    ].join("\n"), { mode: 0o644 });

    prepareGrokCliHome({
      sourceHome,
      stateRoot,
      stateHome,
      projectCwd: nested,
      useLeader: true,
      denyPaths: [secretDir],
    });

    const trust = readFileSync(trustStore, "utf8");
    const parsed = Bun.TOML.parse(trust) as {
      folders: Record<string, { trusted: boolean; decided_at: number }>;
    };
    expect(Object.keys(parsed)).toEqual(["folders"]);
    expect(Object.keys(parsed.folders)).toEqual([nested]);
    expect(Object.keys(parsed.folders[nested]!)).toEqual(["trusted", "decided_at"]);
    expect(parsed.folders[nested]!.trusted).toBe(true);
    expect(Number.isSafeInteger(parsed.folders[nested]!.decided_at)).toBe(true);
    expect(trust).not.toContain("quoted-\"line\napp");
    expect(trust).toContain("quoted-\\\"line\\napp");
    expect(statSync(trustStore).mode & 0o777).toBe(0o600);
    expect(readdirSync(stateHome).some((name) => /^\.trusted_folders\.toml\..+\.tmp$/.test(name))).toBe(false);
  });

  it("rejects broad or symlinked folder-trust targets before writing trust state", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-trust-boundary-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateRoot = join(root, "states");
    const stateHome = join(stateRoot, "node");
    const project = join(root, "project");
    const alias = join(root, "project-alias");
    const secretDir = join(project, ".anet");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    symlinkSync(project, alias, "dir");

    const base = { sourceHome, stateRoot, stateHome, denyPaths: [secretDir], useLeader: true };
    expect(() => prepareGrokCliHome({ ...base, projectCwd: alias }))
      .toThrow("symlinked project path");
    expect(existsSync(stateHome)).toBe(false);
    expect(() => prepareGrokCliHome({ ...base, projectCwd: "/" }))
      .toThrow("over-broad folder trust");
    expect(() => prepareGrokCliHome({ ...base, projectCwd: homedir() }))
      .toThrow("over-broad folder trust");
    expect(() => prepareGrokCliHome({ ...base, projectCwd: dirname(homedir()) }))
      .toThrow();
    expect(() => prepareGrokCliHome({ ...base, projectCwd: root }))
      .toThrow("overlapping runtime credential or state paths");
    expect(() => prepareGrokCliHome({ ...base, projectCwd: undefined }))
      .toThrow("requires an explicit project cwd");
  });

  it("refuses a planted trust-store symlink and leaves its target untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-trust-link-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateRoot = join(root, "states");
    const stateHome = join(stateRoot, "node");
    const project = join(root, "project");
    const secretDir = join(project, ".anet");
    const external = join(root, "external-trust.toml");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(stateHome, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(external, "sentinel\n", { mode: 0o644 });
    symlinkSync(external, join(stateHome, "trusted_folders.toml"));

    expect(() => prepareGrokCliHome({
      sourceHome,
      stateRoot,
      stateHome,
      projectCwd: project,
      useLeader: true,
      denyPaths: [secretDir],
    })).toThrow("expected a regular file");
    expect(readFileSync(external, "utf8")).toBe("sentinel\n");
    expect(statSync(external).mode & 0o777).toBe(0o644);
  });

  it("rejects every project executable source before granting folder trust", () => {
    const sources = [
      ".grok/config.toml",
      ".grok/sandbox.toml",
      ".grok/requirements.toml",
      ".grok/hooks-paths/entry.json",
      ".grok/settings.json",
      ".grok/managed_config.toml",
      ".grok/lsp.json",
      ".grok/hooks/hook.json",
      ".grok/plugins/plugin.json",
      ".mcp.json",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".cursor/hooks.json",
      ".cursor/mcp.json",
      ".grok/future-extension.bin",
      ".envrc",
    ];
    for (const [index, source] of sources.entries()) {
      const root = mkdtempSync(join(tmpdir(), `grok-cli-policy-${index}-`));
      roots.push(root);
      const sourceHome = join(root, "source");
      const stateRoot = join(root, "states");
      const stateHome = join(stateRoot, "node");
      const project = join(root, "project");
      const secretDir = join(project, ".anet");
      mkdirSync(sourceHome, { recursive: true });
      mkdirSync(secretDir, { recursive: true });
      mkdirSync(dirname(join(project, source)), { recursive: true });
      writeFileSync(join(project, source), "tripwire\n");
      expect(() => prepareGrokCliHome({
        sourceHome,
        stateRoot,
        stateHome,
        projectCwd: project,
        useLeader: true,
        denyPaths: [secretDir],
      })).toThrow("project executable configuration");
      expect(existsSync(stateHome)).toBe(false);
    }
  });

  it("does not impose the shared-folder strict policy on legacy headless mode", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-cli-headless-compat-"));
    roots.push(root);
    const sourceHome = join(root, "source");
    const stateRoot = join(root, "states");
    const stateHome = join(stateRoot, "node");
    const project = join(root, "project");
    const secretDir = join(project, ".anet");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    for (const source of [
      ".grok/config.toml",
      ".claude/settings.json",
      ".cursor/mcp.json",
      ".mcp.json",
      ".envrc",
    ]) {
      mkdirSync(dirname(join(project, source)), { recursive: true });
      writeFileSync(join(project, source), "legacy-headless-input\n");
    }

    expect(() => prepareGrokCliHome({
      sourceHome,
      stateRoot,
      stateHome,
      projectCwd: project,
      useLeader: false,
      denyPaths: [secretDir],
    })).not.toThrow();
    expect(existsSync(join(stateHome, "trusted_folders.toml"))).toBe(false);
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
    })).toThrow("project executable configuration");
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
