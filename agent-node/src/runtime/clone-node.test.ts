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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetAnetBinAbsForTest, serializeEnvLocalDaemon } from "./create-node-daemon.js";
import { recordChildWorkdir } from "./child-workdir.js";
import {
  buildClonedConfig,
  claudeTranscriptPath,
  cloneHubUrl,
  copySessionTranscript,
  encodeCwd,
  handleCloneNodeDoorbell,
  planCloneWorkdir,
  planSessionCopy,
  seedCloneInstructions,
  sourceWorkdirFor,
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

test("workdir: with a disk probe the clone takes the next free `<source folder>-N`", () => {
  const used = new Set(["/srv/ws/client-oe-2", "/srv/ws/client-oe-3"]);
  const plan = (sourceWorkdir: string) => planCloneWorkdir({
    policy: "new_empty", sourceWorkdir, daemonWorkdir: "/srv/daemon", newName: "客户端欧7号", taken: (p) => used.has(p),
  }).workdir;
  expect(plan("/srv/ws/client-oe")).toBe("/srv/ws/client-oe-4");
  // A source that is itself `-N` counts from its stem, not `-2-2`.
  expect(plan("/srv/ws/client-oe-2")).toBe("/srv/ws/client-oe-4");
  expect(plan("/srv/ws/docs")).toBe("/srv/ws/docs-2");
});

test("seedCloneInstructions copies only AGENTS.md / CLAUDE.md, never symlinks or existing files", () => {
  const root = mkdtempSync(join(tmpdir(), "clone-seed-"));
  try {
    const src = join(root, "src"), dst = join(root, "dst");
    mkdirSync(src); mkdirSync(dst);
    writeFileSync(join(src, "AGENTS.md"), "agents");
    writeFileSync(join(root, "secret.txt"), "secret");
    symlinkSync(join(root, "secret.txt"), join(src, "CLAUDE.md"));
    writeFileSync(join(src, "opencode.json"), "{}");
    expect(seedCloneInstructions(src, dst)).toEqual(["AGENTS.md"]);
    expect(existsSync(join(dst, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(dst, "opencode.json"))).toBe(false);
    writeFileSync(join(src, "AGENTS.md"), "changed");
    expect(seedCloneInstructions(src, dst)).toEqual([]);
    expect(readFileSync(join(dst, "AGENTS.md"), "utf8")).toBe("agents");
    expect(seedCloneInstructions(src, src)).toEqual([]);
    // Heading equal to the source name is renamed; anything else stays verbatim.
    const dst2 = join(root, "dst2"); mkdirSync(dst2);
    writeFileSync(join(src, "AGENTS.md"), "# 源节点\n\n你的工作提 PR 到 # 源节点 的仓库\n");
    expect(seedCloneInstructions(src, dst2, { from: "源节点", to: "新节点" })).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(dst2, "AGENTS.md"), "utf8")).toBe("# 新节点\n\n你的工作提 PR 到 # 源节点 的仓库\n");
    const dst3 = join(root, "dst3"); mkdirSync(dst3);
    writeFileSync(join(src, "AGENTS.md"), "# 别的标题\n");
    seedCloneInstructions(src, dst3, { from: "源节点", to: "新节点" });
    expect(readFileSync(join(dst3, "AGENTS.md"), "utf8")).toBe("# 别的标题\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sourceWorkdirFor finds an adopted child's workdir (object registry entry)", () => {
  const root = mkdtempSync(join(tmpdir(), "clone-adopted-"));
  try {
    const daemon = join(root, "daemon");
    mkdirSync(join(daemon, ".anet"), { recursive: true, mode: 0o700 });
    writeFileSync(join(daemon, ".anet", "child-workdirs.json"), JSON.stringify({
      "adopted-one": { adopted: true, node_id: "n_1", workdir: "/srv/ws/client-oe", nodeDir: "/srv/ws/client-oe/.anet/nodes/adopted-one",
        request_id: "adopt_1", launch_mode: "tmux" },
      "made-one": join(root, "made"),
    }), { mode: 0o600 });
    mkdirSync(join(root, "made"));
    expect(sourceWorkdirFor(daemon, "adopted-one")).toBe("/srv/ws/client-oe");
    expect(sourceWorkdirFor(daemon, "made-one")).toBe(join(root, "made"));
    expect(sourceWorkdirFor(daemon, "unknown")).toBe(daemon);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  const ocNew = planSessionCopy({
    runtime: "opencode-cli", copySession: true, sessionId: "ses_abc", transcriptFound: false, field: "session", policy: "new_empty",
  });
  expect(ocNew.capability).toBe("unsupported");
  expect(ocNew.sessionId).toBeUndefined();
  expect(ocNew.reason).toContain("fresh session");
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
  writeFileSync(join(srcWd, "AGENTS.md"), "# src-child\n你的工作提 PR\n");
  writeFileSync(join(srcWd, "opencode.json"), JSON.stringify({ mcp: { headers: { Authorization: `Bearer ${SOURCE_TOKEN}` } } }));
  writeFileSync(join(srcWd, "ANET-COMMHUB.md"), "You are Agent Network node src-child.\n");

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
    // admin 2026-11-10: new folder = `<source folder>-N` beside the source.
    expect(wd).toBe(join(root, "srcproj-2"));
    expect(readFileSync(join(wd, "AGENTS.md"), "utf8")).toContain("你的工作提 PR");
    // Per-node generated files carry the source identity/token: never seeded.
    expect(existsSync(join(wd, "opencode.json"))).toBe(false);
    expect(existsSync(join(wd, "ANET-COMMHUB.md"))).toBe(false);
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
  const taken = join(srcWd, ".anet", "nodes", "cloned-child");
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
            clone: { source_alias: "src-child", copy_session: false, workdir_policy: "share_source" },
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

test("OpenCode shared-serve clone keeps the shared serve and the source's proven Hub URL (vdev 2026-11-11)", () => {
  const source = {
    runtime: "opencode-cli", opencodeGeneration: "v2", opencodeMode: "copresence", token: SOURCE_TOKEN,
    hub: "http://hub.example:9300", network_id: "net_1",
    opencodeSharedServerUrl: "http://127.0.0.1:4097", opencodeSharedServerPasswordFile: "/srv/shared/server-password",
  };
  const daemonHub = "https://hub.example";
  expect(cloneHubUrl(source, daemonHub, "http://hub.example:9300")).toBe("http://hub.example:9300");
  expect(cloneHubUrl(source, daemonHub, null)).toBe(daemonHub);
  expect(cloneHubUrl(source, daemonHub, "http://other:9300")).toBe(daemonHub);
  expect(cloneHubUrl({ ...source, hub: daemonHub }, daemonHub, null)).toBe(daemonHub);
  // No shared serve: always the daemon's Hub.
  expect(cloneHubUrl({ runtime: "claude-code-cli", hub: "http://hub.example:9300" }, daemonHub, "http://hub.example:9300")).toBe(daemonHub);
  const { config } = buildClonedConfig({
    source, name: "c", nodeId: "node_c", token: NEW_TOKEN, hubUrl: cloneHubUrl(source, daemonHub, "http://hub.example:9300"),
    session: { capability: "unsupported", reason: "fresh" }, targetWorkdir: "/srv/ws/c",
  });
  expect(config.opencodeSharedServerUrl).toBe("http://127.0.0.1:4097");
  expect(config.opencodeSharedServerPasswordFile).toBe("/srv/shared/server-password");
  expect(config.hub).toBe("http://hub.example:9300");
  expect(config.network_id).toBe("net_1");
  expect(config.token).toBe(NEW_TOKEN);
  expect(JSON.stringify(config)).not.toContain(SOURCE_TOKEN);
});
