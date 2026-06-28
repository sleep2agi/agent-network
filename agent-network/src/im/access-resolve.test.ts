// Coverage for the inbound-channel access resolver. The fail-closed
// flip is a deliberate security change in v0.11 — these tests pin the
// new behaviour so a future "convenience" patch can't quietly restore
// the old fail-open default.

import { describe, expect, test } from "bun:test";
import {
  resolveTelegramAccess,
  resolveFeishuAccess,
  normalizeAllowFrom,
  buildEmptyAllowlistWarn,
  loadTelegramAccess,
} from "./access-resolve";

describe("normalizeAllowFrom — input shapes", () => {
  test("real string[] passes through deduped (filter empty strings)", () => {
    const r = normalizeAllowFrom(["123", "@vansin", "", "456"]);
    expect(r.list).toEqual(["123", "@vansin", "456"]);
    expect(r.malformed).toBe(false);
  });

  test("undefined → empty + not malformed", () => {
    expect(normalizeAllowFrom(undefined)).toEqual({ list: [], malformed: false });
  });

  test("null → empty + not malformed", () => {
    expect(normalizeAllowFrom(null)).toEqual({ list: [], malformed: false });
  });

  test("non-array object → empty + malformed (corrupted access.json shape)", () => {
    expect(normalizeAllowFrom({ allowFrom: ["123"] })).toEqual({ list: [], malformed: true });
  });

  test("string instead of array → malformed", () => {
    expect(normalizeAllowFrom("123")).toEqual({ list: [], malformed: true });
  });

  test("array with non-string elements drops them", () => {
    const r = normalizeAllowFrom([123, "valid", null, "ok"]);
    expect(r.list).toEqual(["valid", "ok"]);
    expect(r.malformed).toBe(false);
  });
});

describe("resolveTelegramAccess — fail-closed empty allowFrom (v0.11 security change)", () => {
  test("empty array → deny with empty-fail-closed kind", () => {
    const d = resolveTelegramAccess({ allowFrom: [], senderId: "123" });
    expect(d.allow).toBe(false);
    expect(d.kind).toBe("empty-fail-closed");
    expect(d.reason).toContain("fail-closed");
  });

  test("undefined → deny", () => {
    const d = resolveTelegramAccess({ allowFrom: undefined, senderId: "123" });
    expect(d.allow).toBe(false);
    expect(d.kind).toBe("empty-fail-closed");
  });

  test("malformed → deny + reason mentions malformed", () => {
    const d = resolveTelegramAccess({ allowFrom: "garbage", senderId: "123" });
    expect(d.allow).toBe(false);
    expect(d.kind).toBe("empty-fail-closed");
    expect(d.reason).toMatch(/malformed/);
  });
});

describe("resolveTelegramAccess — wildcard '*' opens the channel", () => {
  test("['*'] alone allows any sender", () => {
    const d = resolveTelegramAccess({ allowFrom: ["*"], senderId: "anyone" });
    expect(d.allow).toBe(true);
    expect(d.kind).toBe("wildcard-allow");
  });

  test("['*', 'specific_id'] still wildcard-allows (wins precedence)", () => {
    const d = resolveTelegramAccess({ allowFrom: ["*", "123"], senderId: "stranger" });
    expect(d.allow).toBe(true);
    expect(d.kind).toBe("wildcard-allow");
  });
});

describe("resolveTelegramAccess — explicit id / username matching", () => {
  test("senderId in list → allow", () => {
    const d = resolveTelegramAccess({ allowFrom: ["123", "456"], senderId: "456" });
    expect(d.allow).toBe(true);
    expect(d.kind).toBe("explicit-allow");
    expect(d.reason).toContain("456");
  });

  test("senderUsername match (no id match) → allow", () => {
    const d = resolveTelegramAccess({
      allowFrom: ["@vansin"],
      senderId: "999",
      senderUsername: "@vansin",
    });
    expect(d.allow).toBe(true);
    expect(d.kind).toBe("explicit-allow");
  });

  test("neither id nor username in list → deny", () => {
    const d = resolveTelegramAccess({
      allowFrom: ["123", "@vansin"],
      senderId: "stranger",
      senderUsername: "@stranger",
    });
    expect(d.allow).toBe(false);
    expect(d.kind).toBe("denied");
  });

  test("empty senderUsername doesn't accidentally match empty list entry", () => {
    // Filter in normalizeAllowFrom drops empty strings; defensive test.
    const d = resolveTelegramAccess({
      allowFrom: ["", "123"],
      senderId: "999",
      senderUsername: "",
    });
    expect(d.allow).toBe(false);
  });

  test("blank-string id with username match still allows", () => {
    const d = resolveTelegramAccess({
      allowFrom: ["@vansin"],
      senderId: "",
      senderUsername: "@vansin",
    });
    expect(d.allow).toBe(true);
  });

  // Production-shape regression (通信牛 #276 round-2 review).
  // Real telegram payloads put `msg.from.username` WITHOUT the @ prefix
  // ("vansin", not "@vansin"). Existing tests used "@vansin" on both
  // sides which let a buggy resolver still pass. Pin the bare-name shape
  // so an operator who writes `allowFrom:["vansin"]` (the obvious one)
  // gets matched against the real telegram payload.
  test("production-shape: bare username (no @) in allowFrom matches bare msg.from.username", () => {
    const d = resolveTelegramAccess({
      allowFrom: ["vansin"],         // operator types name without @
      senderId: "12345",
      senderUsername: "vansin",      // telegram payload shape: no @
    });
    expect(d.allow).toBe(true);
    expect(d.kind).toBe("explicit-allow");
  });

  test("production-shape mismatch: @vansin in allowFrom does NOT match bare vansin payload", () => {
    // Operator wrote @vansin (looking at telegram UI which shows @)
    // but real payload is "vansin" — must reject so the operator gets
    // a clear "your config doesn't match what arrives" signal instead
    // of silent fail-open.
    const d = resolveTelegramAccess({
      allowFrom: ["@vansin"],
      senderId: "12345",
      senderUsername: "vansin",      // no @ in real payload
    });
    expect(d.allow).toBe(false);
    expect(d.kind).toBe("denied");
  });
});

describe("resolveFeishuAccess — DM path mirrors telegram fail-closed", () => {
  test("empty allowFrom → deny", () => {
    const d = resolveFeishuAccess({
      conversationType: "dm",
      allowFrom: [],
      allowChats: [],
      senderId: "ou_abc",
      conversationId: "oc_dm",
      groupPolicy: "all",
    });
    expect(d.allow).toBe(false);
    expect(d.kind).toBe("empty-fail-closed");
    expect(d.reason).toContain("dm");
  });

  test("wildcard allows", () => {
    const d = resolveFeishuAccess({
      conversationType: "dm",
      allowFrom: ["*"],
      allowChats: [],
      senderId: "ou_abc",
      conversationId: "oc_dm",
      groupPolicy: "all",
    });
    expect(d.allow).toBe(true);
    expect(d.kind).toBe("wildcard-allow");
  });

  test("specific id allows", () => {
    const d = resolveFeishuAccess({
      conversationType: "dm",
      allowFrom: ["ou_abc"],
      allowChats: [],
      senderId: "ou_abc",
      conversationId: "oc_dm",
      groupPolicy: "all",
    });
    expect(d.allow).toBe(true);
    expect(d.kind).toBe("explicit-allow");
  });

  test("sender not in list → deny", () => {
    const d = resolveFeishuAccess({
      conversationType: "dm",
      allowFrom: ["ou_other"],
      allowChats: [],
      senderId: "ou_stranger",
      conversationId: "oc_dm",
      groupPolicy: "all",
    });
    expect(d.allow).toBe(false);
    expect(d.kind).toBe("denied");
  });
});

describe("resolveFeishuAccess — group path (allowChats + groupPolicy)", () => {
  test("empty allowChats → fail-closed", () => {
    const d = resolveFeishuAccess({
      conversationType: "group",
      allowFrom: [],
      allowChats: [],
      senderId: "ou_abc",
      conversationId: "oc_group1",
      groupPolicy: "all",
    });
    expect(d.allow).toBe(false);
    expect(d.kind).toBe("empty-fail-closed");
    expect(d.reason).toMatch(/group/);
  });

  test("chat in allowChats + groupPolicy=all → allow", () => {
    const d = resolveFeishuAccess({
      conversationType: "group",
      allowFrom: [],
      allowChats: ["oc_group1"],
      senderId: "ou_abc",
      conversationId: "oc_group1",
      groupPolicy: "all",
    });
    expect(d.allow).toBe(true);
    expect(d.kind).toBe("explicit-allow");
  });

  test("chat in allowChats + groupPolicy=observe → deny", () => {
    const d = resolveFeishuAccess({
      conversationType: "group",
      allowFrom: [],
      allowChats: ["oc_group1"],
      senderId: "ou_abc",
      conversationId: "oc_group1",
      groupPolicy: "observe",
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("observe");
  });

  test("chat NOT in allowChats → deny (even with policy=all)", () => {
    const d = resolveFeishuAccess({
      conversationType: "group",
      allowFrom: [],
      allowChats: ["oc_other"],
      senderId: "ou_abc",
      conversationId: "oc_group1",
      groupPolicy: "all",
    });
    expect(d.allow).toBe(false);
    expect(d.kind).toBe("denied");
    expect(d.reason).toMatch(/chat not in allowChats/);
  });

  test("wildcard chats opens any chat (with groupPolicy=all)", () => {
    const d = resolveFeishuAccess({
      conversationType: "group",
      allowFrom: [],
      allowChats: ["*"],
      senderId: "ou_abc",
      conversationId: "oc_anything",
      groupPolicy: "all",
    });
    expect(d.allow).toBe(true);
  });

  test("groupPolicy=mention allows (caller decides at message inspect time)", () => {
    const d = resolveFeishuAccess({
      conversationType: "group",
      allowFrom: [],
      allowChats: ["oc_group1"],
      senderId: "ou_abc",
      conversationId: "oc_group1",
      groupPolicy: "mention",
    });
    expect(d.allow).toBe(true);
  });
});

describe("buildEmptyAllowlistWarn — boot-time visibility", () => {
  test("returns warn string for empty allowFrom", () => {
    const w = buildEmptyAllowlistWarn({
      channel: "telegram",
      channelDir: "/some/dir",
      allowFrom: [],
    });
    expect(w).not.toBeNull();
    expect(w).toContain("FAIL-CLOSED");
    expect(w).toContain("telegram");
    expect(w).toContain("/some/dir");
  });

  test("returns warn string for malformed allowFrom + mentions malformed", () => {
    const w = buildEmptyAllowlistWarn({
      channel: "telegram",
      channelDir: "/d",
      allowFrom: "garbage",
    });
    expect(w).toContain("malformed");
  });

  test("returns null when allowFrom has at least one entry", () => {
    const w = buildEmptyAllowlistWarn({
      channel: "telegram",
      channelDir: "/d",
      allowFrom: ["123"],
    });
    expect(w).toBeNull();
  });

  test("returns null for wildcard-allow (channel intentionally open)", () => {
    const w = buildEmptyAllowlistWarn({
      channel: "telegram",
      channelDir: "/d",
      allowFrom: ["*"],
    });
    expect(w).toBeNull();
  });
});

describe("loadTelegramAccess + resolver — wiring regression (CHANGE_REQ on #276)", () => {
  // Background: `initTelegramChannel` used to normalise allowFrom via
  // `Array.isArray(...) ? .map(String) : []`. For an access.json shape
  // of `{allowFrom: [123]}`, the result was `["123"]` — a non-empty
  // string list that the resolver then treats as a valid allowlist.
  // The fail-closed flip was bypassed for any caller whose id stringified
  // to a member of that list. These tests pin the fix at the wiring
  // layer (loader → channel state → resolver) so a future "convenience"
  // cleanup cannot re-introduce the bypass.

  test("loader stores raw allowFrom verbatim — no normalization at load time", () => {
    // Subtle but important: the loader MUST pass `allowFromRaw`
    // through unchanged. Any cleanup / coercion at this layer
    // re-introduces the bypass class.
    const loaded = loadTelegramAccess({
      channelDir: "/tmp/x",
      parsedAccess: { allowFrom: [123, null, { foo: "bar" }, "@vansin"] as any },
    });
    expect(loaded.allowFromRaw).toEqual([123, null, { foo: "bar" }, "@vansin"]);
  });

  test("loader emits boot-warn when allowFrom is missing", () => {
    const loaded = loadTelegramAccess({ channelDir: "/tmp/x", parsedAccess: {} });
    expect(loaded.bootWarn).not.toBeNull();
  });

  test("loader emits boot-warn when allowFrom is malformed (non-array)", () => {
    const loaded = loadTelegramAccess({ channelDir: "/tmp/x", parsedAccess: { allowFrom: "wrong" as any } });
    expect(loaded.bootWarn).not.toBeNull();
    expect(loaded.bootWarn).toMatch(/malformed/);
  });

  test("loader is silent when allowFrom has at least one entry (even if numeric)", () => {
    // The boot-warn fires on EMPTY (after normalization) — `[123]` is
    // empty after filter-non-strings, so the warn SHOULD fire. This
    // test pins that contract.
    const loaded = loadTelegramAccess({ channelDir: "/tmp/x", parsedAccess: { allowFrom: [123] as any } });
    expect(loaded.bootWarn).not.toBeNull();
  });

  test("[123] alone (numeric sender id from a misformatted access.json) → loader+resolver fail-closed", () => {
    // The exact bypass shape from the CHANGE_REQ on #276. A misformatted
    // access.json with numeric ids would, pre-fix, normalize to ["123"]
    // and the resolver would happily allow sender id "123".
    const loaded = loadTelegramAccess({ channelDir: "/d", parsedAccess: { allowFrom: [123] as any } });
    const decision = resolveTelegramAccess({
      allowFrom: loaded.allowFromRaw,
      senderId: "123",
    });
    expect(decision.allow).toBe(false);
    expect(decision.kind).toBe("empty-fail-closed");
  });

  test("[null] (corrupted access.json) → loader+resolver fail-closed", () => {
    const loaded = loadTelegramAccess({ channelDir: "/d", parsedAccess: { allowFrom: [null] as any } });
    const decision = resolveTelegramAccess({
      allowFrom: loaded.allowFromRaw,
      senderId: "anyone",
    });
    expect(decision.allow).toBe(false);
    expect(decision.kind).toBe("empty-fail-closed");
  });

  test("[{}] (object instead of id string) → loader+resolver fail-closed", () => {
    const loaded = loadTelegramAccess({ channelDir: "/d", parsedAccess: { allowFrom: [{}] as any } });
    const decision = resolveTelegramAccess({
      allowFrom: loaded.allowFromRaw,
      senderId: "anyone",
    });
    expect(decision.allow).toBe(false);
    expect(decision.kind).toBe("empty-fail-closed");
  });

  test("[123, '@vansin'] (mixed) → '@vansin' still allowed, numeric '123' rejected", () => {
    // Mixed list keeps the valid string entries — `@vansin` should still
    // be allowed, but a sender that happens to stringify to "123" must
    // still be denied (no implicit number → string coercion at lookup).
    const loaded = loadTelegramAccess({ channelDir: "/d", parsedAccess: { allowFrom: [123, "@vansin"] as any } });
    const allowVansin = resolveTelegramAccess({
      allowFrom: loaded.allowFromRaw,
      senderId: "999",
      senderUsername: "@vansin",
    });
    expect(allowVansin.allow).toBe(true);
    expect(allowVansin.kind).toBe("explicit-allow");

    const denyNumericSender = resolveTelegramAccess({
      allowFrom: loaded.allowFromRaw,
      senderId: "123",
      senderUsername: undefined,
    });
    expect(denyNumericSender.allow).toBe(false);
    expect(denyNumericSender.kind).toBe("denied");
  });

  test("[null, '*'] (mixed wildcard) → wildcard wins despite garbage entries", () => {
    // The valid `"*"` entry MUST still open the channel — garbage entries
    // shouldn't poison wildcard handling either.
    const loaded = loadTelegramAccess({ channelDir: "/d", parsedAccess: { allowFrom: [null, "*"] as any } });
    const d = resolveTelegramAccess({
      allowFrom: loaded.allowFromRaw,
      senderId: "anyone",
    });
    expect(d.allow).toBe(true);
    expect(d.kind).toBe("wildcard-allow");
  });

  test("missing access.json entirely (loader gets null) → fail-closed", () => {
    const loaded = loadTelegramAccess({ channelDir: "/d", parsedAccess: null });
    expect(loaded.allowFromRaw).toBeUndefined();
    const d = resolveTelegramAccess({ allowFrom: loaded.allowFromRaw, senderId: "x" });
    expect(d.allow).toBe(false);
    expect(d.kind).toBe("empty-fail-closed");
  });
});

describe("regression — pre-v0.11 fail-open MUST NOT come back", () => {
  // The fail-open default was the root cause of the v0.11 security
  // patch. If a future "convenience" PR tries to restore it, these
  // tests fail.

  test("empty array NEVER allows", () => {
    expect(resolveTelegramAccess({ allowFrom: [], senderId: "x" }).allow).toBe(false);
  });

  test("undefined NEVER allows", () => {
    expect(resolveTelegramAccess({ allowFrom: undefined, senderId: "x" }).allow).toBe(false);
  });

  test("null NEVER allows", () => {
    expect(resolveTelegramAccess({ allowFrom: null, senderId: "x" }).allow).toBe(false);
  });

  test("object-shape (corrupted) NEVER allows", () => {
    expect(resolveTelegramAccess({ allowFrom: {} as any, senderId: "x" }).allow).toBe(false);
  });
});
