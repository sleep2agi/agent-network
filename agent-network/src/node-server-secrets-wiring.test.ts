// Source-level wiring pins. The identity payload is built in three places
// (boot register, SSE re-register, heartbeat); the capability must be in all
// three or one path silently drops it. Same for the doorbell and connect
// catch-up: a behaviour test can pass while node-server never calls it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "node-server.ts"), "utf-8");
const CODE = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("node-server node-secret wiring", () => {
  test("scope is derived from the already-reported CONFIG_PATH (no request path)", () => {
    expect(CODE).toContain('import { drainNodeSecrets, handleNodeSecretsEvent, nodeSecretsReportFields, resolveNodeSecretScope } from "./node-server-secrets";');
    expect(CODE).toContain("const NODE_SECRET_SCOPE = resolveNodeSecretScope(CONFIG_PATH);");
    expect(CODE).not.toContain("NODE_SECRET_SCOPE = resolveNodeSecretScope(process.env");
  });

  test("the node_secrets doorbell is dispatched next to rules_file", () => {
    const rules = CODE.indexOf("handleRulesFileEvent(event");
    const secrets = CODE.indexOf("handleNodeSecretsEvent(event, nodeSecretDoorbellDeps())");
    expect(rules).toBeGreaterThanOrEqual(0);
    expect(secrets).toBeGreaterThan(rules);
    expect(CODE).toContain('if (await handleNodeSecretsEvent(event, nodeSecretDoorbellDeps())) return;');
  });

  test("connect/reconnect performs a catch-up pull", () => {
    expect(CODE).toContain('void drainNodeSecrets(nodeSecretDoorbellDeps(), "connect catch-up");');
  });

  test("all three report_status identity payloads advertise capability + key names", () => {
    // boot register + re-register + heartbeat. Missing one = that path never
    // makes the Hub accept writes / show the panel.
    const occurrences = CODE.match(/\.\.\.nodeSecretsReportFields\(NODE_SECRET_SCOPE\)/g) ?? [];
    expect(occurrences).toHaveLength(3);
    const payloads = CODE.match(/agent:\s*"claude-code"/g) ?? [];
    expect(payloads).toHaveLength(3);
  });
});
