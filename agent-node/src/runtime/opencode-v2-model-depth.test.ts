import { afterEach, expect, test } from "bun:test";
import { readOpenCodeModelDepth } from "./opencode-v2-catalog";

const directory = "/fixture";
const sessionId = "ses_fixture";
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

function fixture(options: { version?: string; model?: unknown; changed?: boolean; wrongScope?: boolean } = {}) {
  let reads = 0;
  const paths: string[] = [];
  const wrap = (data: unknown) => ({ location: { directory }, data });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(request.headers.get("authorization")).toBe("Basic fixture");
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path === "/api/info") return Response.json({ version: options.version ?? "2.0.22" });
    if (path === "/api/provider") return Response.json(wrap([{ id: "fixture", activation: "enabled" }]));
    if (path === "/api/model") return Response.json(wrap([{ providerID: "fixture", id: "nested/model", variants: [{ id: "low" }, { id: "high" }] }]));
    if (path === "/api/model/default") return Response.json(wrap({ providerID: "fixture", id: "nested/model" }));
    reads++;
    const model = "model" in options ? options.model : { providerID: "fixture", id: "nested/model", variant: options.changed && reads > 1 ? "low" : "high" };
    return Response.json({ data: { id: sessionId, location: { directory: options.wrongScope ? "/other" : directory }, ...(model === undefined ? {} : { model }) } });
  } });
  return { opts: { scope: { networkId: "n", daemonId: "d", directory }, url: server.url.origin, authorization: "Basic fixture", sessionId }, paths };
}

test("prints runtime catalog depths and current session selection without secrets", async () => {
  const { opts } = fixture();
  const result = await readOpenCodeModelDepth(opts);
  expect(result.runtimeVersion).toBe("2.0.22");
  expect(result.models).toEqual([{ provider: "fixture", model: "nested/model", availableDepths: ["low", "high"] }]);
  expect(result.current).toEqual({ provider: "fixture", model: "nested/model", depth: "high" });
  expect(JSON.stringify(result)).not.toContain("Basic fixture");
  expect(result.invocationVerified).toBe(false);
});

test("version mismatch is readable and refuses before catalog or session reads", async () => {
  const { opts, paths } = fixture({ version: "2.0.23" });
  await expect(readOpenCodeModelDepth(opts)).rejects.toThrow("requires @opencode/cli 2.0.22; server reports 2.0.23");
  expect(paths).toEqual(["/api/info"]);
});

test("missing selection is unknown, not directory default", async () => {
  const { opts } = fixture({ model: undefined });
  expect((await readOpenCodeModelDepth(opts)).current).toBeNull();
});

test("missing depth is null, never an invented default", async () => {
  const { opts } = fixture({ model: { providerID: "fixture", id: "nested/model" } });
  expect((await readOpenCodeModelDepth(opts)).current?.depth).toBeNull();
});

test("rejects another session workspace", async () => {
  const { opts } = fixture({ wrongScope: true });
  await expect(readOpenCodeModelDepth(opts)).rejects.toThrow("scope_mismatch");
});

test("refuses mixed readback when selection changes", async () => {
  const { opts } = fixture({ changed: true });
  await expect(readOpenCodeModelDepth(opts)).rejects.toThrow("changed during read");
});

test("rejects malformed current selection rather than defaulting", async () => {
  const { opts } = fixture({ model: { providerID: "fixture", id: "nested/model", variant: 2 } });
  await expect(readOpenCodeModelDepth(opts)).rejects.toThrow("invalid_response");
});

test("never prints a secret-shaped selection ID", async () => {
  const { opts } = fixture({ model: { providerID: "fixture", id: "sk-secret-value", variant: "high" } });
  await expect(readOpenCodeModelDepth(opts)).rejects.toThrow("invalid_response");
});
