import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.mjs";

const env = { ANET_HUB: "http://127.0.0.1:9300", ANET_ALIAS: "dsh-a", ANET_NODE_TOKEN: "ntok_abc" };

test("env supplies hub, alias and token; defaults fill the rest", () => {
  const c = resolveConfig({}, env);
  assert.equal(c.hub, env.ANET_HUB); assert.equal(c.alias, "dsh-a"); assert.equal(c.token, "ntok_abc");
  assert.equal(c.heartbeatMs, 30_000); assert.match(c.ledgerPath, /dsh-a[\\/]ledger\.json$/);
});

test("a token key in the patch-file config is refused with guidance", () => {
  assert.throws(() => resolveConfig({ token: "ntok_abc" }, env), /do not put the node token in the DSH patch file/);
});

test("missing token, missing hub, and non-ntok tokens are refused", () => {
  assert.throws(() => resolveConfig({}, { ...env, ANET_NODE_TOKEN: "" }), /node token is required/);
  assert.throws(() => resolveConfig({}, { ...env, ANET_HUB: "" }), /hub is required/);
  assert.throws(() => resolveConfig({}, { ...env, ANET_NODE_TOKEN: "utok_user" }), /must be an ntok_ token/);
});

test("tokenFile must be private (0600)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-commhub-cfg-"));
  try {
    const f = join(dir, "tok"); writeFileSync(f, "ntok_file\n");
    chmodSync(f, 0o644);
    assert.throws(() => resolveConfig({ tokenFile: f }, { ...env, ANET_NODE_TOKEN: "" }), /chmod 600/);
    chmodSync(f, 0o600);
    assert.equal(resolveConfig({ tokenFile: f }, { ...env, ANET_NODE_TOKEN: "" }).token, "ntok_file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown config keys are refused", () => {
  assert.throws(() => resolveConfig({ hubb: "x" }, env), /unknown config key/);
});
