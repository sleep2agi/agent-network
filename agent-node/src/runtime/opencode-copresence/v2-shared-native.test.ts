import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSharedV2RegistryPlugin, V2_REGISTRY_RPC } from "./v2-readiness";

const binary = process.env.ANET_OPENCODE_V2_BIN;
const nativeTest = binary ? test : test.skip;

nativeTest("a real V2 shared server loads the project-scoped registry without a model turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "anet-v2-shared-native-"));
  const project = join(root, "project");
  const secondProject = join(root, "second-project");
  const nodeDir = join(root, "node-private");
  const secondNodeDir = join(root, "second-node-private");
  const config = join(root, "config");
  const data = join(root, "data");
  let activeData = data;
  const state = join(root, "state");
  for (const dir of [project, secondProject, nodeDir, secondNodeDir, config, data, state]) mkdirSync(dir, { mode: 0o700 });
  const plugin = installSharedV2RegistryPlugin(nodeDir);
  const secondPlugin = installSharedV2RegistryPlugin(secondNodeDir);
  writeFileSync(join(project, "opencode.json"), JSON.stringify({ plugins: [{ package: plugin }] }), { mode: 0o600 });
  writeFileSync(join(secondProject, "opencode.json"), JSON.stringify({ plugins: [{ package: secondPlugin }] }), { mode: 0o600 });
  const port = await new Promise<number>((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") return reject(new Error("test port unavailable"));
      listener.close(() => resolve(address.port));
    });
  });
  const password = "native-test-only";
  const url = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    "x-opencode-directory": project,
    "content-type": "application/json",
  };
  const secondHeaders = { ...headers, "x-opencode-directory": secondProject };
  const spawnServer = () => spawn(binary!, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: activeData,
      XDG_STATE_HOME: state,
      OPENCODE_DB: join(activeData, "opencode.db"),
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: "ignore",
  });
  let server = spawnServer();
  const waitReady = async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error("isolated OpenCode Server exited before readiness");
      if (await fetch(`${url}/api/info`, { headers, signal: AbortSignal.timeout(1000) }).then(response => response.ok, () => false)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("isolated OpenCode Server did not become ready");
  };
  const stopServer = async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    server.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve => server.once("exit", resolve)),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await Promise.race([
        new Promise(resolve => server.once("exit", resolve)),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);
    }
    if (server.exitCode === null && server.signalCode === null) throw new Error("isolated OpenCode Server did not stop");
  };
  try {
    await waitReady();
    const configResponse = await fetch(`${url}/api/config`, { headers });
    expect(configResponse.status).toBe(200);
    const sources = await configResponse.json() as any[];
    expect(sources.some(entry => entry?.path === join(project, "opencode.json"))).toBe(true);
    const rpcResponse = await fetch(`${url}${V2_REGISTRY_RPC}`, {
      method: "POST", headers, body: '{"input":{}}',
    });
    expect(rpcResponse.status).toBe(200);
    const rpc = await rpcResponse.json() as any;
    expect(rpc.output).toEqual({ ready: false });
    const createdResponse = await fetch(`${url}/api/session`, {
      method: "POST", headers,
      body: JSON.stringify({
        title: "Persistent shared-server test",
        location: { directory: project },
        model: { providerID: "stub", id: "stub-model" },
      }),
    });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as any;
    const sessionId = created?.data?.id;
    expect(sessionId).toMatch(/^ses_[A-Za-z0-9]+$/);
    const secondCreatedResponse = await fetch(`${url}/api/session`, {
      method: "POST", headers: secondHeaders,
      body: JSON.stringify({
        title: "Second shared-server project",
        location: { directory: secondProject },
        model: { providerID: "stub", id: "stub-model" },
      }),
    });
    expect(secondCreatedResponse.status).toBe(200);
    const secondCreated = await secondCreatedResponse.json() as any;
    const secondSessionId = secondCreated?.data?.id;
    expect(secondSessionId).toMatch(/^ses_[A-Za-z0-9]+$/);
    expect(secondSessionId).not.toBe(sessionId);
    await stopServer();
    server = spawnServer();
    await waitReady();
    const resumedResponse = await fetch(`${url}/api/session/${sessionId}`, { headers });
    expect(resumedResponse.status).toBe(200);
    const resumed = await resumedResponse.json() as any;
    expect(resumed?.data?.id).toBe(sessionId);
    expect(resumed?.data?.location?.directory).toBe(project);
    const secondResumedResponse = await fetch(`${url}/api/session/${secondSessionId}`, { headers: secondHeaders });
    expect(secondResumedResponse.status).toBe(200);
    const secondResumed = await secondResumedResponse.json() as any;
    expect(secondResumed?.data?.id).toBe(secondSessionId);
    expect(secondResumed?.data?.location?.directory).toBe(secondProject);
    await stopServer();
    const restoredData = join(root, "restored-data");
    cpSync(data, restoredData, { recursive: true });
    rmSync(data, { recursive: true, force: true });
    activeData = restoredData;
    server = spawnServer();
    await waitReady();
    const restoredResponse = await fetch(`${url}/api/session/${sessionId}`, { headers });
    expect(restoredResponse.status).toBe(200);
    const restored = await restoredResponse.json() as any;
    expect(restored?.data?.id).toBe(sessionId);
    expect(restored?.data?.location?.directory).toBe(project);
    const secondRestoredResponse = await fetch(`${url}/api/session/${secondSessionId}`, { headers: secondHeaders });
    expect(secondRestoredResponse.status).toBe(200);
    const secondRestored = await secondRestoredResponse.json() as any;
    expect(secondRestored?.data?.id).toBe(secondSessionId);
    expect(secondRestored?.data?.location?.directory).toBe(secondProject);
  } finally {
    try { await stopServer(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 45_000);
