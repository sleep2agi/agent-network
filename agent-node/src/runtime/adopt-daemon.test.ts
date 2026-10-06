import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAdoptDoorbell, handleUnadoptDoorbell } from "./adopt-daemon.js";
import { adoptedChild, readWorkdirRegistry } from "./adopt-registry.js";
import { recordChildWorkdir, forgetChildWorkdir } from "./child-workdir.js";
import { readAdoptionProc } from "./adopt-proc.js";
import { handleStopDoorbell } from "./stop-daemon.js";
import { handleStartDoorbell } from "./start-daemon.js";
import { CommHubError } from "../reply-reliability.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adopt-protocol-")); roots.push(root);
  const home = join(root, "home"), workdir = join(home, "project"), daemon = join(home, "supervisor");
  const nodeDir = join(workdir, ".anet/nodes/fixture");
  mkdirSync(nodeDir, { recursive: true, mode: 0o700 }); mkdirSync(daemon, { recursive: true });
  const req = { ok: true, request_id: "request_fixture", node_id: "n_fixture", alias: "fixture", network_id: "net_fixture", workdir };
  writeFileSync(join(nodeDir, "config.json"), JSON.stringify({ node_id: req.node_id, alias: req.alias, network_id: req.network_id, hub: "http://127.0.0.1:9999" }), { mode: 0o600 });
  const calls: any[] = [];
  const deps = { home, workDir: daemon, hubUrl: "http://127.0.0.1:9999", networkId: req.network_id,
    adoptRoots: [home], uid: process.getuid!(), daemonEnv: {}, warn: () => {},
    callCommHub: async (tool: string, args: any) => { calls.push({ tool, args }); return tool === "get_adopt_request" ? req : { ok: true }; } };
  return { req, deps, nodeDir, calls };
}
test("authenticated request persists before ack; ordinary registry writes preserve adopted entries", async () => {
  const f = fixture();
  const call = f.deps.callCommHub;
  f.deps.callCommHub = async (tool, args) => {
    if (tool === "ack_adopt_request") expect(adoptedChild(f.deps.workDir, "fixture")?.request_id).toBe(f.req.request_id);
    return call(tool, args);
  };
  await handleAdoptDoorbell(f.req, f.deps);
  expect(f.calls.at(-1).args.status).toBe("adopted");
  recordChildWorkdir(f.deps.workDir, "created", "/fixture/created");
  forgetChildWorkdir(f.deps.workDir, "created");
  expect(adoptedChild(f.deps.workDir, "fixture")?.node_id).toBe("n_fixture");
});
test("Hub rejected ack rolls back only this request", async () => {
  const f = fixture();
  f.deps.callCommHub = async tool => tool === "get_adopt_request" ? f.req : { ok: false };
  await handleAdoptDoorbell(f.req, f.deps);
  expect(Object.keys(readWorkdirRegistry(f.deps.workDir))).toHaveLength(0);
});
test("revocation before registration then real app-level ack rejection rolls back", async () => {
  const f = fixture();
  f.deps.callCommHub = async (tool, args) => {
    if (tool === "get_adopt_request") {
      // get returned a pending snapshot while revoke's doorbell ran before write.
      await handleUnadoptDoorbell(f.req, f.deps);
      return f.req;
    }
    if (tool === "list_my_children") return { ok: true, children: [] };
    if (tool === "ack_adopt_request") {
      expect(adoptedChild(f.deps.workDir, "fixture")).not.toBeNull();
      throw new CommHubError("request_not_pending", { code: "request_not_pending", appLevel: true });
    }
    throw Error(`unexpected tool ${tool}`);
  };
  await expect(handleAdoptDoorbell(f.req, f.deps)).rejects.toThrow("request_not_pending");
  expect(adoptedChild(f.deps.workDir, "fixture")).toBeNull();
  const next = { ...f.req, request_id: "next_request" };
  f.deps.callCommHub = async tool => tool === "get_adopt_request" ? next : { ok: true };
  await handleAdoptDoorbell(next, f.deps);
  expect(adoptedChild(f.deps.workDir, "fixture")?.request_id).toBe(next.request_id);
});
test("unknown ack transport outcome keeps evidence, not guessed rollback", async () => {
  const f = fixture();
  f.deps.callCommHub = async tool => {
    if (tool === "get_adopt_request") return f.req;
    throw new CommHubError("connection lost", { appLevel: false });
  };
  await expect(handleAdoptDoorbell(f.req, f.deps)).rejects.toThrow("connection lost");
  expect(adoptedChild(f.deps.workDir, "fixture")?.request_id).toBe(f.req.request_id);
});
test("unauthenticated doorbell cannot write; empty roots refuses", async () => {
  const f = fixture();
  f.deps.adoptRoots = [];
  await handleAdoptDoorbell(f.req, f.deps);
  expect(f.calls.at(-1).args).toMatchObject({ status: "refused", error: "adopt_roots_not_configured" });
  expect(adoptedChild(f.deps.workDir, "fixture")).toBeNull();
  f.deps.callCommHub = async () => ({ ok: false });
  await handleAdoptDoorbell(f.req, f.deps);
  expect(adoptedChild(f.deps.workDir, "fixture")).toBeNull();
});
test("live process birth changes between checks refuse without registration", async () => {
  const f = fixture(); writeFileSync(join(f.nodeDir, ".pid"), "12345", { mode: 0o600 });
  let reads = 0;
  await handleAdoptDoorbell(f.req, { ...f.deps, readProc: () => ({
    pid: 12345, birth: String(++reads), uid: f.deps.uid, cwd: f.req.workdir,
    argv: ["/usr/bin/agent-node", "--alias", "fixture", "--config", join(f.nodeDir, "config.json")], env: { HOME: f.deps.home },
  }) });
  expect(reads).toBe(2);
  expect(f.calls.at(-1).args).toMatchObject({ status: "refused", error: "adopt_process_changed" });
  expect(adoptedChild(f.deps.workDir, "fixture")).toBeNull();
});
test("unadopt notification requires Hub confirmation and exact request", async () => {
  const f = fixture(); await handleAdoptDoorbell(f.req, f.deps);
  f.deps.callCommHub = async () => ({ ok: true, children: [{ child_node_id: f.req.node_id, managed: "adopted" }] });
  await handleUnadoptDoorbell(f.req, f.deps);
  expect(adoptedChild(f.deps.workDir, "fixture")).not.toBeNull();
  f.deps.callCommHub = async () => ({ ok: true, children: [] });
  await handleUnadoptDoorbell({ ...f.req, request_id: "stale" }, f.deps);
  expect(adoptedChild(f.deps.workDir, "fixture")).not.toBeNull();
  await handleUnadoptDoorbell(f.req, f.deps);
  expect(adoptedChild(f.deps.workDir, "fixture")).toBeNull();
});
test("real proc evidence reads current isolated test process", () => {
  const proc = readAdoptionProc(process.pid);
  expect(proc?.pid).toBe(process.pid);
  expect(proc?.uid).toBe(process.getuid!());
  expect(proc?.birth).toMatch(/^\d+$/);
});
test("adopted registry never falls through created-child stop/start", async () => {
  const f = fixture(); await handleAdoptDoorbell(f.req, f.deps);
  const calls: any[] = [];
  const callCommHub = async (tool: string, args: any) => {
    calls.push({ tool, args });
    return { ok: true, child_node_id: f.req.node_id, child_alias: f.req.alias, action: "stop" };
  };
  await handleStopDoorbell({ request_id: "stop_fixture" }, { workDir: f.deps.workDir, callCommHub, log: () => {}, warn: () => {},
    signalProcess: () => { throw Error("must not signal adopted process"); } });
  expect(calls.at(-1).args).toMatchObject({ status: "stop_failed", error: "adopted_lifecycle_not_available" });
  await handleStartDoorbell({ request_id: "start_fixture" }, { workDir: f.deps.workDir, callCommHub, log: () => {}, warn: () => {} });
  expect(calls.at(-1).args).toMatchObject({ status: "start_failed", error: "adopted_lifecycle_not_available" });
});
