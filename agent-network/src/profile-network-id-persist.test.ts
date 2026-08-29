// #1469 finding-2 — witnessed-red for the network_id persist gap in
// `serializeProfileForConfigJson` (extracted from saveProfile).
//
// 见红先于见绿:
//   Before: 白名单不含 network_id ⇒ 建于网络 X 的节点写盘后丢失 network_id
//           ⇒ 重加载后 profile.network_id === undefined ⇒ 消费者 fallback
//           到可变的 gc.network_id ⇒ 半对规则:全局网络不变时看似正常,
//           `anet network use Y` 之后节点静默按 Y 跑但 ntok_ 仍绑 X ⇒
//           config/token 网络失配,没错误信息。
//   After:  白名单持久化 network_id ⇒ 重加载后消费者读到真值,不看全局。
//
// 纯逻辑测试:直接对 serializeProfileForConfigJson 断言,零文件系统、零网络、
// 零可变全局。JSON.stringify+parse 走一遍模拟真正的落盘/读回。
import { describe, expect, test } from "bun:test";
import { serializeProfileForConfigJson } from "./profile-serialize";

// Minimum profile satisfying the required Profile fields (channels/env/flags
// are non-optional). Tests focused on network_id treat every other field as
// noise — the only assertions are on the `network_id` key.
const baseProfile = () => ({
  anet_version: "1.0.0",
  node_id: "n_test",
  node_name: "alpha",
  name: "alpha",
  alias: "alpha",
  runtime: "claude-code-cli",
  session: "",
  hub: "http://localhost:9200",
  token: "ntok_test",
  channels: [] as string[],
  env: {},
  flags: {},
} as any);

describe("#1469 finding-2 — network_id persist gap", () => {
  test("🔴 witnessed-red: profile carrying network_id round-trips through toSave shape", () => {
    // Simulate the exact input saveProfile would hand to the serializer:
    // normalizeStoredProfile spreads the input, so normalized.network_id
    // equals profile.network_id when present.
    const profile = { ...baseProfile(), network_id: "net_X_specific" };
    const normalized = { ...profile };  // matches normalizeStoredProfile's spread
    const toSave = serializeProfileForConfigJson(normalized, profile);
    // The whole point: the whitelist must include network_id under this key,
    // with the exact value from the profile.
    expect(toSave.network_id).toBe("net_X_specific");
    // JSON round-trip (what actually lands in config.json + comes back on load).
    const roundTripped = JSON.parse(JSON.stringify(toSave));
    expect(roundTripped.network_id).toBe("net_X_specific");
  });

  test("profile with no network_id ⇒ key OMITTED (not present as undefined)", () => {
    // Pre-1469 nodes and any other legacy load path lack network_id. The
    // whitelist must not sprinkle `network_id: undefined` — that would
    // JSON-serialize as absent anyway, but the invariant we want is the
    // KEY is absent, not just falsy — otherwise `key in` checks elsewhere
    // in the codebase (e.g. authz decisions) could shift semantics silently.
    const profile = baseProfile();
    const normalized = { ...profile };
    const toSave = serializeProfileForConfigJson(normalized, profile);
    expect("network_id" in toSave).toBe(false);
  });

  test("normalized has network_id but profile does not ⇒ persist normalized's value", () => {
    // Direction sanity check: serialization prefers `normalized ?? profile`.
    // Even if a call site hands a stitched-up profile where only normalized
    // carries the id, the write must not drop it.
    const profile = baseProfile();
    const normalized = { ...profile, network_id: "net_from_normalized" };
    const toSave = serializeProfileForConfigJson(normalized, profile);
    expect(toSave.network_id).toBe("net_from_normalized");
  });

  test("profile has network_id but normalized does not ⇒ fall back to profile", () => {
    // Reverse direction: the defensive fallback the fix comment mentions.
    // (normalizeStoredProfile always preserves network_id via its `...project`
    // spread, so in practice normalized === profile for this field; test the
    // fallback anyway so a future change to normalizeStoredProfile that
    // filters network_id out doesn't silently drop the persist too.)
    const profile = { ...baseProfile(), network_id: "net_from_profile" };
    const normalized = { ...profile };
    delete normalized.network_id;
    const toSave = serializeProfileForConfigJson(normalized, profile);
    expect(toSave.network_id).toBe("net_from_profile");
  });

  test("core identity fields still present (regression floor for the refactor)", () => {
    // The fix extracted `toSave` from inline into an exported function; make
    // sure the refactor didn't drop unrelated fields the file-format contract
    // depends on. Not exhaustive — 25 fields would be maintenance noise —
    // just the top-of-file identity block that anet-node reads first.
    const profile = { ...baseProfile(), model: "claude-3-opus", tools: ["fs"], session: "sess_abc" };
    const normalized = { ...profile };
    const toSave = serializeProfileForConfigJson(normalized, profile);
    expect(toSave.anet_version).toBe("1.0.0");
    expect(toSave.node_id).toBe("n_test");
    expect(toSave.node_name).toBe("alpha");
    expect(toSave.runtime).toBe("claude-code-cli");
    expect(toSave.hub).toBe("http://localhost:9200");
    expect(toSave.token).toBe("ntok_test");
    expect(toSave.model).toBe("claude-3-opus");
    expect(toSave.tools).toEqual(["fs"]);
    expect(toSave.session).toBe("sess_abc");
    expect(toSave.channels).toEqual([]);
    expect(toSave.env).toEqual({});
    expect(toSave.flags).toEqual({});
  });
});
