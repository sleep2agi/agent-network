import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import {
  cleanupOpencodeAuthLoginSandbox,
  buildOpencodeAuthLoginArgs,
  createOpencodeAuthLoginSandbox,
  OPENCODE_AUTH_LOGIN_CLEANUP_PREFIX,
  OPENCODE_AUTH_LOGIN_OWNER_FILE,
  readOpencodeAuthLoginCredential,
  revalidateOpencodeAuthLoginSandbox,
  withOpencodeAuthLoginSandbox,
} from "./opencode-auth-login";
import {
  findOpencodePreset,
  prepareOpencodeNodeForProfileWrite,
  writeOpencodeConfigJson,
} from "./opencode-preset";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function makeNode(
  name = "login-node",
  provider: "anthropic" | "openai" = "openai",
): { project: string; node: string; launchBase: string } {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined) {
    throw new Error("OpenCode auth-login isolation tests require Linux uid semantics");
  }
  const userRuntimeRoot = `/run/user/${uid}`;
  mkdirSync(userRuntimeRoot, { recursive: true, mode: 0o700 });
  const launchBase = mkdtempSync(join(userRuntimeRoot, "anet-opencode-auth-test-"));
  cleanup.push(launchBase);

  const project = mkdtempSync(join(tmpdir(), "opencode-auth-login-project-"));
  cleanup.push(project);
  const node = join(project, ".anet", "nodes", name);
  prepareOpencodeNodeForProfileWrite(node);
  writeOpencodeConfigJson(node, findOpencodePreset(provider)!);
  return { project, node, launchBase };
}

describe("OpenCode manual auth-login sandbox", () => {
  test("builds deterministic provider-specific API-key login argv", () => {
    expect(buildOpencodeAuthLoginArgs("openai")).toEqual([
      "auth", "login", "--provider", "openai", "--method", "Manually enter API Key",
    ]);
    expect(buildOpencodeAuthLoginArgs("anthropic")).toEqual([
      "auth", "login", "--provider", "anthropic",
    ]);
    expect(() => buildOpencodeAuthLoginArgs("custom")).toThrow(/Unsupported/);
  });

  test("uses a fresh all-XDG tree and strips ambient credentials/config hooks", () => {
    const { node, launchBase } = makeNode();
    const ambientSecret = "ambient-secret-must-not-cross";
    const sandbox = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
      parentEnv: {
        PATH: "/trusted/bin",
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
        NODE_TOKEN: ambientSecret,
        OPENAI_API_KEY: ambientSecret,
        ANTHROPIC_API_KEY: ambientSecret,
        GITHUB_TOKEN: ambientSecret,
        OPENCODE_CONFIG: "/tmp/hostile.json",
        OPENCODE_CONFIG_DIR: "/tmp/hostile-config",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: ["/tmp/hostile.mjs"] }),
        NODE_OPTIONS: "--require=/tmp/hook.cjs",
        BUN_OPTIONS: "--preload=/tmp/hook.ts",
        LD_PRELOAD: "/tmp/hook.so",
      },
    });
    try {
      const uid = process.getuid!();
      expect(sandbox.root.startsWith(`${launchBase}/opencode-auth-login-`)).toBe(true);
      expect(sandbox.root.startsWith(`/run/user/${uid}/`)).toBe(true);
      expect(sandbox.root.startsWith(join(node, ".runtime"))).toBe(false);
      expect(sandbox.cwd).toBe(join(sandbox.root, "workspace"));
      expect(sandbox.authPath.startsWith(`${sandbox.root}/`)).toBe(true);
      expect(sandbox.env.PWD).toBe(sandbox.cwd);
      expect(() => revalidateOpencodeAuthLoginSandbox(sandbox)).not.toThrow();
      expect(sandbox.env.PATH).toBe("/trusted/bin");
      expect(sandbox.env.TERM).toBe("xterm-256color");
      expect(sandbox.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
      for (const key of [
        "NODE_TOKEN",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GITHUB_TOKEN",
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_CONFIG_CONTENT",
        "NODE_OPTIONS",
        "BUN_OPTIONS",
        "LD_PRELOAD",
      ]) {
        expect(sandbox.env[key], key).toBeUndefined();
      }
      expect(JSON.stringify(sandbox)).not.toContain(ambientSecret);

      const privateRoots = [
        sandbox.root,
        sandbox.env.HOME!,
        sandbox.env.XDG_CONFIG_HOME!,
        sandbox.env.XDG_DATA_HOME!,
        sandbox.env.XDG_CACHE_HOME!,
        sandbox.env.XDG_STATE_HOME!,
        sandbox.env.XDG_RUNTIME_DIR!,
        sandbox.env.TMPDIR!,
        sandbox.cwd,
        join(sandbox.env.XDG_CONFIG_HOME!, "opencode"),
        join(sandbox.env.XDG_DATA_HOME!, "opencode"),
      ];
      expect(new Set(privateRoots).size).toBe(privateRoots.length);
      for (const path of privateRoots) {
        expect(path.startsWith(sandbox.root), path).toBe(true);
        expect(statSync(path).mode & 0o777, path).toBe(0o700);
      }
      expect(sandbox.env.XDG_DATA_HOME).not.toBe(join(node, ".local", "share"));
      expect(sandbox.env.XDG_CACHE_HOME).not.toBe(join(node, ".cache"));
      expect(sandbox.env.XDG_STATE_HOME).not.toBe(join(node, ".local", "state"));
      expect(sandbox.env.XDG_RUNTIME_DIR).not.toBe(join(node, ".runtime"));

      const markerPath = join(sandbox.root, OPENCODE_AUTH_LOGIN_OWNER_FILE);
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      const nodeIdentity = statSync(node);
      expect(Object.keys(marker).sort()).toEqual([
        "createdAt",
        "nodeWorkDir",
        "nodeWorkDirDev",
        "nodeWorkDirIno",
        "pid",
        "processStartTicks",
        "root",
        "token",
        "uid",
        "version",
      ]);
      expect(marker).toMatchObject({
        version: 3,
        pid: process.pid,
        uid,
        root: basename(sandbox.root),
        nodeWorkDir: node,
        nodeWorkDirDev: String(nodeIdentity.dev),
        nodeWorkDirIno: String(nodeIdentity.ino),
      });
      expect(marker.processStartTicks).toMatch(/^\d+$/);
      expect(marker.token).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isFinite(Date.parse(marker.createdAt))).toBe(true);
      expect(statSync(markerPath).mode & 0o777).toBe(0o600);
    } finally {
      const root = sandbox.root;
      cleanupOpencodeAuthLoginSandbox(sandbox);
      expect(existsSync(root)).toBe(false);
    }
  });

  test("strictly consumes only the selected provider API record through a private leaf", () => {
    const { node, launchBase } = makeNode("anthropic-node", "anthropic");
    const sandbox = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "anthropic",
      launchBase,
    });
    try {
      writeFileSync(sandbox.authPath, JSON.stringify({
        anthropic: { type: "api", key: "sk-ant-test-value" },
      }), { mode: 0o644 });
      expect(readOpencodeAuthLoginCredential(sandbox)).toEqual({
        provider: "anthropic",
        type: "api",
        key: "sk-ant-test-value",
      });
      expect(statSync(sandbox.authPath).mode & 0o777).toBe(0o600);
    } finally {
      cleanupOpencodeAuthLoginSandbox(sandbox);
    }
  });

  test("refuses OAuth, mixed-provider and symlink auth shapes without disclosing secrets", () => {
    const { node, launchBase } = makeNode();
    const sandbox = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    });
    const oauthSecret = "oauth-refresh-secret-must-not-appear";
    try {
      writeFileSync(sandbox.authPath, JSON.stringify({
        openai: { type: "oauth", access: "oauth-access-secret", refresh: oauthSecret },
      }), { mode: 0o600 });
      let message = "";
      try {
        readOpencodeAuthLoginCredential(sandbox);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("API-key credential");
      expect(message).not.toContain(oauthSecret);
      expect(message).not.toContain("oauth-access-secret");

      writeFileSync(sandbox.authPath, JSON.stringify({
        openai: { type: "api", key: "selected-secret" },
        anthropic: { type: "api", key: "other-secret" },
      }), { mode: 0o600 });
      expect(() => readOpencodeAuthLoginCredential(sandbox)).toThrow(/only the selected provider/);

      rmSync(sandbox.authPath);
      const outside = mkdtempSync(join(tmpdir(), "opencode-auth-login-auth-outside-"));
      cleanup.push(outside);
      const outsideAuth = join(outside, "auth.json");
      writeFileSync(outsideAuth, JSON.stringify({
        openai: { type: "api", key: "outside-secret" },
      }), { mode: 0o600 });
      symlinkSync(outsideAuth, sandbox.authPath);
      expect(() => readOpencodeAuthLoginCredential(sandbox)).toThrow(/single-link regular file|symlinks/);
      expect(readFileSync(outsideAuth, "utf8")).toContain("outside-secret");
    } finally {
      cleanupOpencodeAuthLoginSandbox(sandbox);
    }
  });

  test("persistent planted DB/log links are never exposed and cleanup never follows descendant links", () => {
    const { node, launchBase } = makeNode();
    prepareOpencodeNodeForProfileWrite(node);
    const outside = mkdtempSync(join(tmpdir(), "opencode-auth-login-outside-"));
    cleanup.push(outside);
    const dbTarget = join(outside, "db-target");
    const logTarget = join(outside, "log-target");
    writeFileSync(dbTarget, "db-sentinel", { mode: 0o600 });
    mkdirSync(logTarget, { mode: 0o700 });

    const persistentData = join(node, ".local", "share", "opencode");
    symlinkSync(dbTarget, join(persistentData, "opencode.db"));
    symlinkSync(logTarget, join(persistentData, "log"));

    const sandbox = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    });
    const freshData = join(sandbox.env.XDG_DATA_HOME!, "opencode");
    expect(freshData).not.toBe(persistentData);
    expect(existsSync(join(freshData, "opencode.db"))).toBe(false);
    expect(existsSync(join(freshData, "log"))).toBe(false);

    // Model a malicious/buggy child replacing fresh descendants before the
    // parent cleans up. Cleanup must unlink these names, never traverse them.
    symlinkSync(dbTarget, join(freshData, "opencode.db"));
    symlinkSync(logTarget, join(freshData, "log"));
    const root = sandbox.root;
    cleanupOpencodeAuthLoginSandbox(sandbox);
    expect(existsSync(root)).toBe(false);
    expect(readFileSync(dbTarget, "utf8")).toBe("db-sentinel");
    expect(statSync(logTarget).isDirectory()).toBe(true);
    expect(existsSync(join(logTarget, "unexpected-write"))).toBe(false);
  });

  test("cleanup unlinks a swapped root symlink but never removes its outside target", () => {
    const { node, launchBase } = makeNode();
    const outside = mkdtempSync(join(tmpdir(), "opencode-auth-login-root-outside-"));
    cleanup.push(outside);
    writeFileSync(join(outside, "sentinel"), "outside-safe", { mode: 0o600 });
    const sandbox = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    });
    const moved = `${sandbox.root}-moved`;
    renameSync(sandbox.root, moved);
    symlinkSync(outside, sandbox.root);

    cleanupOpencodeAuthLoginSandbox(sandbox);
    expect(existsSync(sandbox.root)).toBe(false);
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside-safe");
    expect(existsSync(moved)).toBe(false);
  });

  test("cleanup quarantines the tracked inode but leaves a regular root-name replacement untouched", () => {
    const { node, launchBase } = makeNode();
    const sandbox = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    });
    const moved = `${sandbox.root}-moved`;
    renameSync(sandbox.root, moved);
    mkdirSync(sandbox.root, { mode: 0o700 });
    const replacementSentinel = join(sandbox.root, "replacement-sentinel");
    writeFileSync(replacementSentinel, "replacement-must-stay", { mode: 0o600 });

    cleanupOpencodeAuthLoginSandbox(sandbox);
    expect(existsSync(moved)).toBe(false);
    expect(readFileSync(replacementSentinel, "utf8")).toBe("replacement-must-stay");
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  test("a live tracked root whose literal name ends in deleted is still removed", () => {
    const { node, launchBase } = makeNode();
    const sandbox = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    });
    const literalDeletedSuffix = `${sandbox.root}-literal (deleted)`;
    renameSync(sandbox.root, literalDeletedSuffix);

    cleanupOpencodeAuthLoginSandbox(sandbox);
    expect(existsSync(literalDeletedSuffix)).toBe(false);
  });

  test("Linux reports nlink zero for a removed directory retained by fd", () => {
    const { launchBase } = makeNode();
    const directory = join(launchBase, "nlink-probe");
    mkdirSync(directory, { mode: 0o700 });
    const fd = openSync(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    try {
      expect(fstatSync(fd).nlink).toBeGreaterThan(0);
      rmdirSync(directory);
      expect(fstatSync(fd).nlink).toBe(0);
    } finally {
      closeSync(fd);
    }
  });

  test("cleanup retains inode ownership after bounded failure and succeeds on retry", () => {
    const { node, launchBase } = makeNode();
    const sandbox = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    });
    const root = sandbox.root;
    chmodSync(launchBase, 0o755);
    try {
      expect(() => cleanupOpencodeAuthLoginSandbox(sandbox)).toThrow(/mode must be 0700/);
      expect(existsSync(root)).toBe(true);
    } finally {
      chmodSync(launchBase, 0o700);
    }

    // If the first failure had discarded the WeakMap/fd ownership, this would
    // be a no-op and the credential-bearing root would remain.
    cleanupOpencodeAuthLoginSandbox(sandbox);
    expect(existsSync(root)).toBe(false);
  });

  test("refuses a concurrent live owner marker", () => {
    const { node, launchBase } = makeNode();
    const first = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    });
    try {
      expect(() => createOpencodeAuthLoginSandbox({
        nodeWorkDir: node,
        provider: "openai",
        launchBase,
      })).toThrow(/already active.*pid/);
      expect(existsSync(first.root)).toBe(true);
    } finally {
      cleanupOpencodeAuthLoginSandbox(first);
    }
  });

  test("refuses a provider that does not match the node's unique configured preset", () => {
    const { node, launchBase } = makeNode("provider-mismatch", "anthropic");
    expect(() => createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    })).toThrow(/does not match.*configured provider preset/);
    expect(existsSync(join(node, ".runtime"))).toBe(true);
    expect(
      readFileSync(join(node, ".config", "opencode", "opencode.json"), "utf8"),
    ).toContain('"anthropic"');
  });

  test("prunes a dead owner's stale root without following its planted links", async () => {
    const { node, launchBase } = makeNode();
    const stale = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    });
    const outside = mkdtempSync(join(tmpdir(), "opencode-auth-login-stale-outside-"));
    cleanup.push(outside);
    writeFileSync(join(outside, "sentinel"), "stale-outside-safe", { mode: 0o600 });
    symlinkSync(outside, join(stale.env.XDG_DATA_HOME!, "opencode", "log"));

    const exited = Bun.spawn(["sh", "-c", "exit 0"]);
    await exited.exited;
    const markerPath = join(stale.root, OPENCODE_AUTH_LOGIN_OWNER_FILE);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    marker.pid = exited.pid;
    writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });

    const replacement = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    });
    try {
      expect(existsSync(stale.root)).toBe(false);
      expect(existsSync(replacement.root)).toBe(true);
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("stale-outside-safe");
    } finally {
      cleanupOpencodeAuthLoginSandbox(replacement);
      cleanupOpencodeAuthLoginSandbox(stale);
    }
  });

  test("PID reuse does not retain a stale credential root", async () => {
    const { node, launchBase } = makeNode();
    const stale = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    });
    const liveUnrelated = Bun.spawn(["sh", "-c", "sleep 30"]);
    const markerPath = join(stale.root, OPENCODE_AUTH_LOGIN_OWNER_FILE);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    marker.pid = liveUnrelated.pid;
    // Model a PID reused by a different process: PID is live, start ticks are
    // from the dead owner and therefore do not match the current /proc record.
    marker.processStartTicks = "1";
    writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });

    let replacement: ReturnType<typeof createOpencodeAuthLoginSandbox> | undefined;
    try {
      replacement = createOpencodeAuthLoginSandbox({
        nodeWorkDir: node,
        provider: "openai",
        launchBase,
      });
      expect(existsSync(stale.root)).toBe(false);
      expect(existsSync(replacement.root)).toBe(true);
    } finally {
      liveUnrelated.kill();
      await liveUnrelated.exited;
      if (replacement) cleanupOpencodeAuthLoginSandbox(replacement);
      cleanupOpencodeAuthLoginSandbox(stale);
    }
  });

  test("stale sweep resumes a crash-left quarantine while its owner marker remains", async () => {
    const { node, launchBase } = makeNode();
    const stale = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    });
    const quarantine = join(
      launchBase,
      `${OPENCODE_AUTH_LOGIN_CLEANUP_PREFIX}${"a".repeat(40)}`,
    );
    renameSync(stale.root, quarantine);
    writeFileSync(join(quarantine, "crash-payload"), "sensitive", { mode: 0o600 });
    const exited = Bun.spawn(["sh", "-c", "exit 0"]);
    await exited.exited;
    const markerPath = join(quarantine, OPENCODE_AUTH_LOGIN_OWNER_FILE);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    marker.pid = exited.pid;
    writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });

    let replacement: ReturnType<typeof createOpencodeAuthLoginSandbox> | undefined;
    try {
      replacement = createOpencodeAuthLoginSandbox({
        nodeWorkDir: node,
        provider: "openai",
        launchBase,
      });
      expect(existsSync(quarantine)).toBe(false);
    } finally {
      if (replacement) cleanupOpencodeAuthLoginSandbox(replacement);
      cleanupOpencodeAuthLoginSandbox(stale);
    }
  });

  test("stale sweep removes an empty quarantine left after marker-last deletion", () => {
    const { node, launchBase } = makeNode();
    const quarantine = join(
      launchBase,
      `${OPENCODE_AUTH_LOGIN_CLEANUP_PREFIX}${"b".repeat(40)}`,
    );
    mkdirSync(quarantine, { mode: 0o700 });
    const sandbox = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    });
    try {
      expect(existsSync(quarantine)).toBe(false);
    } finally {
      cleanupOpencodeAuthLoginSandbox(sandbox);
    }
  });

  test("spawn-time revalidation rejects a hostile ancestor discovery candidate", () => {
    const { node, launchBase } = makeNode();
    const sandbox = createOpencodeAuthLoginSandbox({
      nodeWorkDir: node,
      provider: "openai",
      launchBase,
    });
    const hostileCandidate = join(launchBase, ".opencode");
    try {
      mkdirSync(hostileCandidate, { mode: 0o700 });
      expect(() => revalidateOpencodeAuthLoginSandbox(sandbox)).toThrow(
        /ancestor discovery candidate/,
      );
      expect(existsSync(sandbox.root)).toBe(true);
    } finally {
      rmSync(hostileCandidate, { recursive: true, force: true });
      cleanupOpencodeAuthLoginSandbox(sandbox);
      expect(existsSync(sandbox.root)).toBe(false);
    }
  });

  test("with helper always cleans the fresh root when the action throws", async () => {
    const { node, launchBase } = makeNode();
    let root = "";
    await expect(withOpencodeAuthLoginSandbox(
      { nodeWorkDir: node, provider: "openai", launchBase },
      (sandbox) => {
        root = sandbox.root;
        throw new Error("synthetic child failure");
      },
    )).rejects.toThrow("synthetic child failure");
    expect(root).not.toBe("");
    expect(existsSync(root)).toBe(false);
  });
});
