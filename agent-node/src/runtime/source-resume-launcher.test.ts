import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createSourceResumeLauncher, verifySourceResumeLauncher, checkSourceResume, recoverSourceResumeLaunch, SOURCE_RESUME_HEALTH, type SourceResumeChild } from "./source-resume-launcher";
import { spawn } from "node:child_process";
const fixture = resolve(import.meta.dir, "fixtures/source-resume-child.ts");
let roots: string[] = [], children: SourceResumeChild[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const child of children) await child.stop(); children = [];
  for (const s of servers) s.stop(true); servers = [];
  for (const root of roots) rmSync(root, { recursive: true, force: true }); roots = [];
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "source-native-launch-")); roots.push(root);
  const dir = join(root, ".anet", "nodes", "child"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  let version = "2.0.22", busy = false, registered = 0, bridgePid = 0; const requests: string[] = [];
  const password = "synthetic-only", token = "ntok_synthetic_only";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(r) {
    const path = new URL(r.url).pathname; requests.push(`${r.method} ${path}`);
    if (path === "/fixture-register") {
      const b: any = await r.json();
      if (r.headers.get("authorization") !== `Bearer ${token}` || b.node_id !== "node_fixture"
        || b.session_id !== "ses_Child" || b.alias !== "child") return new Response("", { status: 403 });
      registered++; bridgePid = b.bridge_pid; return Response.json({ ok: true });
    }
    if (r.headers.get("authorization") !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`) return new Response("", { status: 401 });
    if (r.method !== "GET") return new Response("no writes", { status: 405 });
    if (path === "/api/info") return Response.json({ version, pid: process.pid });
    if (path === "/api/session/active") return Response.json({ data: busy ? { ses_Child: { type: "running" } } : {} });
    if (path === "/api/session/ses_Child") return Response.json({ data: { id: "ses_Child", location: { directory: root }, model: { providerID: "stub", id: "model" } } });
    return Response.json({ data: {} });
  } }); servers.push(server);
  const url = `http://127.0.0.1:${server.port}`;
  const configPath = join(dir, "config.json"), passwordFile = join(dir, "source-server-password");
  const c = { node_id: "node_fixture", alias: "child", runtime: "opencode-cli", opencodeGeneration: "v2", opencodeMode: "copresence",
    flags: { opencodeUnsafeTools: true }, model: "stub/model", token, sessionId: "ses_Child", hub: url,
    opencodeSharedServerUrl: url, opencodeSharedServerPasswordFile: passwordFile,
    sourceDelivery: { delivery_id: "fixture-delivery", execution_id: "fixture-execution", expires_at: Date.now() + 30_000,
      server_pid: process.pid, resume_only: true, expected_version: "2.0.22" } };
  const save = () => writeFileSync(configPath, JSON.stringify(c), { mode: 0o600 }); save();
  writeFileSync(passwordFile, password, { mode: 0o600 });
  writeFileSync(join(dir, "source-delivery-claim.json"), JSON.stringify({ delivery_id: c.sourceDelivery.delivery_id,
    execution_id: c.sourceDelivery.execution_id, session_id: c.sessionId, child_node_id: c.node_id }), { mode: 0o600 });
  const input = { configPath, cwd: root, existingSessionId: "ses_Child", resumeSessionId: "ses_Child",
    newSession: false as const, expectedVersion: "2.0.22" as const, bridgePolicy: "new_child_only" as const };
  const launcher = (extra: Record<string, string> = {}, timeoutMs = 3000) => createSourceResumeLauncher({ command: process.execPath,
    argsPrefix: [fixture], env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: root, ...extra }, timeoutMs });
  return { root, dir, c, save, input, launcher, requests, server, registered: () => registered, bridgePid: () => bridgePid,
    version: (v: string) => version = v, busy: () => busy = true };
}
test("concrete spawn launches synthetic child through real V2 shared resume core, health and credential registration; stop preserves Server/source", async () => {
  const p = setup();
  const owner = join(p.root, ".anet", "nodes", "source"); mkdirSync(owner, { mode: 0o700 });
  const sourceHealth = JSON.stringify({ generation: "ses_Source", bridge: { pid: process.pid } });
  writeFileSync(join(owner, "opencode-launch-health.json"), sourceHealth, { mode: 0o600 });
  const child = await p.launcher()(p.input); children.push(child);
  expect(child.pid).not.toBe(process.pid); expect(p.registered()).toBe(1);
  const health = JSON.parse(readFileSync(join(p.dir, SOURCE_RESUME_HEALTH), "utf8"));
  expect(health.session_id).toBe("ses_Child"); expect(health.registered).toBe(true);
  expect(existsSync(join(p.dir, "opencode-attach.sh"))).toBe(true);
  expect(recoverSourceResumeLaunch(p.input.configPath).status).toBe("local_registration_receipt");
  expect(p.requests.filter(r => r.startsWith("POST /api/"))).toEqual([]);
  await child.stop();
  expect(() => process.kill(child.pid, 0)).toThrow();
  expect(readFileSync(join(owner, "opencode-launch-health.json"), "utf8")).toBe(sourceHealth);
  expect(await checkSourceResume(p.input.configPath, p.root)).toBeTruthy();
  await expect(p.launcher()(p.input)).rejects.toThrow(); // persisted claim forbids relaunch
  expect(p.registered()).toBe(1);
  expect(() => process.kill(p.bridgePid(), 0)).toThrow();
  expect(recoverSourceResumeLaunch(p.input.configPath).status).toBe("unknown_rotation_required");
});
test("wrong exact session/new flag/version/busy/expired credential/live child owner reject before spawn", async () => {
  const p = setup();
  await expect(verifySourceResumeLauncher({ command: process.execPath, env: {} })).rejects.toThrow("capability_required");
  await expect(p.launcher()({ ...p.input, existingSessionId: "ses_Other" })).rejects.toThrow();
  await expect(p.launcher()({ ...p.input, newSession: true as any })).rejects.toThrow();
  p.version("2.0.99"); await expect(p.launcher()(p.input)).rejects.toThrow("version"); p.version("2.0.22");
  p.c.sourceDelivery.server_pid++; p.save(); await expect(p.launcher()(p.input)).rejects.toThrow("server_changed");
  p.c.sourceDelivery.server_pid = process.pid; p.c.flags.opencodeUnsafeTools = false; p.save();
  await expect(p.launcher()(p.input)).rejects.toThrow("opt_in"); p.c.flags.opencodeUnsafeTools = true; p.save();
  writeFileSync(join(p.dir, "opencode-launch-health.json"), JSON.stringify({ generation: "ses_Child", bridge: { pid: process.pid } }), { mode: 0o600 });
  await expect(p.launcher()(p.input)).rejects.toThrow("owned");
  rmSync(join(p.dir, "opencode-launch-health.json"));
  p.busy(); await expect(p.launcher()(p.input)).rejects.toThrow("busy");
  p.c.sourceDelivery.expires_at = Date.now() - 1; p.save();
  await expect(p.launcher()(p.input)).rejects.toThrow();
  expect(p.registered()).toBe(0); expect(existsSync(join(p.dir, "source-resume-launch-claim.json"))).toBe(false);
  expect(p.requests.some(r => r.startsWith("POST /api/"))).toBe(false);
});
test("actual anet CLI source-only branch fails closed without locally installed exact native package; no fallback", async () => {
  const p = setup();
  // Source path relative to agent-node/src/runtime -> repository root.
  const realCli = resolve(import.meta.dir, "../../../agent-network/bin/cli.ts");
  const child = spawn(process.execPath, [realCli, "node", "start", "child"], { cwd: p.root,
    env: { PATH: "/usr/bin:/bin", HOME: p.root, ANET_SOURCE_RESUME_CONFIG: p.input.configPath,
      ANET_SOURCE_RESUME_NONCE: "11111111-1111-4111-8111-111111111111" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout!.on("data", b => output += b); child.stderr!.on("data", b => output += b);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const code = await new Promise<number | null>(r => child.once("exit", r)); clearTimeout(timer);
  expect(code).not.toBe(0);
  expect(output).toContain("source_resume_cli_version_refused");
  expect(output).not.toContain(p.c.token);
  expect(p.registered()).toBe(0);
  expect(p.requests.some(r => r.startsWith("POST /api/"))).toBe(false);
});
test("lost health ACK stops only the newly spawned child, retains durable unknown/no-relaunch claim", async () => {
  const p = setup();
  await expect(p.launcher({ SOURCE_TEST_DROP_HEALTH: "1" }, 700)(p.input)).rejects.toThrow("unconfirmed");
  expect(p.registered()).toBe(1);
  expect(() => process.kill(p.bridgePid(), 0)).toThrow();
  expect(existsSync(join(p.dir, "source-resume-launch-claim.json"))).toBe(true);
  await expect(p.launcher()(p.input)).rejects.toThrow();
  expect(p.registered()).toBe(1);
  expect(p.requests.some(r => r.startsWith("POST /api/"))).toBe(false);
});
