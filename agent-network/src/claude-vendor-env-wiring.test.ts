import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");

test("node create captures vendor shell env before profile construction", () => {
  const call = cli.indexOf("opts._envs = collectClaudeVendorEnvForCreate({");
  const profile = cli.indexOf("const profile = createProfileFromOpts(id, opts);", call);
  expect(call).toBeGreaterThan(0);
  expect(profile).toBeGreaterThan(call);
  expect(cli.slice(call, profile)).toContain("shellEnv: process.env");
});

test("every dotenv-writing create preflights before any node-state side effect", () => {
  const saveStart = cli.indexOf("function saveCreatedNode(id: string, profile: Profile)");
  const saveEnd = cli.indexOf("function rewritePlainSecretsToEnvRef", saveStart);
  const body = cli.slice(saveStart, saveEnd);
  const preflight = body.indexOf("planPlainSecretEnvRewrites({");
  expect(saveStart).toBeGreaterThan(0);
  expect(preflight).toBeGreaterThan(0);
  for (const sideEffect of [
    "prepareOpencodeNodeForProfileWrite(",
    "writeOpencodePrivateProfileFile(",
    "ensureAnetInRootGitignore()",
    "rewritePlainSecretsToEnvRef(",
    "writeLegacyProjectAlias(",
    "saveProfile(",
  ]) {
    expect(body.indexOf(sideEffect)).toBeGreaterThan(preflight);
  }
});

test("the dotenv writer itself reuses the side-effect-free planner", () => {
  const writerStart = cli.indexOf("function rewritePlainSecretsToEnvRef");
  const writerEnd = cli.indexOf("async function requestNodeToken", writerStart);
  const body = cli.slice(writerStart, writerEnd);
  const planner = body.indexOf("const rewrites = planPlainSecretEnvRewrites({");
  expect(writerStart).toBeGreaterThan(0);
  expect(planner).toBeGreaterThan(0);
  expect(body.indexOf("process.env[refName] = value")).toBeGreaterThan(planner);
  // 写盘边界在 #? 之后从裸 writeFileSync 换成了加固写入(原子 + 私有权限);
  // 断言两条分支都在 planner 之后,并禁止退回裸 writeFileSync ——
  // 这条测试在 #792 之前没有任何 CI 会跑,所以它带着旧的调用名烂了一段时间。
  expect(body.indexOf("atomicWritePrivateFile(dotenvPath, body")).toBeGreaterThan(planner);
  expect(body.indexOf('writeOpencodePrivateProfileFile(nodeDir, ".env", body)')).toBeGreaterThan(planner);
  expect(body).not.toContain("writeFileSync(dotenvPath");
});
