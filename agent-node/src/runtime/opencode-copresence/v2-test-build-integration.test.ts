import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENCODE_V2_BACKEND } from "../opencode-backend";
import { openVettedOpenCodeCopresence } from "./runtime";
import { readOpenCodeV2CatalogEndpoint } from "../opencode-v2-catalog-endpoint";

test("TEST-ONLY owned binary identity and catalog-scoped variant", async () => {
  const root = mkdtempSync(join(tmpdir(), "anet-4099-runtime-"));
  let markProvider!: () => void;
  const providerReached = new Promise<void>(resolve => { markProvider = resolve; });
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    markProvider();
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": held\n\n")); } }),
      { headers: { "content-type": "text/event-stream" } });
  } });
  const config = { model: "fixture/model", enabled_providers: ["fixture"], provider: {
    fixture: { name: "fixture", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "synthetic" },
      models: { model: { name: "model", limit: { context: 128000, output: 16000 }, variants: { high: {}, low: {} } },
        other: { name: "other", limit: { context: 128000, output: 16000 }, variants: { low: {} } } } },
  } };
  const noTmux = () => { throw Error("unexpected tmux"); };
  const session = await openVettedOpenCodeCopresence({ backend: OPENCODE_V2_BACKEND, binary: "/tool/opencode", cwd: root, workDir: root,
    env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), ANET_VARIANT_TEST_ONLY: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    model: "fixture/model", startupTimeoutMs: 20000, tmuxRunner: noTmux, tmuxRespawn: noTmux });
  try {
    expect(session.variantConfigCapable).toBe(true);
    const endpoint = readOpenCodeV2CatalogEndpoint(root)!;
    const response = await fetch(`${endpoint.url}/api/model`, { headers: { authorization: endpoint.authorization, "x-opencode-directory": endpoint.directory } });
    const body = await response.json() as any;
    console.log("catalog evidence", JSON.stringify({ status: response.status, location: body.location, matching: body.data?.filter((row: any) => row.providerID === "fixture" && row.id === "model").map((row: any) => ({ providerID: row.providerID, id: row.id, variants: row.variants?.map((v: any) => v.id) })) }));
    expect(await session.selectSessionModel!(session.sessionId, { providerID: "fixture", id: "model", variant: "high" })).toEqual({ status: "applied", model: { providerID: "fixture", id: "model", variant: "high" } });
    expect(await session.selectedSessionModel!(session.sessionId)).toEqual({ providerID: "fixture", id: "model", variant: "high" });
    await expect(session.setSelectedModel!("fixture/other")).rejects.toThrow("scoped model switch rejected");
    expect(await session.selectedSessionModel!(session.sessionId)).toEqual({ providerID: "fixture", id: "model", variant: "high" });
    await session.setSelectedModel!("fixture/model");
    expect(await session.selectedSessionModel!(session.sessionId)).toEqual({ providerID: "fixture", id: "model", variant: "high" });
    expect(await session.selectSessionModel!(session.sessionId, { providerID: "fixture", id: "model", variant: "not-listed" })).toEqual({ status: "rejected", reason: "catalog" });
    expect(await session.selectSessionModel!(session.sessionId, { providerID: "fixture", id: "model" })).toEqual({ status: "applied", model: { providerID: "fixture", id: "model", variant: "default" } });
    const prompt = await fetch(`${endpoint.url}/api/session/${session.sessionId}/prompt`, { method: "POST", headers: { authorization: endpoint.authorization,
      "x-opencode-directory": endpoint.directory, "content-type": "application/json" }, body: JSON.stringify({ text: "synthetic local test" }) });
    expect(prompt.status).toBe(200);
    await Promise.race([providerReached, new Promise<never>((_, reject) => setTimeout(() => reject(Error("fixture provider not reached")), 10000))]);
    expect(await session.selectSessionModel!(session.sessionId, { providerID: "fixture", id: "model", variant: "high" })).toEqual({ status: "rejected", reason: "busy" });
    expect(await session.selectedSessionModel!(session.sessionId)).toEqual({ providerID: "fixture", id: "model", variant: "default" });
  } finally { await session.close(); provider.stop(true); }
}, 30000);
