// Published agent-node 2.5.0-preview.110 and 2.5.0-preview.121 against this
// hub. Production-shaped rows: an unbound epoch-0 token, a bound epoch-2
// token, and the same alias in a second network. The throwaway hub listens
// on 9391. An unbound token with zero rows is the HTTP suite, not this one:
// these nodes already have a row, which is how an old token keeps working.
//
// Each published binary registers, opens SSE, and sends one task by explicit
// delegation (no model) while the other binary is idle. The idle receiver
// dequeues the child and logs the sender line. Doing both directions at once
// leaves each node inside its own lifecycle, so that line never prints. The
// two directions use separate aliases: restarting onto an unacked parent
// replays it, and the hub drops the new send as a duplicate.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const PORT = 9391;
if (process.env.PORT === "9200") throw new Error("refusing port 9200");
if (!readFileSync("/proc/1/cgroup", "utf8").includes("docker") && !existsDockerEnv()) {
  throw new Error("compat runs only inside the throwaway container");
}
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
process.env.COMMHUB_DB = process.env.COMMHUB_DB || "/tmp/compat679/hub.db";
process.env.COMMHUB_UPLOADS_DIR = process.env.COMMHUB_UPLOADS_DIR || "/tmp/compat679/uploads";
process.env.HOME = process.env.HOME || "/tmp/compat679-root";
delete process.env.DATABASE_URL;
delete process.env.COMMHUB_TEST_PG_URL;
delete process.env.COMMHUB_TOKEN;
delete process.env.COMMHUB_AUTH_TOKEN;

const NODE110 = process.env.NODE110 || "/opt/n110/node_modules/@sleep2agi/agent-node/dist/cli.js";
const NODE121 = process.env.NODE121 || "/opt/n121/node_modules/@sleep2agi/agent-node/dist/cli.js";
const HUB = `http://127.0.0.1:${PORT}`;
const children: ChildProcess[] = [];

function existsDockerEnv(): boolean {
  try { readFileSync("/.dockerenv"); return true; } catch { return false; }
}
function redact(text: string): string {
  return text.replace(/ntok_[A-Za-z0-9_-]+/g, "ntok_redacted").replace(/utok_[A-Za-z0-9_-]+/g, "utok_redacted");
}
let hub: { stop: (closeActiveConnections?: boolean) => void } | null = null;
function lastLines(text: string, count: number): string {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  const from = starts.length > count ? starts[starts.length - count] : 0;
  let out = "";
  for (let i = from; i < text.length; i += 1) out += text.charAt(i);
  return out;
}
function fail(message: string): never {
  console.error(redact(message));
  try {
    for (const name of readdirSync("/tmp/compat679")) {
      if (!name.endsWith(".log")) continue;
      const tail = lastLines(readFileSync(`/tmp/compat679/${name}`, "utf8"), 40);
      console.error(`--- ${name} ---\n${redact(tail)}`);
    }
  } catch { /* no logs yet */ }
  for (const child of children) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  throw new Error(redact(message));
}
async function waitFor(label: string, ms: number, pred: () => boolean) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  fail(`timeout: ${label}`);
}
function packageVersion(cli: string): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", `file://${cli}`).pathname, "utf8"));
  return String(pkg.version || "");
}

const hubLines: string[] = [];
const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
console.log = (...args: unknown[]) => {
  hubLines.push(args.map(String).join(" "));
  origLog(...args);
};
console.warn = (...args: unknown[]) => {
  hubLines.push(args.map(String).join(" "));
  origWarn(...args);
};

const { db, generateNetworkToken, hashToken } = await import("/work/server/src/db.ts");
const { addNetworkMember, register } = await import("/work/server/src/auth.ts");
const { bootServer } = await import("/work/server/src/server.ts");

const stamp = Date.now().toString(36);
const aliasA = `idvcmpa${stamp}`;
const aliasB = `idvcmpb${stamp}`;
const aliasC = `idvcmpc${stamp}`;
const aliasD = `idvcmpd${stamp}`;
const nodeA = `n_idv_cmp_a_${stamp}`;
const nodeAOther = `n_idv_cmp_a2_${stamp}`;
const nodeB = `n_idv_cmp_b_${stamp}`;
const nodeC = `n_idv_cmp_c_${stamp}`;
const nodeCOther = `n_idv_cmp_c2_${stamp}`;
const nodeD = `n_idv_cmp_d_${stamp}`;

const owner = register(`idvown${stamp}`, "CompatOwner123!", undefined, "seed");
if (!owner.ok || !owner.token || !owner.user || !owner.network_id) fail(owner.error || "owner register failed");
const other = register(`idvoth${stamp}`, "CompatOther123!", undefined, "seed");
if (!other.ok || !other.user || !other.network_id) fail(other.error || "other register failed");
const joined = addNetworkMember(owner.network_id, other.user.user_id, "member", owner.user.user_id);
if (!joined.ok) fail(joined.error || "add member failed");
const NET = owner.network_id;
const NET2 = other.network_id;
const ownerId = owner.user.user_id;
const ownerName = owner.user.username;

function mint(alias: string, epoch: number, bound: string | null, networkId: string) {
  const token = generateNetworkToken();
  const tokenId = `tok_cmp_${alias}_${epoch}`;
  db.run(
    `INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, bound_node_id, node_identity_epoch)
     VALUES (?1, ?2, ?3, ?4, ?5, 'network', ?6, ?7)`,
    [tokenId, hashToken(token), ownerId, networkId, `node:${alias}`, bound, epoch],
  );
  return { token, tokenId };
}
function insertNode(nodeId: string, alias: string, networkId: string) {
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at)
     VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'))`,
    [nodeId, alias, networkId, ownerId],
  );
}
insertNode(nodeA, aliasA, NET);
insertNode(nodeAOther, aliasA, NET2);
insertNode(nodeB, aliasB, NET);
insertNode(nodeC, aliasC, NET);
insertNode(nodeCOther, aliasC, NET2);
insertNode(nodeD, aliasD, NET);
const unbound = mint(aliasA, 0, null, NET);
const bound = mint(aliasB, 2, nodeB, NET);
const unboundC = mint(aliasC, 0, null, NET);
const boundD = mint(aliasD, 2, nodeD, NET);

const server = bootServer({ port: PORT, hostname: "127.0.0.1" });
hub = server;
if (server.port === 9200) fail("hub bound 9200");
async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${HUB}/health`);
    return res.ok;
  } catch { return false; }
}
{
  const start = Date.now();
  let ok = false;
  while (Date.now() - start < 10000) {
    if (await healthy()) { ok = true; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ok) fail("hub /health did not answer");
}

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${HUB}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const data = raw.split("\n").filter((line) => line.startsWith("data:"));
  const payload = data.length ? JSON.parse(data.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  const text = payload.result?.content?.[0]?.text;
  if (typeof text !== "string" || !text.startsWith("{")) fail(`${name}: ${redact(raw).slice(0, 400)}`);
  return JSON.parse(text);
}

function writeConfig(dir: string, alias: string, token: string, nodeId: string) {
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/config.json`;
  writeFileSync(path, JSON.stringify({
    alias,
    token,
    hub: HUB,
    network_id: NET,
    node_id: nodeId,
    runtime: "claude-agent-sdk",
  }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function startNode(cli: string, alias: string, token: string, nodeId: string, logPath: string) {
  const home = `/tmp/compat679/home-${alias}`;
  mkdirSync(home, { recursive: true });
  const config = writeConfig(`/tmp/compat679/cfg-${alias}`, alias, token, nodeId);
  const child = spawn("node", [cli, "--config", config, "--alias", alias, "--hub", HUB, "--runtime", "claude-agent-sdk"], {
    cwd: "/tmp/compat679",
    env: {
      PATH: process.env.PATH || "/usr/bin",
      HOME: home,
      COMMHUB_URL: HUB,
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const chunks: Buffer[] = [];
  const sink = (buf: Buffer) => {
    chunks.push(buf);
    writeFileSync(logPath, Buffer.concat(chunks));
  };
  child.stdout?.on("data", sink);
  child.stderr?.on("data", sink);
  child.on("exit", () => writeFileSync(logPath, Buffer.concat(chunks)));
  return child;
}

function logText(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}
function session(alias: string, networkId: string) {
  return db.get<{ alias: string; node_id: string | null; network_id: string | null; status: string }>(
    "SELECT alias, node_id, network_id, status FROM sessions WHERE alias = ?1 AND network_id = ?2",
    alias, networkId,
  );
}
function taskRow(content: string) {
  return db.get<{ from_name: string; to_name: string; content: string }>(
    "SELECT from_name, to_name, content FROM tasks WHERE content = ?1",
    content,
  );
}

function expectVersion(cli: string, version: string) {
  const got = packageVersion(cli);
  if (got !== version) fail(`${cli} version ${got} !== ${version}`);
  origLog(`binary ${version}`);
}
expectVersion(NODE110, "2.5.0-preview.110");
expectVersion(NODE121, "2.5.0-preview.121");
origLog(`source_commit=${process.env.SOURCE_COMMIT || "unknown"}`);
origLog(`aliases ${aliasA} ${aliasB} ${aliasC} ${aliasD} networks ${NET} ${NET2}`);

async function stopNodes() {
  const dying = children.splice(0);
  for (const child of dying) {
    try { child.kill("SIGTERM"); } catch { /* gone */ }
  }
  const start = Date.now();
  while (dying.some((child) => child.exitCode === null) && Date.now() - start < 4000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const child of dying) {
    if (child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }
  }
}

async function oneWay(label: string, spec: {
  senderCli: string;
  senderAlias: string;
  senderToken: string;
  senderNode: string;
  senderLog: string;
  receiverCli: string;
  receiverAlias: string;
  receiverToken: string;
  receiverNode: string;
  receiverLog: string;
  ping: string;
  crossAlias: string;
}) {
  const before = hubLines.length;
  startNode(spec.senderCli, spec.senderAlias, spec.senderToken, spec.senderNode, spec.senderLog);
  startNode(spec.receiverCli, spec.receiverAlias, spec.receiverToken, spec.receiverNode, spec.receiverLog);
  await waitFor(`${label} registered`, 30000, () =>
    logText(spec.senderLog).includes("已注册到 CommHub") && logText(spec.receiverLog).includes("已注册到 CommHub"));
  const senderSession = session(spec.senderAlias, NET);
  const receiverSession = session(spec.receiverAlias, NET);
  if (!senderSession || senderSession.node_id !== spec.senderNode) fail(`${label} sender session ${JSON.stringify(senderSession)}`);
  if (!receiverSession || receiverSession.node_id !== spec.receiverNode) fail(`${label} receiver session ${JSON.stringify(receiverSession)}`);
  if (session(spec.crossAlias, NET2)) fail(`${label} same alias opened a session in the other network`);
  await waitFor(`${label} sse`, 20000, () => {
    const slice = hubLines.slice(before).join("\n");
    return slice.includes(`:${spec.senderAlias} connected`) && slice.includes(`:${spec.receiverAlias} connected`);
  });
  const crossed = hubLines.slice(before).filter((line) =>
    (line.includes("superseded") || line.includes("node_identity_conflict"))
    && line.includes(spec.senderAlias) && line.includes(spec.receiverAlias));
  if (crossed.length) fail(`${label} cross-alias supersede:\n${crossed.join("\n")}`);
  const sent = await tool(owner.token!, "send_task", {
    alias: spec.senderAlias,
    task: `交给 ${spec.receiverAlias}：${spec.ping}`,
    from_session: ownerName,
  });
  if (sent.ok === false) fail(`${label} trigger send failed ${JSON.stringify(sent)}`);
  await waitFor(`${label} child task`, 45000, () => {
    const row = taskRow(spec.ping);
    return !!row && row.from_name === spec.senderAlias && row.to_name === spec.receiverAlias;
  });
  const delivered = hubLines.slice(before).some((line) =>
    line.includes(`${spec.senderAlias} → send_task → ${spec.receiverAlias}:`) && line.includes(spec.ping));
  if (!delivered) fail(`${label} hub did not accept the child send`);
  await waitFor(`${label} received`, 30000, () =>
    logText(spec.receiverLog).includes(`← [${spec.senderAlias}]`) && logText(spec.receiverLog).includes(spec.ping));
  origLog(`ROUND ${label} PASS`);
  await stopNodes();
}

let passed = false;
try {
  await oneWay("110-sends", {
    senderCli: NODE110,
    senderAlias: aliasA,
    senderToken: unbound.token,
    senderNode: nodeA,
    senderLog: "/tmp/compat679/n110-sends.log",
    receiverCli: NODE121,
    receiverAlias: aliasB,
    receiverToken: bound.token,
    receiverNode: nodeB,
    receiverLog: "/tmp/compat679/n121-receives.log",
    ping: `ping-110-to-121-${stamp}`,
    crossAlias: aliasA,
  });
  await oneWay("121-sends", {
    senderCli: NODE121,
    senderAlias: aliasD,
    senderToken: boundD.token,
    senderNode: nodeD,
    senderLog: "/tmp/compat679/n121-sends.log",
    receiverCli: NODE110,
    receiverAlias: aliasC,
    receiverToken: unboundC.token,
    receiverNode: nodeC,
    receiverLog: "/tmp/compat679/n110-receives.log",
    ping: `ping-121-to-110-${stamp}`,
    crossAlias: aliasC,
  });
  const otherRow = db.get<{ node_id: string; alias: string }>(
    "SELECT node_id, alias FROM nodes WHERE node_id = ?1",
    nodeAOther,
  );
  if (!otherRow || otherRow.alias !== aliasA) fail(`other network row moved ${JSON.stringify(otherRow)}`);
  const otherRowC = db.get<{ node_id: string; alias: string }>(
    "SELECT node_id, alias FROM nodes WHERE node_id = ?1",
    nodeCOther,
  );
  if (!otherRowC || otherRowC.alias !== aliasC) fail(`other network row moved ${JSON.stringify(otherRowC)}`);
  const stillUnbound = db.get<{ bound_node_id: string | null; node_identity_epoch: number }>(
    "SELECT bound_node_id, node_identity_epoch FROM api_tokens WHERE token_id = ?1",
    unbound.tokenId,
  );
  if (stillUnbound?.bound_node_id || stillUnbound?.node_identity_epoch !== 0) {
    fail(`unbound token changed ${JSON.stringify(stillUnbound)}`);
  }
  const stillBound = db.get<{ bound_node_id: string | null }>(
    "SELECT bound_node_id FROM api_tokens WHERE token_id = ?1",
    bound.tokenId,
  );
  if (stillBound?.bound_node_id !== nodeB) fail(`bound token changed ${JSON.stringify(stillBound)}`);
  const stillUnboundC = db.get<{ bound_node_id: string | null; node_identity_epoch: number }>(
    "SELECT bound_node_id, node_identity_epoch FROM api_tokens WHERE token_id = ?1",
    unboundC.tokenId,
  );
  if (stillUnboundC?.bound_node_id || stillUnboundC?.node_identity_epoch !== 0) {
    fail(`unbound token changed ${JSON.stringify(stillUnboundC)}`);
  }
  const stillBoundD = db.get<{ bound_node_id: string | null }>(
    "SELECT bound_node_id FROM api_tokens WHERE token_id = ?1",
    boundD.tokenId,
  );
  if (stillBoundD?.bound_node_id !== nodeD) fail(`bound token changed ${JSON.stringify(stillBoundD)}`);
  origLog("RESULT compat PASS");
  passed = true;
} catch (error) {
  console.error(redact(error instanceof Error ? error.stack || error.message : String(error)));
} finally {
  try { server.stop(true); } catch { /* already stopped */ }
}
process.exit(passed ? 0 : 1);
