// Anti-drift pin: the claude-code channel-server must project node secrets
// exactly like agent-node. Every step below runs the same request against both
// implementations (separate directories, same config) and compares results,
// error codes and the persisted projection. If the two semantics ever diverge,
// this test fails first.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { operateNodeSecrets as operateChannel } from "./node-server-secrets";
import { operateNodeSecrets as operateAgentNode } from "../../agent-node/src/runtime/node-secrets.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch {} }
});

const NODE_ID = "node-parity";
const NET_ID = "net-parity";
const VALUE = "synthetic value with spaces / quotes \" and 中文";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "anet-parity-secret-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ alias: "ANet负责人", node_id: NODE_ID, network_id: NET_ID }));
  chmodSync(join(dir, "config.json"), 0o600);
  return dir;
}

type Outcome = { ok: true; value: any } | { ok: false; error: string };
const outcome = (fn: () => any): Outcome => {
  try { return { ok: true, value: fn() }; } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
};

const req = (action: string, revision?: number, extra: Record<string, unknown> = {}) => ({
  request_id: `nsk_${randomUUID()}`,
  network_id: NET_ID,
  daemon_node_id: null,
  node_id: NODE_ID,
  action,
  ...(action === "list" ? {} : { key: "TEST_VENDOR_KEY", revision, ...(action === "put" ? { value: VALUE } : {}) }),
  expires_at: Date.now() + 60_000,
  ...extra,
});

describe("channel-server ↔ agent-node node-secret parity", () => {
  test("list/put/delete, replay, conflicts and validation project identically", () => {
    const channelDir = fixture();
    const agentDir = fixture();
    const run = (input: any): [Outcome, Outcome] => [
      outcome(() => operateChannel(channelDir, structuredClone(input))),
      outcome(() => operateAgentNode(agentDir, structuredClone(input))),
    ];
    const assertSame = (label: string, input: any): Outcome => {
      const [channel, agent] = run(input);
      expect({ label, ...channel }).toEqual({ label, ...agent });
      return channel;
    };

    expect(assertSame("list empty", req("list", 0))).toEqual({
      ok: true,
      value: { network_id: NET_ID, daemon_node_id: null, node_id: NODE_ID, revision: 0, activation: "next_start", keys: [] },
    });

    const firstPut = req("put", 0);
    expect(assertSame("put first", firstPut)).toEqual({
      ok: true,
      value: {
        network_id: NET_ID, daemon_node_id: null, node_id: NODE_ID, revision: 1, activation: "next_start",
        keys: [{ key: "TEST_VENDOR_KEY", source: "node" }],
      },
    });
    // Exact replay: no revision bump on either side.
    expect(assertSame("exact replay", firstPut)).toEqual(assertSame("exact replay again", firstPut));

    assertSame("list after put", req("list", 0));
    expect(assertSame("put second key", req("put", 1, { key: "ALPHA_KEY", value: "a" }))).toEqual({
      ok: true,
      value: {
        network_id: NET_ID, daemon_node_id: null, node_id: NODE_ID, revision: 2, activation: "next_start",
        keys: [{ key: "ALPHA_KEY", source: "node" }, { key: "TEST_VENDOR_KEY", source: "node" }],
      },
    });

    // Same request_id, different digest.
    assertSame("replay with different value", { ...firstPut, value: "different" });

    // Stale revision (both stores are at revision 2).
    assertSame("stale revision", req("put", 1, { key: "THIRD_KEY", value: "x" }));

    expect(assertSame("delete first key", req("delete", 2))).toEqual({
      ok: true,
      value: {
        network_id: NET_ID, daemon_node_id: null, node_id: NODE_ID, revision: 3, activation: "next_start",
        keys: [{ key: "ALPHA_KEY", source: "node" }],
      },
    });

    // Validation and identity guards.
    assertSame("lower-case key", req("put", 3, { key: "lower_case", value: "x" }));
    assertSame("reserved key", req("put", 3, { key: "COMMHUB_TOKEN", value: "x" }));
    assertSame("empty value", req("put", 3, { value: "" }));
    assertSame("oversized value", req("put", 3, { value: "x".repeat(8193) }));
    assertSame("literal backslash-zero", req("put", 3, { value: "a\\0b" }));
    assertSame("negative revision", req("put", -1));
    assertSame("non-integer revision", req("put", 1.5));
    assertSame("wrong request prefix", { ...req("list", 0), request_id: `dsk_${randomUUID()}` });
    assertSame("wrong node", { ...req("list", 0), node_id: "other" });
    assertSame("wrong network", { ...req("list", 0), network_id: "other" });
    assertSame("daemon-bound request", { ...req("list", 0), daemon_node_id: "daemon" });
    assertSame("unknown action", { ...req("list", 0), action: "read" });
    assertSame("delete absent key", req("delete", 3, { key: "NOT_THERE" }));

    // The persisted projection is identical, not just the return value.
    const channelFile = join(channelDir, "node-secrets.json");
    const agentFile = join(agentDir, "node-secrets.json");
    expect(JSON.parse(readFileSync(channelFile, "utf8"))).toEqual(JSON.parse(readFileSync(agentFile, "utf8")));
    expect(readFileSync(channelFile, "utf8")).toBe(readFileSync(agentFile, "utf8"));
    expect(statSync(channelFile).mode & 0o777).toBe(0o600);
    expect(statSync(agentFile).mode & 0o777).toBe(0o600);
  });

  test("the max-entry guard and a missing store behave identically", () => {
    const channelDir = fixture();
    const agentDir = fixture();
    // Seed 128 valid entries directly (below the write cap) via identical puts.
    for (let i = 0; i < 128; i++) {
      const input = req("put", i, { key: `KEY_${String(i).padStart(3, "0")}`, value: "v" });
      expect(outcome(() => operateChannel(channelDir, structuredClone(input)))).toEqual(
        outcome(() => operateAgentNode(agentDir, structuredClone(input))),
      );
    }
    const overflow = req("put", 128, { key: "OVERFLOW_KEY", value: "v" });
    expect(outcome(() => operateChannel(channelDir, structuredClone(overflow)))).toEqual(
      outcome(() => operateAgentNode(agentDir, structuredClone(overflow))),
    );
    expect(JSON.parse(readFileSync(join(channelDir, "node-secrets.json"), "utf8")).values.OVERFLOW_KEY).toBeUndefined();
    expect(JSON.parse(readFileSync(join(agentDir, "node-secrets.json"), "utf8")).values.OVERFLOW_KEY).toBeUndefined();
  });
});
