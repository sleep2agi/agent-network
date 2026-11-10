import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "test906-cli-doc-"));
const version = process.env.EXPECTED_CLI_VERSION || "2.3.0-preview.165";
assert.match(version, /^2\.3\.0-preview\.[0-9]+$/);
execFileSync("tar", ["-xzf", `/artifact/sleep2agi-agent-network-${version}.tgz`, "-C", root]);
const pkg = join(root, "package");
symlinkSync("/work/agent-network/node_modules", join(pkg, "node_modules"));
assert.equal(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version, version);
console.log(`PASS exact CLI candidate version ${version}`);
let registrations = 0;
let capturedPassword;
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  let result;
  if (req.url === "/health") result = { ok: true, version: "0.9.0-preview.123" };
  else if (req.url === "/api/auth/login") result = { ok: false, error: "invalid credentials" };
  else if (req.url === "/api/auth/register") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    assert.equal(data.username, "admin");
    capturedPassword = data.password;
    registrations++;
    result = { ok: true, token: "utok_test906_doc_fixture", user: { username: "admin", user_id: "test906-user" } };
  } else result = { ok: false, error: "fixture route not found" };
  res.end(JSON.stringify(result));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
async function run() {
  const child = spawn(process.execPath, [join(pkg, "dist/bin/cli.js"), "hub", "start", "--port", String(server.address().port)], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: join(root, "isolated-home"), NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", b => output += b);
  child.stderr.on("data", b => output += b);
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, "CLI exits successfully against isolated HTTP fixture");
  return output;
}
try {
  const first = await run();
  assert.equal(registrations, 1);
  assert.match(capturedPassword, /^anet-[a-f0-9]{22}$/);
  assert.match(first, /Admin account created/);
  assert.ok(first.includes(`password: ${capturedPassword}`));
  console.log("PASS actual packaged CLI emits the documented random bootstrap password");
  const second = await run();
  assert.equal(registrations, 1);
  assert.match(second, /Admin already exists/);
  assert.ok(!second.includes(capturedPassword));
  console.log("PASS repeat start does not register or print the password again");
  console.log("RESULT 3/3; HTTP/auth response fixture, not production authentication");
} finally {
  await new Promise(resolve => server.close(resolve));
}
