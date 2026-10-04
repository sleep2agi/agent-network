// Board #542 — "no behaviour change" evidence for the OpenCode backend refactor.
//
// Drives the two production OpenCode V1 entries (ACP `openOpencodeRuntime`
// and native serve+attach `openOpenCodeCopresenceRuntime`) against a fixed
// fake `opencode-ai` package and records exactly what the upstream binary is
// handed: argv, cwd, the complete environment, and the human-TUI attach
// launcher. Random parts (launch-root suffix, temp roots, port, password) are
// normalised; everything else must be byte-identical to the golden recorded
// on origin/main BEFORE the backend interface existed.
//
// Re-record (only when a behaviour change is intended and reviewed):
//   ANET_UPDATE_OPENCODE_SPAWN_SNAPSHOT=1 bun test src/runtime/opencode-v1-spawn-snapshot.test.ts

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openOpencodeRuntime } from "./opencode-acp/runtime";
import { openOpenCodeCopresenceRuntime } from "./opencode-copresence/runtime";

const GOLDEN = join(import.meta.dir, "opencode-v1-spawn-snapshot.golden.json");
const UPDATE = process.env.ANET_UPDATE_OPENCODE_SPAWN_SNAPSHOT === "1";

function makeLaunchBase(label: string): string {
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new Error("OpenCode launch isolation tests require Linux uid semantics");
  }
  const userRuntime = `/run/user/${process.getuid()}`;
  mkdirSync(userRuntime, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(userRuntime, `.anet-${label}-`));
}

function makePackageBinary(launchBase: string, script: string): string {
  const fixtureRoot = mkdtempSync(join(launchBase, ".opencode-ai-fixture-"));
  const nodeModules = join(fixtureRoot, "node_modules");
  const packageRoot = join(nodeModules, "opencode-ai");
  const binDir = join(packageRoot, "bin");
  const binary = join(binDir, "opencode.exe");
  mkdirSync(nodeModules, { mode: 0o700 });
  mkdirSync(packageRoot, { mode: 0o700 });
  mkdirSync(binDir, { mode: 0o700 });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "opencode-ai",
    version: "1.18.1",
    bin: { opencode: "./bin/opencode.exe" },
  }), { mode: 0o600 });
  writeFileSync(binary, script, { mode: 0o700 });
  chmodSync(binary, 0o700);
  return binary;
}

// One stub serves both entries: `--version` for the probe, `acp` (JSON-RPC on
// stdio) and `serve` (HTTP health + POST /session). Each non-probe start
// appends {argv, cwd, env} to the capture file before doing anything else.
function stub(capturePath: string): string {
  return `#!/usr/bin/env bun
import { appendFileSync } from "fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("1.18.1"); process.exit(0); }
appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv: args, cwd: process.cwd(), env: { ...process.env } }) + "\\n");
if (args[0] === "acp") {
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    while (buf.includes("\\n")) {
      const idx = buf.indexOf("\\n");
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const req = JSON.parse(line);
      if (req.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\\n");
      } else if (req.method === "session/new" || req.method === "session/load") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { sessionId: "ses_snapshot" } }) + "\\n");
      }
    }
  });
} else if (args[0] === "serve") {
  const http = require("http");
  const port = Number(args[args.indexOf("--port") + 1]);
  const auth = "Basic " + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ":" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== auth) { res.writeHead(401); return res.end(); }
    req.resume();
    req.on("end", () => {
      const send = (v) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.url === "/global/health") return send({ healthy: true, version: "1.18.1" });
      if (req.url === "/session" && req.method === "POST") return send({ id: "ses_snapshot" });
      res.writeHead(404); res.end();
    });
  });
  server.listen(port, "127.0.0.1");
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else {
  console.error("unsupported", args.join(" "));
  process.exit(2);
}
`;
}

interface Capture { argv: string[]; cwd: string; env: Record<string, string> }

function readCaptures(path: string): Capture[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Replace run-specific values with stable placeholders. */
function normaliser(roots: Record<string, string>, secrets: Record<string, string>) {
  return (value: string): string => {
    let out = value;
    for (const [name, secret] of Object.entries(secrets)) {
      if (secret) out = out.split(secret).join(`<${name}>`);
    }
    // Longest root first so nested temp roots win over their parents.
    for (const [name, root] of Object.entries(roots).sort((a, b) => b[1].length - a[1].length)) {
      out = out.split(root).join(`<${name}>`);
    }
    return out
      .replace(/\.anet-opencode-launch-[A-Za-z0-9]+/g, ".anet-opencode-launch-<R>")
      .replace(/\.opencode-ai-fixture-[A-Za-z0-9]+/g, ".opencode-ai-fixture-<R>")
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<PORT>");
  };
}

function normaliseCapture(capture: Capture, norm: (v: string) => string) {
  const env: Record<string, string> = {};
  for (const key of Object.keys(capture.env).sort()) {
    // PATH must stay the host's (the stub's `#!/usr/bin/env bun` needs it);
    // the snapshot pins that it is inherited verbatim.
    env[key] = key === "PATH" && capture.env[key] === process.env.PATH ? "<inherited>" : norm(capture.env[key]);
  }
  const argv = capture.argv.map((arg, i) => capture.argv[i - 1] === "--port" ? "<PORT>" : norm(arg));
  return { argv, cwd: norm(capture.cwd), env };
}

// Every host key child-env.ts may pass through (PASSTHROUGH_ENV_KEYS). The
// test pins them to fixed values (PATH excepted) so the golden is identical on
// any machine and still proves which keys cross the boundary.
const HOST_PASSTHROUGH_KEYS = [
  "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TERM",
  "COLORTERM", "SHELL", "NO_COLOR", "FORCE_COLOR", "HTTP_PROXY", "HTTPS_PROXY",
  "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];
const FIXED_HOST_ENV: Record<string, string> = {
  LANG: "C.UTF-8",
  TZ: "UTC",
  TERM: "xterm-snapshot",
  SHELL: "/bin/sh",
  NO_COLOR: "1",
  HTTPS_PROXY: "http://proxy.invalid:3128",
  // Never inherited by the child (not on the allowlist) — proves the filter.
  OPENCODE_CONFIG_CONTENT: "{\"ambient\":true}",
  ANTHROPIC_API_KEY: "sk-ambient-must-not-leak",
};

async function withFixedHostEnv<T>(run: () => Promise<T>): Promise<T> {
  const keys = [...HOST_PASSTHROUGH_KEYS, ...Object.keys(FIXED_HOST_ENV)];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, FIXED_HOST_ENV);
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function acpSnapshot(unsafeTools: boolean) {
  const root = mkdtempSync(join(tmpdir(), "opencode-snap-acp-"));
  const launchBase = makeLaunchBase("snap-acp");
  const workDir = join(root, "node");
  const projectDir = join(root, "project");
  const capture = join(root, "capture.jsonl");
  const binary = makePackageBinary(launchBase, stub(capture));
  let session: Awaited<ReturnType<typeof openOpencodeRuntime>> | null = null;
  try {
    mkdirSync(workDir, { mode: 0o700 });
    mkdirSync(projectDir, { mode: 0o700 });
    session = await openOpencodeRuntime({ cwd: projectDir, workDir, binary, launchBase, unsafeTools });
    const norm = normaliser({ LAUNCH_BASE: launchBase, ROOT: root }, {});
    return readCaptures(capture).map((c) => normaliseCapture(c, norm));
  } finally {
    await session?.client.stop("SIGKILL");
    rmSync(launchBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

async function copresenceSnapshot(unsafeTools: boolean) {
  const root = mkdtempSync(join(tmpdir(), "opencode-snap-co-"));
  const launchBase = makeLaunchBase("snap-co");
  const workDir = join(root, "node");
  const projectDir = join(root, "project");
  const capture = join(root, "capture.jsonl");
  const binary = makePackageBinary(launchBase, stub(capture));
  let session: Awaited<ReturnType<typeof openOpenCodeCopresenceRuntime>> | undefined;
  try {
    mkdirSync(workDir, { mode: 0o700 });
    mkdirSync(projectDir, { mode: 0o700 });
    // Node-local persistent config (unsafe mode renders from it in place).
    mkdirSync(join(workDir, ".config", "opencode"), { recursive: true, mode: 0o700 });
    writeFileSync(join(workDir, ".config", "opencode", "opencode.json"), "{}\n", { mode: 0o600 });
    session = await openOpenCodeCopresenceRuntime({
      cwd: projectDir,
      workDir,
      binary,
      launchBase,
      unsafeTools,
      model: "opencode/fake",
      commhubMcpUrl: "http://127.0.0.1:1/mcp",
      commhubToken: "tok_snapshot_fixture",
      commhubAlias: "snapshot-node",
      startupTimeoutMs: 10_000,
      tmuxRunner: () => { throw new Error("snapshot test must not reach tmux"); },
      tmuxRespawn: () => { throw new Error("snapshot test must not reach tmux"); },
    });
    const captures = readCaptures(capture);
    const password = captures.find((c) => c.argv[0] === "serve")?.env.OPENCODE_SERVER_PASSWORD ?? "";
    const norm = normaliser({ LAUNCH_BASE: launchBase, ROOT: root }, { PASSWORD: password });
    const launcher = readFileSync(session.attachScriptPath, "utf8");
    return {
      spawns: captures.map((c) => normaliseCapture(c, norm)),
      attachScriptPath: norm(session.attachScriptPath),
      attachLauncher: launcher.split("\n").map((line) =>
        line === `export PATH='${(process.env.PATH ?? "").replaceAll("'", `'"'"'`)}'`
          ? "export PATH=<inherited>"
          : norm(line)),
    };
  } finally {
    await session?.close();
    rmSync(launchBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

describe("OpenCode V1 spawn snapshot (#542 — backend refactor changes nothing)", () => {
  test("argv, cwd, env and attach launcher are byte-identical to the pre-refactor golden", async () => {
    const actual = await withFixedHostEnv(async () => ({
      acpSafe: await acpSnapshot(false),
      acpUnsafe: await acpSnapshot(true),
      copresenceSafe: await copresenceSnapshot(false),
      copresenceUnsafe: await copresenceSnapshot(true),
    }));
    // Sanity: the fixture really exercised both topologies.
    expect(actual.acpSafe.map((s) => s.argv[0])).toEqual(["acp"]);
    expect(actual.copresenceSafe.spawns.map((s) => s.argv[0])).toEqual(["serve"]);
    if (UPDATE || !existsSync(GOLDEN)) {
      if (!UPDATE) throw new Error(`missing golden ${GOLDEN}; record with ANET_UPDATE_OPENCODE_SPAWN_SNAPSHOT=1`);
      writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + "\n");
    }
    expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
  }, 60_000);
});
