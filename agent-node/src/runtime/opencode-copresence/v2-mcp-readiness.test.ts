import { afterEach, expect, test } from "bun:test";
import { waitForOpenCodeV2Commhub } from "./v2-session";

const Bun: any = (globalThis as any).Bun;
let server: any;
afterEach(() => server?.stop(true));
function serve(body: () => unknown, status = 200) {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req: Request) {
    expect(new URL(req.url).pathname).toBe("/api/mcp");
    expect(req.headers.get("authorization")).toBe("Basic " + Buffer.from("opencode:test").toString("base64"));
    return Response.json(body(), { status });
  } });
  return `http://127.0.0.1:${server.port}`;
}
test("missing then pending then connected; no model warmup", async () => {
  let calls = 0;
  const url = serve(() => ({ data: ++calls === 1 ? [] : [{ name: "commhub", status: { status: calls === 2 ? "pending" : "connected" } }] }));
  await waitForOpenCodeV2Commhub(url, "test", 2000);
  expect(calls).toBe(3);
});
for (const status of ["failed", "needs_auth", "disabled", "invented-state"]) {
  test(`${status} fails closed without reflecting upstream secrets`, async () => {
    const url = serve(() => ({ data: [{ name: "commhub", status: { status, error: "secret:ntok_fixture" } }] }));
    const error = await waitForOpenCodeV2Commhub(url, "test", 2000).catch(e => e);
    expect(error.message).toContain("CommHub MCP not ready");
    expect(error.message).not.toContain("ntok_fixture");
  });
}
test("permanently pending is bounded", async () => {
  const url = serve(() => ({ data: [{ name: "commhub", status: { status: "pending" } }] }));
  const started = Date.now();
  await expect(waitForOpenCodeV2Commhub(url, "test", 220)).rejects.toThrow("readiness timed out");
  expect(Date.now() - started).toBeLessThan(1500);
});
test("invalid schema and local auth rejection are not ready", async () => {
  const url = serve(() => ({ wrong: [] }));
  await expect(waitForOpenCodeV2Commhub(url, "test", 500)).rejects.toThrow("invalid server list");
  server.stop(true);
  const denied = serve(() => ({}), 401);
  await expect(waitForOpenCodeV2Commhub(denied, "test", 500)).rejects.toThrow("HTTP 401");
});
test("child death and unbounded timeouts are rejected", async () => {
  await expect(waitForOpenCodeV2Commhub("http://127.0.0.1:1", "test", 100, () => false)).rejects.toThrow("serve exited");
  for (const timeout of [0, -1, Infinity, NaN]) {
    await expect(waitForOpenCodeV2Commhub("http://127.0.0.1:1", "test", timeout)).rejects.toThrow("positive finite timeout");
  }
});
