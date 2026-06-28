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
