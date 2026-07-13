import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildGrokChildEnv,
  buildGrokPtyEnv,
  projectGrokChildEnv,
} from "../../agent-node/src/runtime/grok-child-env";
import { buildGrokAgentNodeEnv } from "../../agent-network/src/grok-copresence-profile";
import { prepareGrokCliHome } from "../../agent-node/src/runtime/grok-build-cli-home";
import { buildGrokCopresenceArgs } from "../../agent-node/src/runtime/grok-copresence/runtime";
import {
  CREDENTIAL_REDACTION,
  createCredentialRedactor,
} from "../../agent-node/src/credential-redaction";
import { PendingReplyQueue } from "../../agent-node/src/reply-reliability";
import { GoalStore, newGoal } from "../../agent-node/src/goals/store";

const ROOT = resolve(import.meta.dir, "../..");
const REQUIRED_MARKER_NAMES = [
  "DATABASE_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PREVIEW_MATERIAL",
  "ARBITRARY_TOKEN",
  "ARBITRARY_SECRET",
  "ARBITRARY_KEY",
  "ntok",
  "utok",
] as const;

function markers(): Record<(typeof REQUIRED_MARKER_NAMES)[number], string> {
  const values = Object.fromEntries(REQUIRED_MARKER_NAMES.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string" || value.length < 16) {
      throw new Error(`test224 marker ${name} is missing or too short`);
    }
  }
  return values as Record<(typeof REQUIRED_MARKER_NAMES)[number], string>;
}

function parseNulEnv(raw: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of new TextDecoder().decode(raw).split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error("child emitted malformed environment entry");
    out[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return out;
}

describe("test224 exact Grok child environment", () => {
  test("agent-node parent is also built from an exact empty allowlist", async () => {
    const injected = markers();
    const actual = buildGrokAgentNodeEnv({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp/test224-home",
      LANG: "C.UTF-8",
      GROK_BINARY: "/reviewed/grok",
      ...injected,
      NODE_OPTIONS: "--require=/tmp/unreviewed.js",
      COMMHUB_TOKEN: injected.ntok,
    });
    const expected = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp/test224-home",
      LANG: "C.UTF-8",
      GROK_BINARY: "/reviewed/grok",
      ANET_CONFIG_UPDATE_CAPABLE: "1",
    };
    expect(actual).toEqual(expected);
    const child = Bun.spawn(["/usr/bin/env", "-0"], { env: actual, stdout: "pipe" });
    const observed = parseNulEnv(await new Response(child.stdout).bytes());
    expect(await child.exited).toBe(0);
    expect(observed).toEqual(expected);
  });

  test("builds from an empty object and a real child observes exact set equality", async () => {
    const injected = markers();
    const parentEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: "/tmp/test224-runtime",
      LANG: "C.UTF-8",
      TERM: "xterm-256color",
      ...injected,
    };

    const baseline = buildGrokChildEnv({
      parentEnv,
      cwd: "/workspace/project",
      home: "/tmp/test224-grok-home",
      authPath: "/tmp/test224-grok-home/auth.json",
      oidcIssuer: "https://accounts.example.invalid",
      oidcClientId: "reviewed-public-client",
      expectedParentPid: 4242,
      defaultSelectedPermission: "allow_once",
    });
    const expected = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: "/tmp/test224-runtime",
      LANG: "C.UTF-8",
      TERM: "xterm-256color",
      HOME: "/tmp/test224-grok-home",
      PWD: "/workspace/project",
      GROK_HOME: "/tmp/test224-grok-home",
      GROK_AUTH_PATH: "/tmp/test224-grok-home/auth.json",
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
      GROK_OIDC_CLIENT_ID: "reviewed-public-client",
      ANET_EXPECTED_PARENT_PID: "4242",
      GROK_DEFAULT_SELECTED_PERMISSION: "allow_once",
    };
    expect(baseline).toEqual(expected);

    // Model an untrusted final-spawn callback trying to add every prohibited
    // family.  The projection must still yield the exact baseline set.
    const finalEnv = projectGrokChildEnv({ ...baseline, ...injected }, baseline);
    expect(finalEnv).toEqual(expected);
    expect(Object.keys(finalEnv).sort()).toEqual(Object.keys(expected).sort());
    expect(() => projectGrokChildEnv({
      ...baseline,
      PATH: "/tmp/unreviewed-bin",
    }, baseline)).toThrow("PATH");
    expect(() => projectGrokChildEnv({
      ...baseline,
      TERM: "unreviewed-terminal",
    }, baseline)).toThrow("TERM");
    const missingInherited = { ...baseline };
    delete missingInherited.LANG;
    expect(() => projectGrokChildEnv(missingInherited, baseline)).toThrow("LANG");

    const child = Bun.spawn(["/usr/bin/env", "-0"], {
      env: finalEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).bytes(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const observed = parseNulEnv(stdout);
    expect(observed).toEqual(expected);
    expect(Object.keys(observed).sort()).toEqual(Object.keys(expected).sort());
    for (const value of Object.values(injected)) {
      expect(Object.values(observed)).not.toContain(value);
    }

    const ptyEnv = buildGrokPtyEnv(
      { ...finalEnv, GROK_SANDBOX: "off" },
      baseline,
      "/workspace/project",
      "xterm-256color",
      "anet-reviewed-workspace",
    );
    expect(ptyEnv).toEqual({
      ...expected,
      PWD: "/workspace/project",
      TERM: "xterm-256color",
      GROK_SANDBOX: "anet-reviewed-workspace",
    });
    expect(Object.keys(ptyEnv).sort()).toEqual([
      ...Object.keys(expected),
      "GROK_SANDBOX",
    ].sort());
  });

  test("production-shaped setpriv/sh launcher preserves the exact final object", async () => {
    const cwd = ROOT;
    const expected = buildGrokChildEnv({
      parentEnv: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        DATABASE_URL: markers().DATABASE_URL,
      },
      cwd,
      home: "/tmp/test224-wrapper-home",
      authPath: "/tmp/test224-wrapper-home/auth.json",
      expectedParentPid: process.pid,
    }) as Record<string, string>;
    const child = Bun.spawn([
      "/usr/bin/setpriv",
      "--pdeathsig", "SIGKILL",
      "--",
      "/bin/sh", "-c",
      '[ "$PPID" -eq "$ANET_EXPECTED_PARENT_PID" ] || exit 125; exec "$@"',
      "anet-grok-supervisor",
      "/usr/bin/env", "--", "/usr/bin/env", "-0",
    ], {
      cwd,
      env: expected,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).bytes(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(parseNulEnv(stdout)).toEqual(expected);
  });
});

describe("test224 durable text boundaries", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "test224-persistence-"));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("inbound and assistant-shaped log/pending text contain no synthetic credential value", () => {
    const injected = markers();
    const rawValues = Object.values(injected);
    const redactor = createCredentialRedactor({ knownValues: rawValues });
    const message = [
      "preview task failed",
      ...rawValues,
      `DATABASE_URL=${injected.DATABASE_URL}`,
      `AWS_SECRET_ACCESS_KEY=${injected.AWS_SECRET_ACCESS_KEY}`,
      `CUSTOM_TOKEN=${injected.ARBITRARY_TOKEN}`,
      `CUSTOM_SECRET=${injected.ARBITRARY_SECRET}`,
      `CUSTOM_KEY=${injected.ARBITRARY_KEY}`,
    ].join(" | ");

    const logPath = join(dir, "ordinary.log");
    const safeLogLine = redactor.redactText(message).text;
    writeFileSync(logPath, safeLogLine + "\n", { mode: 0o600 });
    appendFileSync(logPath, redactor.redactText(`retry ${message}`).text + "\n");
    appendFileSync(
      logPath,
      redactor.redactText(`assistant reply PARTNER_SECRET=${injected.ARBITRARY_SECRET}`).text + "\n",
    );
    const logBytes = readFileSync(logPath, "utf8");
    for (const value of rawValues) expect(logBytes).not.toContain(value);
    expect(logBytes).toContain(CREDENTIAL_REDACTION);

    const queuePath = join(dir, "pending-replies.json");
    const queue = new PendingReplyQueue(queuePath, { redactor });
    queue.persist({
      to: `recipient-${injected.ntok}`,
      text: message,
      taskId: `task-${injected.utok}`,
      failed: true,
      queuedAt: 1,
      lastError: `transport ${message}`,
    });
    const queueBytes = readFileSync(queuePath, "utf8");
    for (const value of rawValues) expect(queueBytes).not.toContain(value);
    expect(queueBytes).toContain(CREDENTIAL_REDACTION);
    expect(statSync(queuePath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.includes("pending-replies"))).toEqual([
      "pending-replies.json",
    ]);
  });

  test("legacy broad-mode queue is scrubbed and repaired before it is returned", () => {
    const injected = markers();
    const rawValues = Object.values(injected);
    const queuePath = join(dir, "legacy-pending-replies.json");
    writeFileSync(queuePath, JSON.stringify([{
      to: "legacy-recipient",
      text: rawValues.join(" "),
      taskId: "legacy-task",
      failed: false,
      queuedAt: 1,
      attempts: 0,
    }]));
    chmodSync(queuePath, 0o644);

    const queue = new PendingReplyQueue(queuePath, { knownValues: rawValues });
    const loaded = queue.load();
    const persisted = readFileSync(queuePath, "utf8");
    expect(JSON.stringify(loaded)).toContain(CREDENTIAL_REDACTION);
    for (const value of rawValues) expect(persisted).not.toContain(value);
    expect(statSync(queuePath).mode & 0o777).toBe(0o600);
  });

  test("legacy/corrupt goal state and runtime-switch archives are scrubbed and 0600", async () => {
    const injected = markers();
    const redactor = createCredentialRedactor({ knownValues: Object.values(injected) });
    const goalPath = join(dir, "preview-goals.json");
    const goal = newGoal({
      text: `audit PARTNER_SECRET=${injected.ARBITRARY_SECRET}`,
      interval_ms: 60_000,
      runtime: "grok-build-cli",
    });
    writeFileSync(goalPath, JSON.stringify({ version: 1, goals: [goal] }), { mode: 0o644 });
    chmodSync(goalPath, 0o644);
    const store = new GoalStore(goalPath, { redactor });
    expect((await store.load()).ok).toBe(true);
    expect(readFileSync(goalPath, "utf8")).not.toContain(injected.ARBITRARY_SECRET);
    expect(statSync(goalPath).mode & 0o777).toBe(0o600);
    const archive = await store.archiveAndClear("test");
    expect(archive).toBeDefined();
    expect(readFileSync(archive!, "utf8")).not.toContain(injected.ARBITRARY_SECRET);
    expect(statSync(archive!).mode & 0o777).toBe(0o600);

    const corruptPath = join(dir, "corrupt-goals.json");
    writeFileSync(corruptPath, `{bad PARTNER_TOKEN=${injected.ARBITRARY_TOKEN}`, { mode: 0o644 });
    const corrupt = new GoalStore(corruptPath, { redactor });
    const result = await corrupt.load();
    expect(result.ok).toBe(false);
    expect(result.recovered).toBeDefined();
    expect(readFileSync(result.recovered!, "utf8")).not.toContain(injected.ARBITRARY_TOKEN);
    expect(statSync(result.recovered!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(corruptPath, "utf8")).goals).toEqual([]);
    expect(statSync(corruptPath).mode & 0o777).toBe(0o600);
  });

  test("isolated Grok config and session stores are repaired to owner-only modes", () => {
    const root = join(dir, "grok-private-state");
    const sourceHome = join(root, "source-home");
    const stateRoot = join(root, "state-root");
    const stateHome = join(stateRoot, "node-preview");
    const project = join(root, "project");
    const sessionDir = join(stateHome, "sessions", "%2Fworkspace", "session-preview");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(join(project, ".anet"), { recursive: true });
    const sourceAuth = join(sourceHome, "auth.json");
    writeFileSync(sourceAuth, "{}\n", { mode: 0o600 });
    mkdirSync(join(sessionDir, "tool-logs"), { recursive: true, mode: 0o777 });
    writeFileSync(join(sessionDir, "chat_history.jsonl"), "synthetic task material\n", { mode: 0o666 });
    writeFileSync(join(sessionDir, "tool-logs", "result.log"), "synthetic reply material\n", { mode: 0o666 });
    chmodSync(join(stateHome, "sessions"), 0o777);
    chmodSync(join(stateHome, "sessions", "%2Fworkspace"), 0o777);
    chmodSync(sessionDir, 0o777);

    prepareGrokCliHome({
      sourceHome,
      stateRoot,
      stateHome,
      denyPaths: [join(project, ".anet")],
      projectCwd: project,
      useLeader: true,
    });

    for (const privateDir of [
      stateRoot,
      stateHome,
      join(stateHome, "sessions"),
      join(stateHome, "sessions", "%2Fworkspace"),
      sessionDir,
      join(sessionDir, "tool-logs"),
    ]) {
      expect(statSync(privateDir).mode & 0o777).toBe(0o700);
    }
    for (const privateFile of [
      join(stateHome, "config.toml"),
      join(stateHome, "sandbox.toml"),
      join(stateHome, "requirements.toml"),
      join(stateHome, "trusted_folders.toml"),
      join(stateHome, "anet-copresence-preview.md"),
      join(sessionDir, "chat_history.jsonl"),
      join(sessionDir, "tool-logs", "result.log"),
    ]) {
      expect(statSync(privateFile).mode & 0o777).toBe(0o600);
    }
    const trust = readFileSync(join(stateHome, "trusted_folders.toml"), "utf8");
    const parsed = Bun.TOML.parse(trust) as {
      folders: Record<string, { trusted: boolean; decided_at: number }>;
    };
    expect(Object.keys(parsed)).toEqual(["folders"]);
    expect(Object.keys(parsed.folders)).toEqual([project]);
    expect(parsed.folders[project]?.trusted).toBe(true);
    expect(Number.isSafeInteger(parsed.folders[project]?.decided_at)).toBe(true);

    // The pinned shared TUI lazily reads its owner-only auth after sandbox
    // re-exec. Keep that process path usable, while hard-denying every model
    // route that could read it or run a shell.
    expect(readFileSync(join(stateHome, "sandbox.toml"), "utf8")).not.toContain(sourceAuth);
    const args = buildGrokCopresenceArgs({
      cwd: project,
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      resume: false,
      leaderSocket: join(root, "leader.sock"),
      agentProfile: join(stateHome, "anet-copresence-preview.md"),
      sandboxProfile: "test224-workspace",
      protectedPaths: [sourceHome],
    });
    const denied = args.flatMap((value, index) => args[index - 1] === "--deny" ? [value] : []);
    expect(denied).toContain("Bash");
    expect(denied).toContain("Write");
    expect(denied).toContain("WebFetch");
    expect(args).toContain("--agent");
    expect(args).toContain(join(stateHome, "anet-copresence-preview.md"));
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--disallowed-tools");
    expect(readFileSync(join(stateHome, "anet-copresence-preview.md"), "utf8"))
      .toContain("tools:\n  - todo_write\n");
    expect(denied).toContain(`Read(${sourceHome})`);
    expect(denied).toContain(`Grep(${sourceHome})`);
    expect(denied).toContain(`Edit(${sourceHome})`);
  });

  test("agent-node wiring uses the shared redactor for logs and pending queue", () => {
    const source = readFileSync(join(ROOT, "agent-node/src/cli.ts"), "utf8");
    expect(source).toContain("const safeMsg = persistenceRedactor.redactText(msg).text;");
    expect(source).toMatch(/new PendingReplyQueue\(PENDING_REPLIES_PATH,\s*\{ redactor: persistenceRedactorHandle \}\)/);
    expect(source).toContain("const runtimeTask = redactedTask.text;");
    expect(source).toMatch(/const safeBody = GROK_EXECUTION_MODE === "cli"[\s\S]*?persistenceRedactor\.redactText\(body\)\.text/);
    expect(source).toContain("await sendReply(target, safeBody, taskId, failed);");
    expect(source).toMatch(/if \(GROK_EXECUTION_MODE === "cli"\) \{\s*replyText = persistenceRedactor\.redactText\(replyText\)\.text;/);
    expect(source).toMatch(/new GoalStore\(GOALS_PATH, GROK_EXECUTION_MODE === "cli"[\s\S]*?redactor: persistenceRedactorHandle/);
    expect(source).toContain("preparePrivateLogDirectory(LOG_DIR, persistenceRedactorHandle)");
    expect(source).toContain("appendPrivateLogLine(PRIVATE_LOG_DIR");
    expect(source).toContain("grok-build-cli preview currently refuses Feishu channels");
  });

  test("grok-build-cli dynamically refuses Feishu before any worker/runtime starts", async () => {
    const injected = markers();
    const channel = join(dir, "feishu-refused");
    mkdirSync(channel, { recursive: true, mode: 0o700 });
    writeFileSync(join(channel, ".env"), `FEISHU_APP_SECRET=${injected.ARBITRARY_SECRET}\n`, { mode: 0o600 });
    writeFileSync(join(channel, "access.json"), '{"allowFrom":[]}\n', { mode: 0o600 });
    const child = Bun.spawn([
      "bun",
      join(ROOT, "agent-node/src/cli.ts"),
      "--alias", "test224-feishu-refused",
      "--runtime", "grok-build-cli",
      "--channel", `feishu:${channel}`,
    ], {
      cwd: ROOT,
      env: { PATH: process.env.PATH!, HOME: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).not.toBe(0);
    expect(stdout + stderr).toContain("grok-build-cli preview currently refuses Feishu channels");
    expect(stdout + stderr).not.toContain(injected.ARBITRARY_SECRET);
  });
});
