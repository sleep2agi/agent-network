// Real upstream listeners and the real create handler. The request/ACK transport
// is a fixture; spawnChild deliberately stops BEFORE child launch. This proves
// config selection, not a CLI/Hub/TUI turn or successful node startup.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, chownSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { handleCreateNodeDoorbell } from "/opt/node_modules/@sleep2agi/agent-node/src/runtime/create-node-daemon.ts";
import { observeHostSharedServe } from "/opt/node_modules/@sleep2agi/agent-node/src/runtime/opencode-host-shared-observer.ts";

const root = "/run/test1326";
const home = join(root, "home"), project = join(root, "project"), launches = join(root, "launches");
for (const path of [root, home, project, launches, join(home, ".anet"), join(home, ".config/opencode")]) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ANET_OPENCODE_SAFE_BASE = launches;
process.env.OPENAI_API_KEY = "test1326-ambient-key-must-not-enter-probe";
writeFileSync(join(home, ".config/opencode/opencode.json"), JSON.stringify({ model: "stub/model" }), { mode: 0o600 });
// The pinned CLI is never executed: the injected spawn boundary throws after
// reading the product-written config. No fake CLI success is reported.
const cliDir = join(root, "anet-fixture");
mkdirSync(cliDir, { mode: 0o700 });
const cli = join(cliDir, "cli.cjs");
writeFileSync(cli, "#!/usr/bin/env node\nprocess.exit(97);\n", { mode: 0o755 });
writeFileSync(join(cliDir, "package.json"), JSON.stringify({ name: "@sleep2agi/agent-network", bin: { anet: "cli.cjs" } }), { mode: 0o600 });
const pin = join(root, "path.conf");
writeFileSync(pin, `ANET_BIN_ABS=${cli}\n`, { mode: 0o600 });
process.env.ANET_DAEMON_PATH_CONF = pin;
const registry = join(home, ".anet/opencode-shared-server.json");
const passwordFile = join(root, "shared-password");
writeFileSync(passwordFile, "test1326-shared-only", { mode: 0o600 });
const v2Bin = readFileSync("/v2-bin", "utf8").trim(), v1Bin = readFileSync("/v1-bin", "utf8").trim();
const children: ChildProcess[] = [];
function check(name: string, condition: unknown, detail = "") {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
}
function connected(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(200);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}
async function waitFor(port: number) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await connected(port)) return;
    await Bun.sleep(100);
  }
  throw new Error(`listener did not start on ${port}`);
}
function register(port: number) {
  const body = JSON.stringify({ url: `http://127.0.0.1:${port}`, passwordFile, clientBinDir: "/usr/local/bin" });
  writeFileSync(registry, body, { mode: 0o600 });
  return body;
}
function start(binary: string, port: number, v1 = false) {
  const proc = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), ...(v1 ? ["--pure"] : [])], {
    cwd: "/", stdio: "ignore", env: { ...process.env, XDG_DATA_HOME: join(root, v1 ? "v1-data" : "v2-data") },
  });
  children.push(proc);
  return proc;
}
async function create(alias: string, flags: Record<string, unknown> = { opencodeGeneration: "v2", opencodeUnsafeTools: true }, expectedRejected = false) {
  const logs: string[] = [], acks: any[] = [];
  let config: any;
  await handleCreateNodeDoorbell({ request_id: `cr_${alias}` }, {
    workDir: project, hubUrl: "http://127.0.0.1:9132",
    callCommHub: async (tool, args) => {
      if (tool === "get_create_request") return {
        ok: true, child_token: `ntok_test1326_${alias}`, network_id: "net_test1326",
        node_spec: { name: alias, runtime: "opencode-cli", model: "stub/model", flags },
      };
      if (tool === "ack_create_request") { acks.push(args); return { ok: true }; }
      throw new Error(`unexpected tool ${tool}`);
    },
    log: text => logs.push(text), warn: text => logs.push(text), serializeEnvLocal: () => "",
    spawnChild: (_bin, args, opts) => {
      config = JSON.parse(readFileSync(join(opts.cwd, ".anet/nodes", args[2], "config.json"), "utf8"));
      throw new Error("test1326_stop_before_child_launch");
    },
  });
  if (expectedRejected) {
    check(`${alias}: rejected before config write or spawn`, config === undefined
      && !existsSync(join(project, ".anet/nodes", alias, "config.json")));
    check(`${alias}: bad registry remains a rejection`, acks.length === 1 && acks[0].status === "rejected"
      && acks[0].error.startsWith("shared_opencode_registry:"));
    return { config, logs };
  }
  check(`${alias}: real handler reached the child-launch boundary`, !!config, config ? "" : JSON.stringify({ acks, logs }));
  check(`${alias}: fixture never acknowledges a started node`, acks.length === 1 && acks[0].status === "failed"
    && acks[0].error === "fork_start: test1326_stop_before_child_launch");
  check(`${alias}: probe launch roots were discarded`, readdirSync(launches).length === 0);
  check(`${alias}: audit omits the shared password and its path`, logs.every(line => !line.includes(passwordFile) && !line.includes("test1326-shared-only")));
  return { config, logs };
}
function noShared(name: string, config: any) {
  check(name, !Object.hasOwn(config, "opencodeSharedServerUrl") && !Object.hasOwn(config, "opencodeSharedServerPasswordFile"));
}
try {
  const hostA = start(v2Bin, 13260);
  await waitFor(13260);
  check("host A is a real observable V2 listener", observeHostSharedServe("http://127.0.0.1:13260").ok);
  const registered = register(13260);
  const b = await create("newB");
  check("new B defaults to the existing host A connection", b.config.opencodeSharedServerUrl === "http://127.0.0.1:13260"
    && b.config.opencodeSharedServerPasswordFile === passwordFile);
  check("admission audit records real pid and port", b.logs.some(line => /shared admit reason=host_shared_live pid=\d+ port=13260$/.test(line)));
  check("clientBinDir stays out of the child config", !Object.hasOwn(b.config, "clientBinDir"));
  const c = await create("newC");
  check("another new identity also shares A", c.config.opencodeSharedServerUrl === b.config.opencodeSharedServerUrl
    && c.config.node_id !== b.config.node_id && c.config.token !== b.config.token);
  const fresh = await create("explicitNew", { opencodeGeneration: "v2", opencodeUnsafeTools: true, opencodeNewServer: true });
  noShared("explicit new-server never inherits shared fields", fresh.config);
  check("explicit new-server audit is distinct", fresh.logs.some(line => line.includes("reason=explicit_new_server")));
  // PR2778 is now in the base: the default still refuses a malformed registry,
  // while explicit new-server must remain usable without shared credentials.
  writeFileSync(registry, "{", { mode: 0o600 });
  await create("badRegistryDefault", undefined, true);
  const brokenNew = await create("brokenRegistryNew", { opencodeGeneration: "v2", opencodeUnsafeTools: true, opencodeNewServer: true });
  noShared("explicit new-server escapes a broken registry without shared fields", brokenNew.config);
  register(13260);
  const v1Child = await create("legacyV1", {});
  noShared("legacy V1 never inherits the V2 registry", v1Child.config);
  check("legacy V1 generation remains V1", v1Child.config.opencodeGeneration === "v1");
  check("creation leaves host A and its registry intact", process.kill(hostA.pid!, 0) && readFileSync(registry, "utf8") === registered);
  hostA.kill();
  await new Promise<void>(resolve => hostA.once("exit", () => resolve()));
  const dead = await create("deadHost");
  noShared("a dead registered listener falls back without shared fields", dead.config);
  check("dead-listener audit records observation failure", dead.logs.some(line => line.includes("reason=observe_no_listener")));

  start(v1Bin, 13261, true);
  await waitFor(13261);
  register(13261);
  const wrong = await create("v1Host");
  noShared("a real V1 host server cannot supply a V2 child", wrong.config);
  check("wrong-generation executable is refused", wrong.logs.some(line => line.includes("reason=generation_executable_identity_mismatch")));

  const fake = spawn("bun", ["-e", 'Bun.serve({hostname:"127.0.0.1",port:13262,fetch:()=>new Response("fixture")});setInterval(()=>{},1000)'], { stdio: "ignore" });
  children.push(fake);
  await waitFor(13262);
  register(13262);
  const wrapper = await create("wrapperHost");
  noShared("a script listener cannot impersonate V2", wrapper.config);
  check("wrapper audit preserves the binding refusal", wrapper.logs.some(line => line.includes("reason=generation_interpreter_or_wrapper_exe")));

  // Last: a foreign-uid process may make the whole /proc table unobservable
  // without CAP_SYS_PTRACE. Either that refusal or foreign_uid must fail closed.
  const foreignHome = "/run/test1326-foreign";
  mkdirSync(foreignHome, { mode: 0o700 });
  chownSync(foreignHome, 65534, 65534);
  const foreign = spawn("setpriv", ["--reuid=65534", "--regid=65534", "--clear-groups", v2Bin,
    "serve", "--hostname", "127.0.0.1", "--port", "13263"], {
    cwd: "/", stdio: "ignore",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: foreignHome, XDG_DATA_HOME: join(foreignHome, "data") },
  });
  children.push(foreign);
  await waitFor(13263);
  check("foreign fixture really runs as uid 65534", /^Uid:\s+65534\s+65534\s+65534\s+65534$/m
    .test(readFileSync(`/proc/${foreign.pid}/status`, "utf8")));
  register(13263);
  const foreignChild = await create("foreignHost");
  noShared("foreign ownership or incomplete observation never leaks shared fields", foreignChild.config);
  check("foreign case has a precise refusal audit", foreignChild.logs.some(line => /reason=(foreign_uid|observe_permission_denied)/.test(line)));
  console.log("PASS: real create-handler host-shared admission; no child launch/Hub/TUI claim");
} finally {
  for (const proc of children) { try { proc.kill(); } catch { /* already exited */ } }
}
