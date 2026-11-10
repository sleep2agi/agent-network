import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const root = mkdtempSync("/tmp/t812-");
const project = join(root, "project");
const home = join(root, "home");
const bin = join(root, "bin");
const nodeDir = join(project, ".anet", "nodes", "slow-fetch");
for (const d of [nodeDir, bin, join(home, ".anet")]) mkdirSync(d, { recursive: true });
writeFileSync(join(home, ".anet", "config.json"), JSON.stringify({ hub: "http://127.0.0.1:19381" }));
writeFileSync(join(nodeDir, "config.json"), JSON.stringify({
  node_id: "n_test812", node_name: "slow-fetch", runtime: "codex-app-server",
  hub: "http://127.0.0.1:19381", token: "ntok_test812_not_real", model: "test-model",
  codexAppServerUrl: "ws://127.0.0.1:19382",
}));
const npxLog = join(root, "npx.json");
writeFileSync(join(bin, "npx"), `#!/usr/bin/env node
const {writeFileSync}=require("node:fs");
writeFileSync(${JSON.stringify(npxLog)}, JSON.stringify({args:process.argv.slice(2),proxy:process.env.HTTPS_PROXY,httpProxy:process.env.HTTP_PROXY,noProxy:process.env.NO_PROXY}));
setTimeout(()=>{
console.error("T812 registry failure after delay");
process.exit(7);
},800);
`, { mode: 0o755 });
const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
  HTTPS_PROXY: "http://proxy.invalid:18888", HTTP_PROXY: "http://proxy.invalid:18889", NO_PROXY: "127.0.0.1,localhost" };
for (const k of ["ANET_AGENT_NODE_BIN", "ANET_COPRESENCE_BRIDGE", "TMUX", "TMUX_PANE"]) delete env[k];
for (const [budget, expected] of [[100, "timed out after 100ms"], [3000, "T812 registry failure after delay"]]) {
  const r = spawnSync(process.execPath, ["/workspace/anet-test.mjs", "node", "start", "slow-fetch"], {
    cwd: project, env: { ...env, ANET_AGENT_NODE_RESOLVE_TIMEOUT_MS: String(budget) },
    encoding: "utf8", timeout: 15000,
  });
  const output = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, output);
  assert.ok(output.includes(expected), output);
  if (budget === 100) assert.match(output, /npx -y @sleep2agi\/agent-node@\d+\.\d+\.\d+-preview\.\d+ --print-entrypoint/);
  else assert.ok(!output.includes("timed out"), output);
  const seen = JSON.parse(readFileSync(npxLog, "utf8"));
  assert.equal(seen.proxy, env.HTTPS_PROXY);
  assert.equal(seen.httpProxy, env.HTTP_PROXY);
  assert.equal(seen.noProxy, env.NO_PROXY);
  assert.equal(seen.args[2], "--print-entrypoint");
  console.log(`PASS real CLI budget=${budget}, refusal and inherited proxy`);
}
