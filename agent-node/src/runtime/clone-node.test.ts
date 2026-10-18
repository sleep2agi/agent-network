// Hub #938 — daemon clone: new token, session transcript copied for Claude,
// Codex/OpenCode honesty, rename collision on disk.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetAnetBinAbsForTest, serializeEnvLocalDaemon } from "./create-node-daemon.js";
import { recordChildWorkdir } from "./child-workdir.js";
import {
  buildClonedConfig,
  claudeTranscriptPath,
  copySessionTranscript,
  encodeCwd,
  handleCloneNodeDoorbell,
  planCloneWorkdir,
  planSessionCopy,
} from "./clone-node.js";

const SOURCE_TOKEN = "ntok_source_SHOULD_NOT_COPY";
const NEW_TOKEN = "ntok_clone_minted_new";
const SESSION = "11111111-2222-4333-8444-555555555555";

test("workdir: new empty sibling, unless the source lives in the daemon cwd", () => {
  const beside = planCloneWorkdir({
    policy: "new_empty", sourceWorkdir: "/srv/proj/src-child", daemonWorkdir: "/srv/daemon", newName: "cloned-child",
  });
  expect(beside.workdir).toBe("/srv/proj/cloned-child");
  expect(beside.workdirReason).toContain("same root");
  const forced = planCloneWorkdir({
    policy: "new_empty", sourceWorkdir: "/srv/daemon", daemonWorkdir: "/srv/daemon", newName: "cloned-child",
  });
  expect(forced.workdir).toBe("/srv/daemon/clone-work/cloned-child");
  expect(forced.workdirReason).toContain("clone-work");
  const shared = planCloneWorkdir({
    policy: "share_source", sourceWorkdir: "/srv/proj/src-child", daemonWorkdir: "/srv/daemon", newName: "cloned-child",
  });
  expect(shared.workdir).toBe("/srv/proj/src-child");
});

test("session copy is per runtime and does not pretend a missing transcript was forked", () => {
  expect(planSessionCopy({
    runtime: "claude-agent-sdk", copySession: true, sessionId: SESSION, transcriptFound: true, field: "session",
  }).capability).toBe("files_copied");
  const missing = planSessionCopy({
    runtime: "claude-code-cli", copySession: true, sessionId: SESSION, transcriptFound: false, field: "session",
  });
  expect(missing.capability).toBe("unsupported");
  expect(missing.sessionId).toBeUndefined();
  expect(missing.reason).toContain("empty session");
  const codex = planSessionCopy({
    runtime: "codex-app-server", copySession: true, sessionId: "thread_1", transcriptFound: false, field: "codexThreadId",
  });
  expect(codex.capability).toBe("unsupported");
  expect(codex.reason).toContain("codex fork");
  const oc = planSessionCopy({
    runtime: "opencode-cli", copySession: true, sessionId: "ses_abc", transcriptFound: false, field: "session",
  });
  expect(oc.capability).toBe("id_aliased");
  expect(oc.sessionId).toBe("ses_abc");
  expect(oc.reason).toContain("not a private fork");
  expect(planSessionCopy({
    runtime: "claude-agent-sdk", copySession: false, sessionId: SESSION, transcriptFound: true, field: "session",
  }).capability).toBe("skipped");
});

test("buildClonedConfig keeps the new token and only the session id the plan allows", () => {
  const source = {
    token: SOURCE_TOKEN,
    runtime: "claude-agent-sdk",
    model: "provider/model",
    flags: { permissionMode: "plan", apiKey: "sk-leak" },
    channels: ["server:commhub", "telegram:bot"],
    env: { PLAIN: "hello", ANTHROPIC_API_KEY: "sk-real" },
    session: SESSION,
    hub: "http://hub",
  };
  const copied = buildClonedConfig({
    source, name: "cloned-child", nodeId: "node_new", token: NEW_TOKEN, hubUrl: "http://hub",
    targetWorkdir: "/srv/proj/cloned-child",
    session: { capability: "files_copied", field: "session", sessionId: SESSION, reason: "copied" },
  });
  expect(copied.config.token).toBe(NEW_TOKEN);
  expect(JSON.stringify(copied.config)).not.toContain(SOURCE_TOKEN);
  expect(JSON.stringify(copied.config)).not.toContain("sk-leak");
  expect(JSON.stringify(copied.config)).not.toContain("sk-real");
  expect(copied.config.session).toBe(SESSION);
  expect(copied.config.model).toBe("provider/model");
  expect(copied.config.channels).toEqual(["server:commhub"]);
  expect(copied.skipped.join(" ")).toContain("ANTHROPIC_API_KEY");
  const bare = buildClonedConfig({
    source, name: "cloned-child", nodeId: "node_new", token: NEW_TOKEN, hubUrl: "http://hub",
    targetWorkdir: "/w",
    session: { capability: "unsupported", reason: "no transcript" },
  });
  expect(bare.config.session).toBeUndefined();
});

test("Claude transcript is copied into the new cwd key; Codex rollout is copied without auth.json", () => {
  const root = mkdtempSync(join(tmpdir(), "clone938-"));
  const home = join(root, "home");
  const srcWd = join(root, "srcproj");
  const dstWd = join(root, "cloned-child");
  const srcNode = join(srcWd, ".anet", "nodes", "src-child");
  const dstNode = join(dstWd, ".anet", "nodes", "cloned-child");
  mkdirSync(srcNode, { recursive: true });
  const transcript = claudeTranscriptPath(home, srcWd, SESSION);
  mkdirSync(join(transcript, ".."), { recursive: true });
  writeFileSync(transcript, "{\"hi\":1}\n");
  expect(copySessionTranscript({
    runtime: "claude-agent-sdk", sessionId: SESSION, sourceWorkdir: srcWd, targetWorkdir: dstWd,
    sourceNodeDir: srcNode, targetNodeDir: dstNode, home,
  })).toBe(true);
  expect(readFileSync(claudeTranscriptPath(home, dstWd, SESSION), "utf8")).toContain("hi");
  expect(encodeCwd(srcWd)).not.toBe(encodeCwd(dstWd));

  const thread = "thread_abc";
  const rollout = join(srcNode, "codex-home", "sessions", "2026", "10", "11", `rollout-1-${thread}.jsonl`);
  mkdirSync(join(rollout, ".."), { recursive: true });
  writeFileSync(rollout, "{\"type\":\"turn\"}\n");
  writeFileSync(join(srcNode, "codex-home", "auth.json"), "{\"tokens\":{\"refresh_token\":\"secret-login\"}}");
  expect(copySessionTranscript({
    runtime: "codex-sdk", sessionId: thread, sourceWorkdir: srcWd, targetWorkdir: dstWd,
    sourceNodeDir: srcNode, targetNodeDir: dstNode, home,
  })).toBe(true);
  const copiedRollout = join(dstNode, "codex-home", "sessions", "2026", "10", "11", `rollout-1-${thread}.jsonl`);
  expect(readFileSync(copiedRollout, "utf8")).toContain("turn");
  expect(existsSync(join(dstNode, "codex-home", "auth.json"))).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test("doorbell writes the clone with the new token and the copied Claude session", async () => {
  const root = mkdtempSync(join(tmpdir(), "clone938-door-"));
  const home = join(root, "home");
  const daemon = join(root, "daemon");
  const srcWd = join(root, "srcproj");
  const pin = join(root, "pin");
  mkdirSync(join(srcWd, ".anet", "nodes", "src-child"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(srcWd, ".anet", "nodes", "src-child", "config.json"), JSON.stringify({
    node_id: "node_src", alias: "src-child", node_name: "src-child", runtime: "claude-agent-sdk",
    model: "provider/model", token: SOURCE_TOKEN, session: SESSION, flags: { permissionMode: "plan" },
    channels: ["server:commhub"],
  }));
  const transcript = claudeTranscriptPath(home, srcWd, SESSION);
  mkdirSync(join(transcript, ".."), { recursive: true });
  writeFileSync(transcript, "{\"role\":\"user\"}\n");
  recordChildWorkdir(daemon, "src-child", srcWd);

  const pkg = join(pin, "pkg");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@sleep2agi/agent-network", bin: { anet: "bin/anet.cjs" } }));
  const anet = join(pkg, "bin", "anet.cjs");
  writeFileSync(anet, "#!/usr/bin/env node\n// anet 的 bin 入口垫片\n// PARSE_FLOOR\n");
  chmodSync(anet, 0o755);

  const saved = {
    HOME: process.env.HOME, ANET_BIN_ABS: process.env.ANET_BIN_ABS,
    ANET_DAEMON_ALLOW_ENV_BIN: process.env.ANET_DAEMON_ALLOW_ENV_BIN,
    ANET_BIN_SHA256: process.env.ANET_BIN_SHA256, ANET_DAEMON_PATH_CONF: process.env.ANET_DAEMON_PATH_CONF,
    ANET_DAEMON_STRICT_ROOT_BIN: process.env.ANET_DAEMON_STRICT_ROOT_BIN,
  };
  let sleepPid = 0;
  const acks: Record<string, unknown>[] = [];
  try {
    process.env.HOME = home;
    process.env.ANET_DAEMON_ALLOW_ENV_BIN = "1";
    process.env.ANET_BIN_ABS = anet;
    process.env.ANET_DAEMON_PATH_CONF = join(pin, "missing.conf");
    delete process.env.ANET_BIN_SHA256;
    delete process.env.ANET_DAEMON_STRICT_ROOT_BIN;
    _resetAnetBinAbsForTest();
    await handleCloneNodeDoorbell({ request_id: "cr_clone_door" }, {
      callCommHub: async (tool, args) => {
        if (tool === "get_create_request") {
          return {
            ok: true,
            node_spec: { name: "cloned-child", runtime: "claude-agent-sdk", model: "provider/model" },
            child_token: NEW_TOKEN,
            env_blob: {},
            clone: { source_node_id: "node_src", source_alias: "src-child", copy_session: true, workdir_policy: "new_empty", channels: ["server:commhub"] },
          };
        }
        if (tool === "ack_create_request") { acks.push(args); return { ok: true }; }
        throw new Error(`unexpected ${tool}`);
      },
      workDir: daemon,
      hubUrl: "http://127.0.0.1:9",
      log: () => {},
      warn: () => {},
      serializeEnvLocal: serializeEnvLocalDaemon,
      spawnChild: () => {
        const child = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
        sleepPid = child.pid ?? 0;
        return child;
      },
      capabilityCheckMs: 30,
    });
    expect(acks.map((a) => a.status)).toEqual(["started"]);
    const reg = JSON.parse(readFileSync(join(daemon, ".anet", "child-workdirs.json"), "utf8"));
    const wd = reg["cloned-child"] as string;
    expect(wd).toBe(join(root, "cloned-child"));
    const cfg = JSON.parse(readFileSync(join(wd, ".anet", "nodes", "cloned-child", "config.json"), "utf8"));
    expect(cfg.token).toBe(NEW_TOKEN);
    expect(cfg.alias).toBe("cloned-child");
    expect(cfg.node_id).toBe("node_clone_door");
    expect(cfg.session).toBe(SESSION);
    expect(cfg.runtime).toBe("claude-agent-sdk");
    expect(cfg.model).toBe("provider/model");
    expect(JSON.stringify(cfg)).not.toContain(SOURCE_TOKEN);
    expect(readFileSync(claudeTranscriptPath(home, wd, SESSION), "utf8")).toContain("user");
    expect(readFileSync(join(srcWd, ".anet", "nodes", "src-child", "config.json"), "utf8")).toContain(SOURCE_TOKEN);
  } finally {
    if (sleepPid > 0) { try { process.kill(sleepPid, "SIGKILL"); } catch { /* gone */ } }
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetAnetBinAbsForTest();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("doorbell refuses when the target directory already holds another alias", async () => {
  const root = mkdtempSync(join(tmpdir(), "clone938-collide-"));
  const home = join(root, "home");
  const daemon = join(root, "daemon");
  const srcWd = join(root, "srcproj");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(srcWd, ".anet", "nodes", "src-child"), { recursive: true });
  writeFileSync(join(srcWd, ".anet", "nodes", "src-child", "config.json"), JSON.stringify({
    alias: "src-child", node_name: "src-child", runtime: "claude-agent-sdk", token: SOURCE_TOKEN,
  }));
  recordChildWorkdir(daemon, "src-child", srcWd);
  const taken = join(root, "cloned-child", ".anet", "nodes", "cloned-child");
  mkdirSync(taken, { recursive: true });
  writeFileSync(join(taken, "config.json"), JSON.stringify({ alias: "someone-else", node_name: "someone-else" }));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const acks: Record<string, unknown>[] = [];
  try {
    await handleCloneNodeDoorbell({ request_id: "cr_collide" }, {
      callCommHub: async (tool, args) => {
        if (tool === "get_create_request") {
          return {
            ok: true, child_token: NEW_TOKEN,
            node_spec: { name: "cloned-child", runtime: "claude-agent-sdk" },
            clone: { source_alias: "src-child", copy_session: false, workdir_policy: "new_empty" },
          };
        }
        if (tool === "ack_create_request") { acks.push(args); return { ok: true }; }
        throw new Error(tool);
      },
      workDir: daemon, hubUrl: "http://127.0.0.1:9", log: () => {}, warn: () => {},
      serializeEnvLocal: serializeEnvLocalDaemon,
      spawnChild: () => { throw new Error("must not spawn"); },
      capabilityCheckMs: 0,
    });
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe("rejected");
    expect(String(acks[0].error)).toContain("node_name_conflict");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  }
});
