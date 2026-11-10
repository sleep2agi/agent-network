// app#225 follow-up — the claude-code channel-server answers the independent
// node-secret doorbell with agent-node's semantics. Values are sentinels; every
// assertion fails if one escapes into a result, an ack, or a log line.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  NODE_SECRET_REQUEST_RE,
  collectReportedSecretKeys,
  handleNodeSecretsEvent,
  nodeSecretsReportFields,
  operateNodeSecrets,
  reconcileNodeSecrets,
  resolveNodeSecretScope,
} from "./node-server-secrets";

const dirs: string[] = [];
const SENTINEL = "sentinel-value-DO-NOT-PRINT-c41e";
const NODE_ID = "node-fixture";
const NET_ID = "net-fixture";

afterEach(() => {
  while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch {} }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "anet-chan-secret-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ node_id: NODE_ID, network_id: NET_ID, alias: "ANet负责人" }));
  chmodSync(join(dir, "config.json"), 0o600);
  return dir;
}

const request = (action: string, revision?: number, extra: Record<string, unknown> = {}) => ({
  request_id: `nsk_${randomUUID()}`,
  network_id: NET_ID,
  daemon_node_id: null,
  node_id: NODE_ID,
  action,
  ...(action === "list" ? {} : { key: "TEST_VENDOR_KEY", revision, ...(action === "put" ? { value: SENTINEL } : {}) }),
  expires_at: Date.now() + 60_000,
  ...extra,
});

describe("doorbell dispatch", () => {
  test("only the node_secrets event is consumed; rules_file stays with its own handler", async () => {
    const calls: string[] = [];
    const deps = {
      callCommHub: async (method: string) => { calls.push(method); return { ok: true, requests: [] }; },
      scope: { nodeDir: fixture(), nodeId: NODE_ID, networkId: NET_ID },
      log: () => {},
      warn: () => {},
    };
    expect(await handleNodeSecretsEvent({ type: "rules_file" }, deps)).toBe(false);
    expect(calls).toEqual([]);
    expect(await handleNodeSecretsEvent({ type: "node_secrets", request_id: "x" }, deps)).toBe(true);
    expect(calls).toEqual(["pull_daemon_provider_snapshots"]);
  });

  test("an unsafe/missing config omits the capability and ignores the doorbell", async () => {
    const warnings: string[] = [];
    const deps = {
      callCommHub: async () => { throw new Error("must not pull"); },
      scope: null,
      log: () => {},
      warn: (m: string) => warnings.push(m),
    };
    expect(await handleNodeSecretsEvent({ type: "node_secrets" }, deps)).toBe(true);
    expect(warnings.join("\n")).toContain("identity unavailable");
    expect(nodeSecretsReportFields(null)).toEqual({});
  });
});

describe("list / put / delete", () => {
  test("revision is monotonic and list never returns values", () => {
    const dir = fixture();
    expect(operateNodeSecrets(dir, request("list", 0))).toEqual({
      network_id: NET_ID, daemon_node_id: null, node_id: NODE_ID, revision: 0, activation: "next_start", keys: [],
    });

    const put = operateNodeSecrets(dir, request("put", 0));
    expect(put.revision).toBe(1);
    expect(put.keys).toEqual([{ key: "TEST_VENDOR_KEY", source: "node" }]);
    expect(JSON.stringify(put)).not.toContain(SENTINEL);

    const file = join(dir, "node-secrets.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain(SENTINEL); // on disk only

    expect(operateNodeSecrets(dir, request("list", 0)).revision).toBe(1);

    const second = operateNodeSecrets(dir, request("put", 1, { key: "ALPHA_KEY", value: "second-" + SENTINEL }));
    expect(second.revision).toBe(2);
    expect(second.keys).toEqual([{ key: "ALPHA_KEY", source: "node" }, { key: "TEST_VENDOR_KEY", source: "node" }]);
    expect(JSON.stringify(second)).not.toContain(SENTINEL);

    const deleted = operateNodeSecrets(dir, request("delete", 2));
    expect(deleted.revision).toBe(3);
    expect(deleted.keys).toEqual([{ key: "ALPHA_KEY", source: "node" }]);
  });

  test("delete is accepted with the current revision even when the key is absent", () => {
    const dir = fixture();
    const out = operateNodeSecrets(dir, request("delete", 0));
    expect(out.revision).toBe(1);
    expect(out.keys).toEqual([]);
  });
});

describe("conflicts and validation (fail closed)", () => {
  test("stale revision → secret_revision_conflict", () => {
    const dir = fixture();
    operateNodeSecrets(dir, request("put", 0));
    expect(() => operateNodeSecrets(dir, request("put", 0, { value: "new" }))).toThrow("secret_revision_conflict");
    expect(operateNodeSecrets(dir, request("list", 0)).revision).toBe(1);
  });

  test("an exact replay returns the same projection without bumping revision", () => {
    const dir = fixture();
    const r = request("put", 0);
    const first = operateNodeSecrets(dir, r);
    const replay = operateNodeSecrets(dir, r);
    expect(replay).toEqual(first);
    expect(operateNodeSecrets(dir, request("list", 0)).revision).toBe(1);
  });

  test("the same request_id with a different digest → secret_replay_conflict", () => {
    const dir = fixture();
    const r = request("put", 0);
    operateNodeSecrets(dir, r);
    expect(() => operateNodeSecrets(dir, { ...r, value: "different" })).toThrow("secret_replay_conflict");
    expect(() => operateNodeSecrets(dir, { ...r, revision: 1 })).toThrow("secret_replay_conflict");
  });

  test("invalid key, reserved key, NUL/newline and over-8192-byte values are rejected", () => {
    const dir = fixture();
    expect(() => operateNodeSecrets(dir, request("put", 0, { key: "lower_case" }))).toThrow("invalid_secret_input");
    expect(() => operateNodeSecrets(dir, request("put", 0, { key: "COMMHUB_TOKEN" }))).toThrow("invalid_secret_input");
    expect(() => operateNodeSecrets(dir, request("put", 0, { value: "a\\0b" }))).toThrow("invalid_secret_input");
    expect(() => operateNodeSecrets(dir, request("put", 0, { value: "a".repeat(8193) }))).toThrow("invalid_secret_input");
    expect(() => operateNodeSecrets(dir, request("put", 0, { value: "" }))).toThrow("invalid_secret_input");
    expect(() => operateNodeSecrets(dir, request("put", 0, { revision: -1 }))).toThrow("invalid_secret_input");
    expect(existsSync(join(dir, "node-secrets.json"))).toBe(false);
  });

  test("an existing lock refuses the write instead of racing the owner", () => {
    const dir = fixture();
    writeFileSync(join(dir, ".node-secrets.lock"), "", { mode: 0o600 });
    expect(() => operateNodeSecrets(dir, request("put", 0))).toThrow();
    expect(existsSync(join(dir, "node-secrets.json"))).toBe(false);
  });

  test("identity/path/action guards reject before touching the store", () => {
    const dir = fixture();
    const valid = request("list", 0);
    expect(() => operateNodeSecrets(dir, { ...valid, request_id: "dsk_" + randomUUID() })).toThrow("invalid_secret_request");
    expect(() => operateNodeSecrets(dir, { ...valid, node_id: "other" })).toThrow("invalid_secret_request");
    expect(() => operateNodeSecrets(dir, { ...valid, network_id: "other" })).toThrow("invalid_secret_request");
    expect(() => operateNodeSecrets(dir, { ...valid, daemon_node_id: "daemon" })).toThrow("invalid_secret_request");
    expect(() => operateNodeSecrets(dir, { ...valid, action: "read" })).toThrow("invalid_secret_request");
    expect(NODE_SECRET_REQUEST_RE.test(`nsk_${randomUUID()}`)).toBe(true);
  });
});

describe("hub transport", () => {
  test("pull → operate → ack snapshot; values never reach logs or the ack", async () => {
    const dir = fixture();
    const logs: string[] = [];
    const acks: any[] = [];
    const deps = {
      callCommHub: async (method: string, params: any) => {
        if (method === "pull_daemon_provider_snapshots") {
          expect(params).toEqual({ accept_node_secrets: true });
          return { ok: true, requests: [request("put", 0)] };
        }
        if (method === "ack_daemon_provider_snapshot") { acks.push(params); return { ok: true }; }
        throw new Error(`unexpected ${method}`);
      },
      scope: { nodeDir: dir, nodeId: NODE_ID, networkId: NET_ID },
      log: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
    };
    await reconcileNodeSecrets(deps);
    expect(acks).toHaveLength(1);
    expect(acks[0].request_id).toMatch(/^nsk_/);
    expect(acks[0].snapshot.keys).toEqual([{ key: "TEST_VENDOR_KEY", source: "node" }]);
    expect(JSON.stringify(acks)).not.toContain(SENTINEL);
    expect(logs.join("\n")).not.toContain(SENTINEL);
    expect(logs.join("\n")).toContain("revision=1");
    expect(statSync(join(dir, "node-secrets.json")).mode & 0o777).toBe(0o600);
  });

  test("a rejected request is acked failed:true with a stable code, never a value", async () => {
    const dir = fixture();
    const acks: any[] = [];
    const logs: string[] = [];
    const deps = {
      callCommHub: async (method: string, params: any) => {
        if (method === "pull_daemon_provider_snapshots") return { ok: true, requests: [request("put", 0, { key: "bad-key" })] };
        acks.push(params); return { ok: true };
      },
      scope: { nodeDir: dir, nodeId: NODE_ID, networkId: NET_ID },
      log: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
    };
    await reconcileNodeSecrets(deps);
    expect(acks).toEqual([{ request_id: expect.stringMatching(/^nsk_/), failed: true }]);
    expect(JSON.stringify(acks)).not.toContain(SENTINEL);
  });

  test("requests for another node/network, non-null daemon, or expired are ignored", async () => {
    const dir = fixture();
    const calls: string[] = [];
    const deps = {
      callCommHub: async (method: string, params: any) => {
        calls.push(method);
        if (method === "pull_daemon_provider_snapshots") return { ok: true, requests: [
          request("put", 0, { node_id: "other" }),
          request("put", 0, { network_id: "other" }),
          request("put", 0, { daemon_node_id: "daemon" }),
          request("put", 0, { expires_at: Date.now() - 1 }),
        ] };
        return { ok: true };
      },
      scope: { nodeDir: dir, nodeId: NODE_ID, networkId: NET_ID },
      log: () => {},
      warn: () => {},
    };
    await reconcileNodeSecrets(deps);
    expect(calls).toEqual(["pull_daemon_provider_snapshots"]);
    expect(existsSync(join(dir, "node-secrets.json"))).toBe(false);
  });
});

describe("capability report", () => {
  test("node_secrets_capable + secret_keys names only (independent store and secrets.env)", () => {
    const dir = fixture();
    operateNodeSecrets(dir, request("put", 0, { key: "ZULU_KEY" }));
    operateNodeSecrets(dir, request("put", 1, { key: "ALPHA_KEY", value: "other-" + SENTINEL }));
    writeFileSync(join(dir, "secrets.env"), `LEGACY_KEY=${SENTINEL}\nPATH=/usr/bin\n`, { mode: 0o600 });

    const scope = resolveNodeSecretScope(join(dir, "config.json"));
    expect(scope).toEqual({ nodeDir: dir, nodeId: NODE_ID, networkId: NET_ID });
    const fields = nodeSecretsReportFields(scope);
    expect(fields.config_snapshot).toEqual({ node_secrets_capable: true });
    expect(fields.secret_keys).toEqual(["ALPHA_KEY", "LEGACY_KEY", "ZULU_KEY"]);
    expect(JSON.stringify(fields)).not.toContain(SENTINEL);

    expect(collectReportedSecretKeys(dir)).toEqual(["ALPHA_KEY", "LEGACY_KEY", "ZULU_KEY"]);
    expect(JSON.stringify(collectReportedSecretKeys(dir))).not.toContain(SENTINEL);
  });

  test("a corrupt/unsafe node-secrets.json does not crash the heartbeat or leak a value", () => {
    const dir = fixture();
    writeFileSync(join(dir, "node-secrets.json"), JSON.stringify({ values: { LEAKY_KEY: SENTINEL } }), { mode: 0o644 });
    expect(collectReportedSecretKeys(dir)).toEqual([]);
    expect(nodeSecretsReportFields(resolveNodeSecretScope(join(dir, "config.json")))).toEqual({
      config_snapshot: { node_secrets_capable: true }, secret_keys: [],
    });
  });

  test("missing config → no scope/capability", () => {
    expect(resolveNodeSecretScope(join(fixture(), "missing.json"))).toBeNull();
    expect(resolveNodeSecretScope(undefined)).toBeNull();
  });
});
