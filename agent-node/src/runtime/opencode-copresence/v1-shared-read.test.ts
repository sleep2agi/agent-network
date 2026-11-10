import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createV1SharedReadClient, V1SharedBindingError, type V1SharedSessionBinding } from "./v1-shared-read";
import { fetchOpenCodeJson } from "./http";

test("HTTP contract: exact immutable binding, encoded directory, foreign reads and no fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "v1-shared-read-"));
  const directory = join(root, "目录 A"); mkdirSync(directory);
  const calls: Array<{ path: string; dir: string | null; method: string }> = [];
  let mode = "own";
  const id = "ses_exact1207";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    calls.push({ path, dir: request.headers.get("x-opencode-directory"), method: request.method });
    if (request.headers.get("authorization") !== `Basic ${Buffer.from("opencode:synthetic1207").toString("base64")}`) return new Response(null, { status: 401 });
    if (path === "/global/health") return Response.json({ healthy: true, version: mode === "wrong-version" ? "2.0.22" : "1.18.34" });
    if (mode === "redirect") return Response.redirect(`http://127.0.0.1:${server.port}/forbidden`, 302);
    if (mode === "missing") return new Response(null, { status: 404 });
    if (path.endsWith("/message")) return Response.json([{ info: { sessionID: mode === "foreign-history" ? "ses_other" : id }, parts: [{ sessionID: id, type: "text", text: "synthetic" }] }]);
    return Response.json({ id: mode === "wrong-id" ? "ses_other" : id, directory: mode === "foreign" ? root : directory });
  } });
  try {
    const binding: V1SharedSessionBinding = { networkId: "net_test", nodeId: "n_test", serverIdentity: "host-generation-1", directory, sessionId: id };
    const descriptor = { identity: binding.serverIdentity, generation: "v1" as const, packageName: "opencode-ai" as const, version: "1.18.34", url: `http://127.0.0.1:${server.port}`, password: "synthetic1207" };
    for (const key of ["networkId", "nodeId", "serverIdentity", "directory", "sessionId"] as const) {
      expect(() => createV1SharedReadClient(descriptor, binding, { ...binding, [key]: "foreign" })).toThrow(V1SharedBindingError);
    }
    expect(calls).toHaveLength(0);
    for (const change of [{ identity: "other" }, { version: "2.0.22" }, { url: "http://example.invalid" }, { url: "http://user:secret@127.0.0.1" }, { generation: "v2" }, { packageName: "@opencode/cli" }]) {
      expect(() => createV1SharedReadClient({ ...descriptor, ...change } as any, binding, binding)).toThrow(V1SharedBindingError);
    }
    const link = join(root, "link"); symlinkSync(directory, link);
    expect(() => createV1SharedReadClient(descriptor, { ...binding, directory: link }, { ...binding, directory: link })).toThrow(V1SharedBindingError);
    const client = createV1SharedReadClient(descriptor, binding, { ...binding });
    // Mutating a caller-owned descriptor/record must not retarget the client.
    descriptor.url = "http://example.invalid";
    (binding as any).nodeId = "n_changed";
    expect((await client.readSession()).id).toBe(id);
    expect((await client.readMessages())[0].info.sessionID).toBe(id);
    expect(calls.every(call => decodeURIComponent(call.dir!) === directory && call.method === "GET")).toBe(true);
    for (const value of ["foreign", "wrong-id", "wrong-version", "foreign-history"]) {
      mode = value;
      await expect(client.readMessages()).rejects.toBeInstanceOf(V1SharedBindingError);
    }
    mode = "missing";
    await expect(client.readSession()).rejects.toThrow("HTTP 404");
    mode = "redirect";
    await expect(client.readSession()).rejects.toThrow();
    expect(calls.some(call => call.path === "/forbidden")).toBe(false);
    expect(calls.every(call => call.path === "/global/health" || call.path === `/session/${id}` || call.path === `/session/${id}/message`)).toBe(true);
    // Existing owned HTTP keeps its old unscoped request behavior.
    mode = "own";
    await fetchOpenCodeJson(`http://127.0.0.1:${server.port}`, "synthetic1207", "/global/health");
    expect(calls.at(-1)?.dir).toBeNull();
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
