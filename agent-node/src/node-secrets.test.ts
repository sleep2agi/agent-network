import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadNodeSecrets, NODE_SECRETS_FILE_NAME, parseSecretsEnv } from "./node-secrets.js";
import { serializeEnvLocalDaemon, writeChildSecretsEnv } from "./runtime/create-node-daemon.js";

const FILE_SENTINEL = "board637-fake-key-value-9f3c";
const PROCESS_SENTINEL = "board637-process-wins-1a2b";
const KEY = "DEMO_VENDOR_KEY";

function scratch(name: string): string {
  const dir = join(tmpdir(), `anet-node-secrets-${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

describe("board #637 node secrets.env", () => {
  test("fills absent keys, keeps an already-set key, skips reserved, logs names only", () => {
    const dir = scratch("load");
    const raw = serializeEnvLocalDaemon({
      [KEY]: FILE_SENTINEL,
      PATH: "/tmp/not-the-real-path",
      ALREADY_SET: "from-file",
    });
    writeFileSync(join(dir, NODE_SECRETS_FILE_NAME), raw, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { ALREADY_SET: "", PATH: "/usr/bin" };
    const lines: string[] = [];
    loadNodeSecrets(dir, env, {
      explicitConfigKeys: ["FROM_CONFIG"],
      log: (line) => lines.push(line),
    });
    expect(env[KEY]).toBe(FILE_SENTINEL);
    expect(env.ALREADY_SET).toBe("");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FROM_CONFIG).toBeUndefined();
    const log = lines.join("\n");
    expect(log).toContain(`loaded=${KEY}`);
    expect(log).toContain("kept-from-process=ALREADY_SET");
    expect(log).toContain("skipped-reserved=PATH");
    expect(log).not.toContain(FILE_SENTINEL);
    expect(log).not.toContain("/tmp/not-the-real-path");
    expect(log).not.toContain("from-file");
  });

  test("a key named in config.json env is not taken from the file", () => {
    const dir = scratch("config-wins");
    writeFileSync(join(dir, NODE_SECRETS_FILE_NAME), `${KEY}=${FILE_SENTINEL}\n`, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};
    const lines: string[] = [];
    loadNodeSecrets(dir, env, { explicitConfigKeys: [KEY], log: (line) => lines.push(line) });
    expect(env[KEY]).toBeUndefined();
    expect(lines.join("\n")).toContain(`kept-from-config=${KEY}`);
    expect(lines.join("\n")).not.toContain(FILE_SENTINEL);
  });

  test("mode other than 0600 refuses and applies nothing", () => {
    const dir = scratch("mode");
    const path = join(dir, NODE_SECRETS_FILE_NAME);
    writeFileSync(path, `${KEY}=${FILE_SENTINEL}\n`, { mode: 0o600 });
    chmodSync(path, 0o644);
    const env: NodeJS.ProcessEnv = {};
    expect(() => loadNodeSecrets(dir, env, { log: () => {} })).toThrow(/mode is 0644, want 0600/);
    expect(env[KEY]).toBeUndefined();
  });

  test("a symlink is refused", () => {
    const dir = scratch("link");
    const real = join(dir, "other.env");
    writeFileSync(real, `${KEY}=${FILE_SENTINEL}\n`, { mode: 0o600 });
    symlinkSync(real, join(dir, NODE_SECRETS_FILE_NAME));
    const env: NodeJS.ProcessEnv = {};
    expect(() => loadNodeSecrets(dir, env)).toThrow(/not a regular file/);
    expect(env[KEY]).toBeUndefined();
  });

  test("quoted daemon serializer round-trips", () => {
    const text = serializeEnvLocalDaemon({ [KEY]: 'say "hi"\nnext' });
    expect(parseSecretsEnv(text).values[KEY]).toBe('say "hi"\nnext');
    expect(text).not.toContain("\nnext");
  });

  test("missing file is not an error", () => {
    const env: NodeJS.ProcessEnv = {};
    loadNodeSecrets(scratch("missing"), env, { log: () => { throw new Error("should not log"); } });
    expect(env[KEY]).toBeUndefined();
  });
});

describe("board #638 daemon writes secrets.env", () => {
  test("env_blob lands in secrets.env at 0600 and not in .env.local", () => {
    const root = scratch("daemon");
    mkdirSync(join(root, ".anet", "nodes", "demo-node"), { recursive: true, mode: 0o700 });
    writeChildSecretsEnv(root, "demo-node", { [KEY]: FILE_SENTINEL }, serializeEnvLocalDaemon);
    const file = join(root, ".anet", "nodes", "demo-node", NODE_SECRETS_FILE_NAME);
    expect((statSync(file).mode & 0o777)).toBe(0o600);
    expect(parseSecretsEnv(readFileSync(file, "utf8")).values[KEY]).toBe(FILE_SENTINEL);
    expect(() => statSync(join(root, ".anet", "nodes", "demo-node", ".env.local"))).toThrow();
    const source = readFileSync(join(import.meta.dir, "runtime", "create-node-daemon.ts"), "utf8");
    expect(source).not.toContain(".env.local");
    expect(source).toContain("writeChildSecretsEnv(");
  });
});

function runNode(home: string, nodeDir: string, extraEnv: NodeJS.ProcessEnv): {
  status: number | null;
  out: string;
  child: { value: string | null; argv: string[] } | null;
  argv: string[];
} {
  const probeOut = join(home, "probe.json");
  rmSync(probeOut, { force: true });
  const cli = join(import.meta.dir, "cli.ts");
  const config = join(nodeDir, "config.json");
  const argv = [cli, "--config", config, "--alias", "demo-node"];
  const child = spawnSync(process.execPath, argv, {
    cwd: home,
    env: {
      ...extraEnv,
      HOME: home,
      PATH: process.env.PATH || "/usr/bin",
      ANET_NODE_SECRET_PROBE: "1",
      ANET_NODE_SECRET_PROBE_OUT: probeOut,
      ANET_NODE_SECRET_PROBE_KEY: KEY,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  let parsed: { value: string | null; argv: string[] } | null = null;
  try {
    parsed = JSON.parse(readFileSync(probeOut, "utf8"));
  } catch { /* refused before the probe */ }
  return {
    status: child.status,
    out: `${child.stdout || ""}\n${child.stderr || ""}`,
    child: parsed,
    argv,
  };
}

describe("board #637 startup puts the file into the child env", () => {
  test("fake key reaches the child env and is absent from logs and argv", () => {
    const home = scratch("child");
    const nodeDir = join(home, "proj", ".anet", "nodes", "demo-node");
    mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(nodeDir, "config.json"), JSON.stringify({
      node_id: "n_demo_node",
      node_name: "demo-node",
      alias: "demo-node",
      runtime: "claude-agent-sdk",
      model: "x",
      hub: "http://127.0.0.1:9",
      token: "ntok_demo_placeholder",
    }), { mode: 0o600 });
    writeFileSync(join(nodeDir, NODE_SECRETS_FILE_NAME), `${KEY}="${FILE_SENTINEL}"\n`, { mode: 0o600 });

    const ran = runNode(home, nodeDir, {});
    expect(ran.status).toBe(0);
    expect(ran.child?.value).toBe(FILE_SENTINEL);
    expect(ran.out).not.toContain(FILE_SENTINEL);
    expect(ran.argv.join(" ")).not.toContain(FILE_SENTINEL);
    expect((ran.child?.argv || []).join(" ")).not.toContain(FILE_SENTINEL);
    expect(ran.out).toContain(`loaded=${KEY}`);
  });

  test("an already-set process value wins, and a 0644 file refuses before any child", () => {
    const home = scratch("order");
    const nodeDir = join(home, "proj", ".anet", "nodes", "demo-node");
    mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(nodeDir, "config.json"), JSON.stringify({
      alias: "demo-node",
      runtime: "claude-agent-sdk",
      hub: "http://127.0.0.1:9",
      token: "ntok_demo_placeholder",
    }), { mode: 0o600 });
    const secrets = join(nodeDir, NODE_SECRETS_FILE_NAME);
    writeFileSync(secrets, `${KEY}="${FILE_SENTINEL}"\n`, { mode: 0o600 });

    const kept = runNode(home, nodeDir, { [KEY]: PROCESS_SENTINEL });
    expect(kept.status).toBe(0);
    expect(kept.child?.value).toBe(PROCESS_SENTINEL);
    expect(kept.out).toContain(`kept-from-process=${KEY}`);
    expect(kept.out).not.toContain(FILE_SENTINEL);
    expect(kept.out).not.toContain(PROCESS_SENTINEL);
    expect((kept.child?.argv || []).join(" ")).not.toContain(FILE_SENTINEL);
    expect((kept.child?.argv || []).join(" ")).not.toContain(PROCESS_SENTINEL);

    chmodSync(secrets, 0o644);
    const refused = runNode(home, nodeDir, {});
    expect(refused.status).not.toBe(0);
    expect(refused.child).toBeNull();
    expect(refused.out).toContain("want 0600");
    expect(refused.out).not.toContain(FILE_SENTINEL);
  });
});
