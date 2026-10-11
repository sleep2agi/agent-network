// Real pinned OpenCode server, private test directory, no model invocation.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { readOpenCodeCatalog } from "../../agent-node/src/runtime/opencode-v2-catalog";
const root = mkdtempSync(join(tmpdir(), "catalog906-"));
const workspace = join(root, "project");
mkdirSync(workspace);
const provider = { npm: "@ai-sdk/openai-compatible", name: "fixture", options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "sk-FAKE-catalog906" },
  models: { "fixture-model": { name: "fixture model" } } };
writeFileSync(join(workspace, "opencode.json"), JSON.stringify({ provider: { fixture: provider }, model: "fixture/fixture-model" }), { mode: 0o600 });
const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "24906"], {
  cwd: workspace, env: { PATH: process.env.PATH, HOME: root, OPENCODE_PASSWORD: "test906-private" }, stdio: "ignore",
});
const exited = once(child, "exit");
const scope = { networkId: "net-test906", daemonId: "daemon-test906", directory: workspace };
const opts = { scope, url: "http://127.0.0.1:24906", authorization: `Basic ${Buffer.from("opencode:test906-private").toString("base64")}`, timeoutMs: 1000 };
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error("native server exited before readiness");
    try {
      const response = await fetch(`${opts.url}/api/info`, { headers: { authorization: opts.authorization }, signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await Bun.sleep(100);
  }
  assert(ready, "native API started");
  await assert.rejects(readOpenCodeCatalog({ ...opts, authorization: "Basic invalid" }), /unauthorized/);
  console.log("PASS L1 real V2 rejects wrong authentication");
  let snapshot;
  for (let i = 0; i < 60; i++) {
    snapshot = await readOpenCodeCatalog(opts);
    if (snapshot.models.some(m => m.providerId === "fixture" && m.id === "fixture-model")) break;
    await Bun.sleep(100);
  }
  assert(snapshot?.models.some(m => m.providerId === "fixture" && m.id === "fixture-model"), "native custom model discovered, no preset substitution");
  assert.equal(snapshot.defaultModel?.providerId, "fixture");
  assert.equal(snapshot.defaultModel?.id, "fixture-model");
  assert.equal(snapshot.invocationVerified, false);
  assert.equal(snapshot.completeness, "unknown");
  assert(!JSON.stringify(snapshot).includes("sk-FAKE"), "native provider headers/settings never leave adapter");
  console.log(`PASS L2 real V2 snapshot: providers=${snapshot.providers.length} models=${snapshot.models.length}; NOT invocation verified`);
} finally {
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  await exited; clearTimeout(timer);
  rmSync(root, { recursive: true, force: true });
  console.log("cleanup: private native child exited; disposable fixture removed");
}
