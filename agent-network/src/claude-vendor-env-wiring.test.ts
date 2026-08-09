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
