import { describe, expect, test } from "bun:test";
import { freeOpenCodeModels, readFreeOpenCodeModels, selectFreeOpenCodeModel } from "./daemon-opencode-free-provider";
const directory = "/private/project";
const zero = { input: 0, output: 0, cache: { read: 0, write: 0 } };
const row = (id = "dynamic-model") => ({ providerID: "opencode", id, enabled: true, status: "active", cost: [structuredClone(zero)] });
const snapshot = (...data: unknown[]) => ({ location: { directory }, data });

describe("daemon free OpenCode Provider discovery", () => {
  test("uses native IDs/order, never model name heuristics; projects no settings", () => {
    expect(freeOpenCodeModels(snapshot({ ...row("newest"), settings: { apiKey: "fake-must-not-leak" } }, row("older")), directory))
      .toEqual([{ providerID: "opencode", id: "newest" }, { providerID: "opencode", id: "older" }]);
  });
  test("every context tier and input/output/cache category must be zero", () => {
    for (const category of ["input", "output", "read", "write"]) {
      const price: any = structuredClone(zero);
      if (["input", "output"].includes(category)) price[category] = 1;
      else price.cache[category] = 1;
      expect(freeOpenCodeModels(snapshot({ ...row("free-sounding-name"), cost: [zero, price] }), directory)).toEqual([]);
    }
    expect(freeOpenCodeModels(snapshot({ ...row(), cost: [zero, zero] }), directory)).toHaveLength(1);
  });
  test("unknown, missing, empty, malformed and coercible costs never mean free", () => {
    for (const cost of [undefined, null, [], {}, [null], [{}], [{ input: 0, output: 0 }],
      [{ ...zero, input: "0" }], [{ ...zero, output: -1 }], [{ ...zero, cache: { read: 0 } }]]) {
      expect(freeOpenCodeModels(snapshot({ ...row(), cost }), directory)).toEqual([]);
    }
  });
  test("only enabled nondeprecated OpenCode models; not arbitrary free third parties", () => {
    for (const patch of [{ enabled: false }, { enabled: "true" }, { status: "deprecated" }, { status: "unknown" },
      { providerID: "other" }, { id: "model#variant" }, { id: "../path" }]) {
      expect(freeOpenCodeModels(snapshot({ ...row(), ...patch }), directory)).toEqual([]);
    }
  });
  test("explicit consent required before selection; no paid fallback", () => {
    expect(() => selectFreeOpenCodeModel(snapshot(row()), directory, false)).toThrow("opencode_v2_requires_unsafe_opt_in");
    expect(() => selectFreeOpenCodeModel(snapshot(), directory, true)).toThrow("opencode_free_model_unavailable");
    expect(selectFreeOpenCodeModel(snapshot(row()), directory, true).id).toBe("dynamic-model");
  });
  test("scope mismatch, malformed snapshot and duplicate identities rejected", () => {
    for (const body of [null, [], {}, { location: { directory: "/other" }, data: [row()] }]) {
      expect(() => freeOpenCodeModels(body, directory)).toThrow("opencode_free_catalog_invalid");
    }
    expect(() => freeOpenCodeModels(snapshot(row(), row()), directory)).toThrow("opencode_free_catalog_duplicate");
  });
  test("guarded discovery checks native version/auth/directory and drops secrets", async () => {
    const auth = "Basic test-only";
    const requests: string[] = [];
    let version = "2.0.22";
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      if (req.headers.get("authorization") !== auth) return new Response(null, { status: 401 });
      expect(req.headers.get("x-opencode-directory")).toBe(directory);
      return Response.json(path === "/api/info" ? { version } : snapshot({ ...row(), settings: { apiKey: "fake-secret" } }));
    } });
    const opts = { scope: { networkId: "network", daemonId: "daemon", directory }, url: `http://127.0.0.1:${server.port}`, authorization: auth };
    try {
      const result = await readFreeOpenCodeModels(opts);
      expect(result.models).toEqual([{ providerID: "opencode", id: "dynamic-model" }]);
      expect(result.invocationVerified).toBe(false);
      expect(JSON.stringify(result)).not.toContain("fake-secret");
      expect(requests).toEqual(["/api/info", "/api/model"]);
      await expect(readFreeOpenCodeModels({ ...opts, authorization: "wrong" })).rejects.toThrow("unauthorized");
      version = "2.3.0";
      await expect(readFreeOpenCodeModels(opts)).rejects.toThrow("opencode_free_version_mismatch");
      await expect(readFreeOpenCodeModels({ ...opts, url: "https://example.test" })).rejects.toThrow("invalid_target");
    } finally { server.stop(true); }
  });
});
