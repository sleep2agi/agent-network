// #832: /api/mcp connected precedes V2's debounced final tool registry.
// Pinned @opencode/cli 2.0.22 promise-plugin contract; no model warmup.
import { lstatSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { join, resolve } from "path";

export const V2_REGISTRY_RPC = "/api/rpc/anet.commhub-readiness/ready";

// Embedded in the runtime bundle: no untracked plugin or npm dependency is
// needed on a rebuilt host. This RPC observes only, never executes a tool.
export const V2_REGISTRY_PLUGIN = `export default {
  id: "anet.commhub-readiness",
  async setup(ctx) {
    const registration = await ctx.rpc.register({
      id: "anet.commhub-readiness", events: {},
      methods: { ready: {
        input: { type: "object", properties: {}, additionalProperties: false },
        output: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"], additionalProperties: false }
      } }
    }, { ready: async () => {
      const tools = await ctx.tool.list();
      return { ready: ["commhub_send_task", "commhub_get_task"].every(id => tools.some(tool => tool.id === id)) };
    } });
    return () => registration.dispose();
  }
};
`;

/** dataRoot is the fresh private XDG_DATA_HOME owned by child-env.ts.
 * Its existing identity-checked launch-root cleanup owns this directory too. */
export function installV2RegistryPlugin(dataRoot: string | undefined): string {
  if (!dataRoot) throw new Error("OpenCode v2 registry plugin requires private XDG_DATA_HOME");
  const root = resolve(dataRoot);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root
    || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("OpenCode v2 registry plugin requires an owned private data directory");
  }
  const directory = mkdtempSync(join(root, "anet-commhub-registry-"));
  writeFileSync(join(directory, "index.js"), V2_REGISTRY_PLUGIN, { flag: "wx", mode: 0o600 });
  return directory;
}

/** One hard deadline covers fetch AND body, including transports that ignore
 * AbortSignal. Process death interrupts a stuck request as well as a poll. */
async function readObservation(
  url: string, password: string, path: string, deadline: number,
  isRunning: () => boolean,
): Promise<any> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let death: ReturnType<typeof setInterval> | undefined;
  const ensureRunning = () => {
    if (!isRunning()) throw new Error("OpenCode v2 serve exited before CommHub MCP readiness");
    if (Date.now() >= deadline) throw new Error("OpenCode v2 CommHub MCP readiness timed out");
  };
  try {
    ensureRunning();
    return await Promise.race([
      (async () => {
        try {
          const response = await fetch(url + path, {
            method: path === V2_REGISTRY_RPC ? "POST" : "GET",
            headers: {
              authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
              "content-type": "application/json",
            },
            ...(path === V2_REGISTRY_RPC ? { body: '{"input":{}}' } : {}),
            signal: controller.signal,
            redirect: "error",
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          ensureRunning();
          return body;
        } catch (error: any) {
          ensureRunning();
          // Never surface upstream bodies, URLs, headers or tokens.
          const status = /^HTTP (\d{3})$/.exec(error?.message ?? "")?.[1];
          throw new Error(`OpenCode v2 CommHub MCP observation failed${status ? ` (HTTP ${status})` : ""}; check the local V2 API and registry plugin`);
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("OpenCode v2 CommHub MCP readiness timed out")), Math.max(1, deadline - Date.now()));
        death = setInterval(() => {
          if (!isRunning()) reject(new Error("OpenCode v2 serve exited before CommHub MCP readiness"));
        }, 20);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    clearInterval(death);
    controller.abort();
  }
}

function connected(body: any): boolean {
  if (!Array.isArray(body?.data)) throw new Error("OpenCode v2 CommHub MCP observation returned an invalid server list");
  const servers = body.data.filter((entry: any) => entry?.name === "commhub");
  if (servers.length > 1) throw new Error("OpenCode v2 CommHub MCP observation returned duplicate servers");
  const state = servers[0]?.status?.status;
  if (state === "connected") return true;
  if (servers.length === 0 || state === "pending") return false;
  const safeState = ["failed", "disabled", "needs_auth"].includes(state) ? state : "unknown";
  throw new Error(`OpenCode v2 CommHub MCP not ready (${safeState}); check Hub reachability and node credentials`);
}

export async function waitForOpenCodeV2Commhub(
  url: string, password: string, timeoutMs: number,
  isRunning: () => boolean = () => true,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("OpenCode v2 CommHub MCP readiness requires a positive finite timeout");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (connected(await readObservation(url, password, "/api/mcp", deadline, isRunning))) {
      const body = await readObservation(url, password, V2_REGISTRY_RPC, deadline, isRunning);
      if (typeof body?.output?.ready !== "boolean") {
        throw new Error("OpenCode v2 CommHub MCP registry observation returned an invalid ready flag");
      }
      // Recheck connection after registry observation: a disconnected MCP must
      // not pass simply because a previous registry still contains its tools.
      if (body.output.ready && connected(await readObservation(url, password, "/api/mcp", deadline, isRunning))) return;
    }
    await new Promise((r) => setTimeout(r, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
  throw new Error("OpenCode v2 CommHub MCP readiness timed out; no session or model turn was started");
}
