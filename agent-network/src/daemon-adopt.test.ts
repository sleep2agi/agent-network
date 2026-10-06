import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemonAdopt } from "./daemon-adopt.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adopt-cli-")); roots.push(root);
  const dir = join(root, ".anet/nodes/local"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ alias: "demo", node_id: "n_demo", network_id: "net_demo", hub: "http://fixture" }));
  const writes: any[] = [], lines: string[] = [];
  const deps = { cwd: root, home: root, login: { hub: "http://fixture", token: "utok_fixture", network_id: "net_demo" }, print: (s: string) => lines.push(s),
    fetch: (async (url: any, opts: any) => {
      if (opts.method === "POST") { writes.push(JSON.parse(opts.body)); return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ ok: true, request_id: "r_demo" }) }] } }); }
      return Response.json(String(url).includes("host-supervisors") ? { daemons: [{ daemon_node_id: "n_supervisor", alias: "supervisor", hostname: "fixture" }] } : { nodes: [{ node_id: "n_demo", alias: "demo", hostname: "fixture" }] });
    }) as typeof fetch };
  return { deps, writes, lines };
}
test("plan never writes; yes submits exact identity and workdir", async () => {
  const f = fixture(); expect(await runDaemonAdopt("adopt", ["demo"], f.deps)).toBe(0);
  expect(f.writes).toHaveLength(0);
  expect(await runDaemonAdopt("adopt", ["demo", "--yes"], f.deps)).toBe(0);
  expect(f.writes[0].params).toEqual({ name: "request_adopt_node", arguments: { node_id: "n_demo", daemon_node_id: "n_supervisor", workdir: f.deps.cwd, network_id: "net_demo" } });
  expect(f.lines.at(-1)).toContain("Not yet adopted");
});
test("node login and invalid flags refuse before write", async () => {
  const f = fixture(); f.deps.login.token = "ntok_fixture";
  expect(await runDaemonAdopt("adopt", ["demo", "--yes"], f.deps)).toBe(1);
  expect(await runDaemonAdopt("adopt", ["demo", "--all", "--yes"], f.deps)).toBe(2);
  expect(f.writes).toHaveLength(0);
});
test("unadopt default is plan; yes invokes Hub without any process action", async () => {
  const f = fixture(); expect(await runDaemonAdopt("unadopt", ["demo"], f.deps)).toBe(0);
  expect(f.writes).toHaveLength(0);
  expect(await runDaemonAdopt("unadopt", ["demo", "--yes"], f.deps)).toBe(0);
  expect(f.writes[0].params.name).toBe("unadopt_node");
});
