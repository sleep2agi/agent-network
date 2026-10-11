import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findOwnedOpenCodeNodeDir, handleOpenCodeCatalogDoorbell } from "./opencode-catalog-dispatch";
import { writeOpenCodeV2CatalogEndpoint } from "./opencode-v2-catalog-endpoint";

function tree(nodeId = "node_child") {
  const daemonWorkDir = mkdtempSync(join(tmpdir(), "oc-dispatch-"));
  const nodeDir = join(daemonWorkDir, ".anet", "nodes", "child-a");
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(nodeDir, "config.json"), JSON.stringify({ node_id: nodeId, settings: { apiKey: "sk-FAKE" } }));
  return { daemonWorkDir, nodeDir, project: resolve(daemonWorkDir) };
}

test("doorbell reads the owned loopback and acks a whitelist snapshot", async () => {
  const { daemonWorkDir, nodeDir, project } = tree();
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    requests++;
    const url = new URL(req.url);
    expect(url.searchParams.get("directory")).toBe(project);
    const row = url.pathname === "/api/model/default" ? { providerID: "custom", id: "m" } : url.pathname === "/api/model"
      ? [{ providerID: "custom", id: "m" }] : [{ id: "custom", activation: "enabled", settings: { apiKey: "sk-FAKE" } }];
    return Response.json({ location: { directory: project }, data: row });
  } });
  const calls: Array<{ tool: string; args: any }> = [];
  try {
    writeOpenCodeV2CatalogEndpoint(nodeDir, { url: `http://127.0.0.1:${server.port}`, authorization: "Basic fake", directory: project });
    await handleOpenCodeCatalogDoorbell({ request_id: "cat_1" }, {
      daemonWorkDir,
      log() {},
      warn() {},
      async callCommHub(tool, args) {
        calls.push({ tool, args });
        if (tool === "get_opencode_catalog_request") {
          return { ok: true, request_id: "cat_1", node_id: "node_child", alias: "child-a", directory: project, scope: { networkId: "net", daemonId: "daemon" } };
        }
        return { ok: true, status: "ready" };
      },
    });
    expect(calls.map(call => call.tool)).toEqual(["get_opencode_catalog_request", "ack_opencode_catalog"]);
    expect(calls[1]!.args.snapshot.invocationVerified).toBe(false);
    expect(calls[1]!.args.snapshot.completeness).toBe("unknown");
    expect(JSON.stringify(calls[1]!.args)).not.toContain("Basic");
    expect(JSON.stringify(calls[1]!.args)).not.toContain("sk-FAKE");
    expect(requests).toBe(3);
  } finally {
    server.stop(true);
    rmSync(daemonWorkDir, { recursive: true, force: true });
  }
});

test("missing endpoint and a directory mismatch ack an error without a fetch", async () => {
  const { daemonWorkDir, nodeDir, project } = tree();
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { requests++; return new Response("no"); } });
  const acks: any[] = [];
  try {
    await handleOpenCodeCatalogDoorbell({ request_id: "cat_missing" }, {
      daemonWorkDir,
      log() {},
      warn() {},
      async callCommHub(tool, args) {
        if (tool === "ack_opencode_catalog") acks.push(args);
        return tool === "get_opencode_catalog_request"
          ? { ok: true, node_id: "node_child", alias: "child-a", directory: project, scope: { networkId: "net", daemonId: "daemon" } }
          : { ok: true, status: "failed" };
      },
    });
    expect(acks).toEqual([{ request_id: "cat_missing", error: "unavailable" }]);
    expect(requests).toBe(0);

    writeOpenCodeV2CatalogEndpoint(nodeDir, { url: `http://127.0.0.1:${server.port}`, authorization: "Basic fake", directory: project });
    await handleOpenCodeCatalogDoorbell({ request_id: "cat_scope" }, {
      daemonWorkDir,
      log() {},
      warn() {},
      async callCommHub(tool, args) {
        if (tool === "ack_opencode_catalog") acks.push(args);
        return tool === "get_opencode_catalog_request"
          ? { ok: true, node_id: "node_child", alias: "child-a", directory: "/tmp/other-project", scope: { networkId: "net", daemonId: "daemon" } }
          : { ok: true, status: "failed" };
      },
    });
    expect(acks[1]).toEqual({ request_id: "cat_scope", error: "scope_mismatch" });
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
    rmSync(daemonWorkDir, { recursive: true, force: true });
  }
});

test("a pull failure is not acked, and the dispatcher does not spawn", async () => {
  const source = readFileSync(join(import.meta.dir, "opencode-catalog-dispatch.ts"), "utf8");
  expect(source).not.toContain("spawn(");
  expect(source).not.toContain("child_process");
  const cli = readFileSync(join(import.meta.dir, "../cli.ts"), "utf8");
  expect(cli).toContain('ev.type === "opencode_catalog"');
  expect(cli).toContain("handleOpenCodeCatalogDoorbell");
  const calls: string[] = [];
  await handleOpenCodeCatalogDoorbell({ request_id: "cat_pull" }, {
    daemonWorkDir: "/tmp/does-not-matter",
    log() {},
    warn() {},
    async callCommHub(tool) {
      calls.push(tool);
      throw new Error("hub down");
    },
  });
  expect(calls).toEqual(["get_opencode_catalog_request"]);
});

test("symlink node directories are not an owned match", () => {
  const { daemonWorkDir, nodeDir } = tree();
  try {
    symlinkSync(nodeDir, join(daemonWorkDir, ".anet", "nodes", "linked"));
    expect(findOwnedOpenCodeNodeDir(daemonWorkDir, "child-a", "node_child")).toBe(nodeDir);
    rmSync(nodeDir, { recursive: true, force: true });
    expect(findOwnedOpenCodeNodeDir(daemonWorkDir, "child-a", "node_child")).toBeNull();
  } finally { rmSync(daemonWorkDir, { recursive: true, force: true }); }
});
