// test-codex-copresence-first-start — #535 (codex CLI audit P1-1, P1-2, P1-3, P2-9), real chain:
// throwaway Hub + real `anet node start` (co-presence, tmux on a PRIVATE socket via TMUX_TMPDIR)
// + built agent-node + fake codex (tests/test751-codex-copresence-windows/fake-codex.mjs).
//
// The paired agent-node is served by a FAKE `npx` that sleeps T535_NPX_DELAY_S before printing
// the exact entrypoint — the audit measured ~32 s for the first real fetch, longer than the 25 s
// bridge wait. Every npx call is logged, so the suite can count who resolved agent-node.
//
// SCENARIO:
//   slow-fetch   logged in (fake api-key auth.json); start must reach "✅ 就绪" although the fetch
//                takes longer than the bridge wait; exactly one npx call; then a SINGLE node with no
//                --probe-from must PASS `anet node codex verify` (identity_attested = n/a).
//   bridge-dies  logged in; the agent-node entrypoint exits with a known line once it is really
//                launched (not for --help). The failure must print that line from the bridge log,
//                the log path, and no `tmux attach` to a session that is gone.
//   logged-out   no auth.json; start must report needs-login with the exact login command, exit 3,
//                and start nothing (no tmux session, no npx call).
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.umask(0o022);
const repo = "/workspace";
const pairedVersion = JSON.parse(readFileSync(join(repo, "agent-node", "package.json"), "utf8")).version;
const scenario = process.env.T535_SCENARIO || "slow-fetch";
const runId = process.env.T535_RUN_ID || scenario;
const port = Number(process.env.T535_HUB_PORT);
if (!port || port === 9200) throw new Error("need a throwaway hub port (never 9200)");
const delayS = Number(process.env.T535_NPX_DELAY_S ?? "0");
const alias = `fs-${runId}`.replace(/[^A-Za-z0-9-]/g, "-");
const root = `/tmp/t535-${runId}`;
const project = join(root, "project");
const userHome = join(root, "home");
const bin = join(root, "bin");
const tmuxDir = join(root, "tmux");
const rpcLog = join(root, "rpc.log");
const npxLog = join(root, "npx.log");
const hub = `http://127.0.0.1:${port}`;
for (const d of [project, join(userHome, ".anet"), bin]) mkdirSync(d, { recursive: true });
mkdirSync(tmuxDir, { recursive: true, mode: 0o700 });
chmodSync(tmuxDir, 0o700);
writeFileSync(join(userHome, ".anet", "config.json"), JSON.stringify({ hub }, null, 2));

// ── the paired agent-node, in an exact package layout the identity check accepts ──────────────
const exactRoot = join("/opt", `t535-${runId}`, "node_modules", "@sleep2agi", "agent-node");
const exactEntry = join(exactRoot, "dist", "cli.js");
mkdirSync(join(exactRoot, "dist"), { recursive: true });
writeFileSync(join(exactRoot, "package.json"), JSON.stringify({
  name: "@sleep2agi/agent-node", version: pairedVersion, publishConfig: { tag: "preview" }, bin: { "agent-node": "dist/cli.js" },
}));
const realAgentNode = JSON.stringify(pathToFileURL(join(repo, "agent-node/dist/cli.js")).href);
writeFileSync(exactEntry, scenario === "bridge-dies"
  ? `if (process.argv.includes("--help")) { await import(${realAgentNode}); }
else { console.error("T535-BRIDGE-BOOM: simulated agent-node failure at launch"); process.exit(1); }\n`
  : `await import(${realAgentNode});\n`);
execFileSync("chmod", ["-R", "go-w", join("/opt", `t535-${runId}`)]);
chmodSync(exactEntry, 0o755);

// ── fake npx: slow, counted, and only answers the one question anet asks it ───────────────────
writeFileSync(join(bin, "npx"), `#!/bin/bash
echo "npx $*" >> ${JSON.stringify(npxLog)}
case " $* " in
  *" --print-entrypoint "*) sleep ${delayS}; echo ${JSON.stringify(exactEntry)}; exit 0 ;;
esac
echo "fake npx: unexpected call: $*" >&2
exit 1
`);
chmodSync(join(bin, "npx"), 0o755);

// ── fake codex: app-server + TUI from test751 ──────────────────────────────────────────────────
const codexWrapper = join(bin, "t535-codex");
writeFileSync(codexWrapper, `#!/bin/bash
if [ "$1" = "app-server" ]; then
  exec bun ${JSON.stringify(join(repo, "tests/test751-codex-copresence-windows/fake-codex.mjs"))} "$@" >>"$ANET_TEST751_RPC_LOG" 2>&1
fi
bun ${JSON.stringify(join(repo, "tests/test751-codex-copresence-windows/fake-codex.mjs"))} "$@" 2>&1 | tee -a "$ANET_TEST751_RPC_LOG"
exec tail -f /dev/null
`);
chmodSync(codexWrapper, 0o755);

const env = {
  ...process.env,
  HOME: userHome,
  LANG: "C.utf8",
  LC_ALL: "C.utf8",
  PATH: `${bin}:${process.env.PATH}`,
  // 🔴 private tmux server: anet passes -S under it, plain tmux calls default to it too.
  TMUX_TMPDIR: tmuxDir,
  ANET_TEST751_RPC_LOG: rpcLog,
};
delete env.ANET_AGENT_NODE_BIN; // the point is the npx path
delete env.OPENAI_API_KEY; // an env key makes the login gate "unknown"; these scenarios decide by auth.json
delete env.CODEX_API_KEY;
delete env.TMUX;
delete env.TMUX_PANE;
const cli = join(repo, "agent-network/bin/cli.ts");
const run = (args, timeoutMs = 150_000) => {
  const r = spawnSync("bun", [cli, ...args], { cwd: project, env, encoding: "utf8", timeout: timeoutMs });
  return { rc: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
// -L default under the private TMUX_TMPDIR = exactly the socket anet uses here, named explicitly.
const tmux = (args) => spawnSync("tmux", ["-u", "-L", "default", ...args], { env, encoding: "utf8" });
const sessions = () => (tmux(["list-sessions", "-F", "#{session_name}"]).stdout ?? "").split("\n").filter(Boolean);
const panePid = (name) => {
  const rows = (tmux(["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"]).stdout ?? "").split("\n");
  const row = rows.map((line) => line.split("\t")).find(([session]) => session === name);
  return row?.[1] ? Number(row[1]) : null;
};
const procHasEnv = (pid, key, value) => pid !== null
  && readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0").includes(`${key}=${value}`);
const npxCalls = () => (existsSync(npxLog) ? readFileSync(npxLog, "utf8").split("\n").filter(Boolean) : []);
const fail = (msg, out = "") => {
  console.log(`FAIL ${msg}`);
  if (out) console.log(`--- output ---\n${out.slice(-6000)}`);
  console.log(`--- tmux sessions ---\n${sessions().join("\n") || "(none)"}`);
  console.log(`--- npx calls ---\n${npxCalls().join("\n") || "(none)"}`);
  process.exitCode = 1;
  throw new Error(msg);
};
const pass = (msg) => console.log(`PASS ${msg}`);

const must = (r, what) => { if (r.rc !== 0) fail(`${what} rc=${r.rc}`, r.out); return r; };
must(run(["register", "--username", `t535${runId.replace(/[^a-z0-9]/gi, "")}`, "--password", "pass123456"]), "register");
must(run(["login", "--username", `t535${runId.replace(/[^a-z0-9]/gi, "")}`, "--password", "pass123456"]), "login");
must(run(["node", "create", alias, "--runtime", "codex-cli", "--hub", hub]), "node create");
const nodeDir = join(project, ".anet", "nodes", alias);
const codexHome = join(nodeDir, "codex-home");
const configEnvKey = "ANET_T535_PROVIDER_KEY";
const configEnvValue = `fake-provider-${runId}`;
{
  const cfgPath = join(nodeDir, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.env = { ...(cfg.env ?? {}), [configEnvKey]: configEnvValue };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
if (scenario !== "logged-out") {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  // Fake, clearly-not-real credential: the gate only asks "is there a usable login shape".
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: `sk-fake-t535-${runId}` }) + "\n", { mode: 0o600 });
}
if (scenario === "backup-fails") {
  const sessionsDir = join(codexHome, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const outside = join(root, "must-not-copy.jsonl");
  writeFileSync(outside, "outside recovery scope\n");
  symlinkSync(outside, join(sessionsDir, "escape.jsonl"));
}

let started = false;
try {
  const t0 = Date.now();
  const start = run(["node", "start", alias, "--codex-bin", codexWrapper, "--accept-dev-channels"]);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  started = true;
  console.log(`start rc=${start.rc} in ${secs}s`);

  if (scenario === "slow-fetch") {
    if (start.rc !== 0 || !start.out.includes("✅ 共存节点")) fail(`first start with a ${delayS}s agent-node fetch did not reach ready (rc=${start.rc})`, start.out);
    if (!/⓪ agent-node: resolving @sleep2agi\/agent-node@/.test(start.out)) fail("no progress line before the agent-node fetch", start.out);
    if (!/⓪ agent-node READY \(paired, \d+\.\d+s\)/.test(start.out)) fail("no READY line after the agent-node fetch", start.out);
    const iPre = start.out.indexOf("⓪ agent-node READY");
    const iApp = start.out.indexOf("app-server tmux=");
    if (iPre < 0 || iApp < 0 || iPre > iApp) fail("agent-node was not resolved before the first tmux session", start.out);
    const calls = npxCalls().filter((l) => l.includes("--print-entrypoint"));
    if (calls.length !== 1) fail(`expected exactly one agent-node resolution (by the launcher), saw ${calls.length}`, start.out);
    pass(`first start with a ${delayS}s agent-node fetch reached ready in ${secs}s; one npx call, before any tmux session`);
    for (const [role, session] of [["app-server", `${alias}-appsrv`], ["bridge", `${alias}-桥`], ["TUI", alias]]) {
      const pid = panePid(session);
      if (!procHasEnv(pid, configEnvKey, configEnvValue)) {
        fail(`${role} pane pid=${pid ?? "missing"} did not inherit config.env.${configEnvKey}`, start.out);
      }
    }
    if (existsSync(join(codexHome, ".anet-copresence.env"))) fail("private source-then-delete environment file still exists", start.out);
    pass("config.env reaches app-server, bridge, and TUI via the private source-then-delete file");
    const log = join(nodeDir, "codex-bridge.log");
    if (!existsSync(log) || (statSync(log).mode & 0o077) !== 0) fail("codex-bridge.log missing or not private", start.out);
    if (!readFileSync(log, "utf8").includes("client-health role=bridge")) fail("bridge log does not hold the bridge output", readFileSync(log, "utf8"));
    pass("bridge output also lands in <node>/codex-bridge.log (0600)");

    // Single node, no peer → verify must PASS with identity_attested n/a. The fake codex names its
    // thread "thread_windows_e2e" (not a 36-char id) and writes no rollout, and `node create` never
    // writes codexProjectDir (audit P2, separate item) — so give the node exactly what a real
    // logged-in node has: a full thread id in config with one rollout for it. Everything else
    // verify checks (identity, home, topology, child env, port) is measured on the live node.
    const cfgPath = join(nodeDir, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const threadId = "0199a535-0000-7000-8000-00000000f535";
    cfg.codexThreadId = threadId;
    {
      const dir = join(codexHome, "sessions", "2026", "10", "04");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `rollout-2026-10-04T00-00-00-${threadId}.jsonl`), `{"type":"session_meta","payload":{"id":"${threadId}"}}\n`);
    }
    if (!cfg.codexProjectDir) cfg.codexProjectDir = project;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    chmodSync(cfgPath, 0o600);
    const v = run(["node", "codex", "verify", alias]);
    console.log(v.out);
    if (v.rc !== 0) fail(`single-node verify exited ${v.rc} (want 0)`, v.out);
    if (!v.out.includes(`PASS: verify ${alias} (not applicable: identity_attested)`)) fail("verify PASS line does not say identity_attested was not applicable", v.out);
    if (!/^\s+- identity_attested\s+not applicable/m.test(v.out)) fail("identity_attested is not shown as n/a", v.out);
    pass("single node, no --probe-from: verify PASS, identity_attested n/a");

    // A bad config.env must be rejected before the launcher quiesces the
    // healthy old generation.  This is the production ordering regression:
    // validation used to happen only while writing the replacement app-server
    // env file, after all three old sessions had already been killed.
    const beforeSessions = sessions().sort();
    const beforePids = new Map(beforeSessions.map((session) => [session, panePid(session)]));
    const invalidCfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    invalidCfg.env = { ...(invalidCfg.env ?? {}), PATH: "/unsafe/config-path" };
    writeFileSync(cfgPath, JSON.stringify(invalidCfg, null, 2), { mode: 0o600 });
    const refused = run(["node", "start", alias, "--codex-bin", codexWrapper, "--accept-dev-channels"]);
    if (refused.rc === 0 || !refused.out.includes("config.env.PATH is reserved")) {
      fail("reserved config.env was not rejected before replacement", refused.out);
    }
    const afterSessions = sessions().sort();
    if (JSON.stringify(afterSessions) !== JSON.stringify(beforeSessions)) {
      fail("reserved config.env changed the live session set", refused.out);
    }
    for (const [session, pid] of beforePids) {
      if (!pid || !existsSync(`/proc/${pid}`) || panePid(session) !== pid) {
        fail(`reserved config.env killed or replaced ${session} pid=${pid}`, refused.out);
      }
    }
    delete invalidCfg.env.PATH;
    writeFileSync(cfgPath, JSON.stringify(invalidCfg, null, 2), { mode: 0o600 });
    pass("reserved config.env fails before quiesce; all three old sessions keep the same pids");
  } else if (scenario === "backup-fails") {
    if (start.rc === 0) fail("start succeeded although the recovery backup failed", start.out);
    if (!start.out.includes("cannot create quiesced Codex recovery point") || !start.out.includes("refuses symlink")) {
      fail("backup failure was not surfaced as the startup refusal", start.out);
    }
    if (sessions().some((session) => session.startsWith(alias))) {
      fail("backup failure still launched a co-presence process", start.out);
    }
    const recoveryDir = join(nodeDir, "recovery");
    if (existsSync(recoveryDir) && readdirSync(recoveryDir).length !== 0) {
      fail("backup failure left a partial recovery directory", start.out);
    }
    pass("backup failure exits nonzero before app-server/bridge/TUI and removes the partial recovery point");
  } else if (scenario === "bridge-dies") {
    if (start.rc === 0) fail("start succeeded although the bridge's agent-node exits at launch", start.out);
    if (!start.out.includes("bridge exited before attaching")) fail("failure does not say the bridge exited", start.out);
    if (!/\| .*T535-BRIDGE-BOOM: simulated agent-node failure at launch/.test(start.out)) fail("the bridge's own error line was not printed from its log", start.out);
    if (!start.out.includes(join(nodeDir, "codex-bridge.log"))) fail("the bridge log path was not printed", start.out);
    if (/tmux attach -t '=[^']*-桥'/.test(start.out)) fail("printed a tmux attach for a bridge session that no longer exists", start.out);
    pass("dead bridge: its last lines + log path are printed, no attach to a vanished session");
  } else if (scenario === "logged-out") {
    if (start.rc !== 3) fail(`logged-out start exited ${start.rc} (want 3 = needs-login)`, start.out);
    if (start.out.includes("就绪")) fail("logged-out start still says 就绪", start.out);
    if (!start.out.includes("needs-login")) fail("no needs-login state", start.out);
    if (!start.out.includes(`CODEX_HOME=${codexHome} codex login --device-auth`)) fail("no exact login command for this node's CODEX_HOME", start.out);
    const ours = sessions().filter((s) => s.startsWith(alias));
    if (ours.length) fail(`logged-out start left tmux sessions: ${ours.join(", ")}`, start.out);
    if (npxCalls().length) fail("logged-out start still resolved agent-node", start.out);
    pass("logged out: needs-login with the exact command, exit 3, nothing started");
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
} finally {
  if (started && scenario !== "logged-out") {
    const s = run(["node", "stop", alias], 60_000);
    if (s.rc !== 0) console.log(`stop rc=${s.rc}: ${s.out.slice(-400)}`);
  }
  // Only this test's own sessions, on this test's private socket. Never kill-server (#505).
  // By session id: `-t =<name>` does not match CJK names like "<alias>-桥" on tmux 3.4.
  const rows = (tmux(["list-sessions", "-F", "#{session_id}\t#{session_name}"]).stdout ?? "").split("\n").map((l) => l.split("\t"));
  for (const [id, name] of rows) if (id && name?.startsWith(alias)) tmux(["kill-session", "-t", id]);
}
