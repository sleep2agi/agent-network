import { test, expect } from "bun:test";
import { normalizeOpenCodeCatalog, readOpenCodeCatalog } from "./opencode-v2-catalog";

const scope = { networkId: "net-fixture", daemonId: "daemon-a", directory: "/workspace" };
const wrap = (data: unknown, directory = scope.directory) => ({ location: { directory }, data });
const providers = [{ id: "custom", activation: "enabled", headers: { Authorization: "sk-FAKE-hidden" }, settings: { apiKey: "sk-FAKE-hidden" } }, { id: "second", activation: "auto" }];
const models = [{ providerID: "custom", id: "nested/model", headers: { key: "sk-FAKE-hidden" } }, { providerID: "second", id: "nested/model" }];
const normalize = (p: unknown = wrap(providers), m: unknown = wrap(models), d: unknown = wrap(models[0])) => normalizeOpenCodeCatalog(scope, p, m, d, "2026-10-11T00:00:00Z");

test("native IDs, distinct provider/model identity, counts and default survive without arbitrary fields", () => {
  const value = normalize();
  expect(value.models).toHaveLength(2);
  expect(value.providers).toHaveLength(2);
  expect(value.defaultModel).toEqual({ providerId: "custom", id: "nested/model" });
  expect(value.invocationVerified).toBe(false);
  expect(value.completeness).toBe("unknown");
  expect(JSON.stringify(value)).not.toContain("sk-FAKE-hidden");
  expect(JSON.stringify(value)).not.toContain("headers");
});
test("empty snapshot is not verified empty/full availability", () => {
  const value = normalize(wrap([]), wrap([]), wrap(undefined));
  expect(value.models).toEqual([]);
  expect(value.defaultModel).toBeNull();
  expect(value.state).toBe("snapshot");
  expect(value.completeness).toBe("unknown");
});
test("all three native responses must refer to requested directory", () => {
  for (const which of [0, 1, 2]) {
    const responses = [wrap(providers), wrap(models), wrap(models[0])];
    responses[which].location.directory = "/another-project";
    expect(() => normalize(...responses as [unknown, unknown, unknown])).toThrow("scope_mismatch");
  }
});
test("inconsistent snapshots, duplicates, malformed rows, secret-shaped IDs fail rather than truncate", () => {
  expect(() => normalize(wrap([]))).toThrow("invalid_response");
  expect(() => normalize(wrap([...providers, providers[0]]))).toThrow("invalid_response");
  expect(() => normalize(undefined, wrap([...models, models[0]]))).toThrow("invalid_response");
  expect(() => normalize(undefined, undefined, wrap({ providerID: "custom", id: "missing" }))).toThrow("invalid_response");
  expect(() => normalize(wrap([{ id: "sk-secret", activation: "auto" }]))).toThrow("invalid_response");
  expect(() => normalize(undefined, wrap([null]))).toThrow("invalid_response");
  expect(() => normalize(wrap(new Array(20_001).fill(providers[0])))).toThrow("too_large");
});
test("target validation never reaches a remote host", async () => {
  for (const url of ["https://example.com", "http://localhost:9", "http://127.0.0.1:9/path", "http://user:secret@127.0.0.1", "http://127.0.0.1:9/?token=secret"]) {
    await expect(readOpenCodeCatalog({ scope, url, authorization: "Basic fake" })).rejects.toThrow("invalid_target");
  }
});
test("authenticated local API fetch preserves scope and rejects auth failures without echo", async () => {
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    requests++;
    if (req.headers.get("authorization") !== "Basic fake") return new Response("sk-FAKE-hidden", { status: 401 });
    const url = new URL(req.url);
    expect(url.searchParams.get("directory")).toBe(scope.directory);
    return Response.json(wrap(url.pathname === "/api/provider" ? providers : url.pathname === "/api/model" ? models : models[0]));
  } });
  try {
    const args = { scope, url: `http://127.0.0.1:${server.port}`, authorization: "Basic fake" };
    expect((await readOpenCodeCatalog(args)).scope).toEqual(scope);
    expect(requests).toBe(3);
    await expect(readOpenCodeCatalog({ ...args, authorization: "Basic wrong" })).rejects.toThrow("unauthorized");
  } finally { server.stop(true); }
});
test("redirect and oversized bodies fail closed", async () => {
  let mode = "redirect";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    return mode === "redirect" ? new Response(null, { status: 302, headers: { location: "http://example.com" } }) : new Response("x".repeat(2 * 1024 * 1024 + 1));
  } });
  try {
    const args = { scope, url: `http://127.0.0.1:${server.port}`, authorization: "Basic fake" };
    await expect(readOpenCodeCatalog(args)).rejects.toThrow("unavailable");
    mode = "oversized";
    await expect(readOpenCodeCatalog(args)).rejects.toThrow("too_large");
  } finally { server.stop(true); }
});
test("deadline ends hung reads and retains no previous daemon snapshot", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
  try {
    const before = Date.now();
    await expect(readOpenCodeCatalog({ scope, url: `http://127.0.0.1:${server.port}`, authorization: "Basic fake", timeoutMs: 40 })).rejects.toThrow("unavailable");
    expect(Date.now() - before).toBeLessThan(1000);
  } finally { server.stop(true); }
});
