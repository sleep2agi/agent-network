import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installV2RegistryPlugin, V2_REGISTRY_RPC, waitForOpenCodeV2Commhub } from "./v2-readiness";
import { buildOpencodeChildEnv, cleanupOpencodeChildEnv } from "../opencode-acp/child-env";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const mcp = (state = "connected") => ({ data: [{ name: "commhub", status: { status: state } }] });
function transport(fn: (path: string, init: RequestInit) => any) {
  globalThis.fetch = (async (url: any, init: any) => {
    expect(init.redirect).toBe("error");
    expect(init.headers.authorization).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"));
    const path = new URL(url).pathname;
    if (path === V2_REGISTRY_RPC) {
      expect(init.method).toBe("POST");
      expect(init.body).toBe('{"input":{}}');
    }
    return Response.json(await fn(path, init));
  }) as typeof fetch;
}
const wait = (ms = 1000, running?: () => boolean) => waitForOpenCodeV2Commhub("http://127.0.0.1:1", "pw", ms, running);

describe("#832 final registry readiness", () => {
  test("connected alone cannot pass; waits for actual registry flag", async () => {
    let polls = 0;
    transport(path => path === V2_REGISTRY_RPC ? { output: { ready: ++polls >= 3 } } : mcp());
    await wait();
    expect(polls).toBe(3);
  });
  test("missing MCP and pending registration poll without calling registry prematurely", async () => {
    let calls = 0;
    transport(path => {
      if (path === V2_REGISTRY_RPC) { expect(calls).toBe(3); return { output: { ready: true } }; }
      return ++calls === 1 ? { data: [] } : mcp(calls === 2 ? "pending" : "connected");
    });
    await wait();
  });
  test("registry removal is observed on each poll", async () => {
    let polls = 0;
    transport(path => path === V2_REGISTRY_RPC ? { output: { ready: ++polls > 2 } } : mcp());
    await wait();
    expect(polls).toBe(3);
  });
  test("connection loss after registry true cannot become ready", async () => {
    let polls = 0;
    transport(path => path === V2_REGISTRY_RPC ? { output: { ready: true } } : mcp(++polls === 1 ? "connected" : "failed"));
    await expect(wait()).rejects.toThrow("not ready (failed)");
  });
  test("pending reconnect rechecks registry rather than caching ready", async () => {
    let calls = 0, registry = 0;
    transport(path => path === V2_REGISTRY_RPC ? { output: { ready: ++registry === 1 || registry === 3 } } : mcp(++calls === 2 ? "pending" : "connected"));
    await wait();
    expect(registry).toBe(3);
  });
  for (const state of ["failed", "disabled", "needs_auth", "secret-token", undefined]) {
    test(`MCP state ${state} is fail-closed and redacted`, async () => {
      transport(() => ({ data: [{ name: "commhub", status: { status: state, error: "ntok_private" } }] }));
      try { await wait(); throw Error("unexpected pass"); }
      catch (e: any) { expect(e.message).toContain("not ready"); expect(e.message).not.toContain("secret-token"); expect(e.message).not.toContain("ntok_private"); }
    });
  }
  for (const body of [{}, { data: {} }, { data: [...mcp().data, ...mcp().data] }]) {
    test(`invalid MCP schema ${JSON.stringify(body)}`, async () => {
      transport(() => body);
      await expect(wait()).rejects.toThrow(/invalid|duplicate/);
    });
  }
  for (const ready of [undefined, "true", 1, null]) {
    test(`invalid registry flag ${ready}`, async () => {
      transport(path => path === V2_REGISTRY_RPC ? { output: { ready } } : mcp());
      await expect(wait()).rejects.toThrow("invalid ready flag");
    });
  }
  for (const status of [401, 403, 404, 500]) {
    test(`unavailable RPC HTTP ${status} has no warmup fallback`, async () => {
      globalThis.fetch = (async url => String(url).endsWith("/api/mcp") ? Response.json(mcp()) : new Response("ntok_secret", { status })) as typeof fetch;
      await expect(wait()).rejects.toThrow(`HTTP ${status}`);
    });
  }
  test("missing tools end at bounded deadline", async () => {
    transport(path => path === V2_REGISTRY_RPC ? { output: { ready: false } } : mcp());
    const start = Date.now();
    await expect(wait(100)).rejects.toThrow("timed out");
    expect(Date.now() - start).toBeLessThan(600);
  });
  for (const bodyStuck of [false, true]) {
    test(`deadline covers abort-ignoring ${bodyStuck ? "body" : "fetch"}`, async () => {
      let signal: AbortSignal | undefined;
      globalThis.fetch = ((_, init) => {
        signal = init?.signal as AbortSignal;
        return bodyStuck ? Promise.resolve({ ok: true, json: () => new Promise(() => {}) }) : new Promise(() => {});
      }) as typeof fetch;
      const start = Date.now();
      await expect(wait(70)).rejects.toThrow("timed out");
      expect(Date.now() - start).toBeLessThan(500);
      expect(signal?.aborted).toBe(true);
    });
  }
  test("process death interrupts a stuck response", async () => {
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
    const start = Date.now();
    await expect(wait(3000, () => Date.now() - start < 60)).rejects.toThrow("serve exited");
    expect(Date.now() - start).toBeLessThan(600);
  });
  test("dead process never sends a request", async () => {
    globalThis.fetch = (() => { throw Error("unexpected request"); }) as typeof fetch;
    await expect(wait(1000, () => false)).rejects.toThrow("serve exited");
  });
  for (const ms of [0, -1, NaN, Infinity]) {
    test(`reject invalid deadline ${ms}`, async () => { await expect(wait(ms)).rejects.toThrow("positive finite"); });
  }
});

describe("bundled read-only observation plugin", () => {
  test("generated plugin is reclaimed by tracked launch-root cleanup", () => {
    const parent = `/run/user/${process.getuid!()}`;
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const launchBase = mkdtempSync(join(parent, ".anet-registry-cleanup-"));
    const workDir = mkdtempSync(join(tmpdir(), "anet-registry-work-"));
    let env: NodeJS.ProcessEnv | undefined;
    try {
      env = buildOpencodeChildEnv({ workDir, cwd: workDir, launchBase, parentEnv: {} });
      const directory = installV2RegistryPlugin(env.XDG_DATA_HOME);
      expect(existsSync(join(directory, "index.js"))).toBe(true);
      expect(cleanupOpencodeChildEnv(workDir, env)).toBe(true);
      expect(existsSync(directory)).toBe(false);
    } finally {
      if (env) cleanupOpencodeChildEnv(workDir, env);
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });
  test("private generated asset reports live registry and disposes registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "anet-registry-test-"));
    try {
      const directory = installV2RegistryPlugin(root);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, "index.js")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(directory, "index.js"), "utf8")).not.toContain("ntok_");
      let methods: any, disposed = false;
      let tools = [{ id: "commhub_send_task" }];
      const plugin = (await import(join(directory, "index.js"))).default;
      const dispose = await plugin.setup({
        rpc: { register: async (_: any, handlers: any) => { methods = handlers; return { dispose() { disposed = true; } }; } },
        tool: { list: async () => tools },
      });
      expect(await methods.ready()).toEqual({ ready: false });
      tools.push({ id: "commhub_get_task" });
      expect(await methods.ready()).toEqual({ ready: true });
      tools = [];
      expect(await methods.ready()).toEqual({ ready: false });
      dispose();
      expect(disposed).toBe(true);
      chmodSync(root, 0o755);
      expect(() => installV2RegistryPlugin(root)).toThrow("private data directory");
      chmodSync(root, 0o700);
      symlinkSync(root, join(root, "link"));
      expect(() => installV2RegistryPlugin(join(root, "link"))).toThrow("private data directory");
      expect(() => installV2RegistryPlugin(undefined)).toThrow("XDG_DATA_HOME");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
