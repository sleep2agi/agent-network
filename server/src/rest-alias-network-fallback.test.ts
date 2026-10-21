// #1974 —— alias 不在请求的网络里、但在调用者另一个网络里(且唯一)时,发到那儿去。
//
// 三条红线各有���一条断言:只找调用者已加入的网络、同名不猜、没权限不换。
import { describe, expect, test } from "bun:test";
import { pickAliasNetwork } from "./rest-alias-network-fallback.js";

const base = {
  alias: "tang02",
  requestedNetworkId: "net_own",
  memberNetworkIds: ["net_own", "net_team"],
  networksWithAlias: ["net_team"],
  canWrite: () => true,
  canMessage: () => true,
};

describe("pickAliasNetwork (#1974)", () => {
  test("the alias lives in exactly one other member network ⇒ use it", () => {
    expect(pickAliasNetwork({ ...base })).toBe("net_team");
  });

  test("the alias is in the requested network too ⇒ do not switch", () => {
    expect(pickAliasNetwork({ ...base, networksWithAlias: ["net_own", "net_team"] })).toBeNull();
  });

  test("the same alias in two other networks ⇒ do not guess", () => {
    expect(pickAliasNetwork({
      ...base,
      memberNetworkIds: ["net_own", "net_a", "net_b"],
      networksWithAlias: ["net_a", "net_b"],
    })).toBeNull();
  });

  test("a network the caller does not belong to is never used", () => {
    expect(pickAliasNetwork({
      ...base,
      memberNetworkIds: ["net_own"],
      networksWithAlias: ["net_team"],
    })).toBeNull();
  });

  test("no write access in that network ⇒ keep the 404", () => {
    expect(pickAliasNetwork({ ...base, canWrite: () => false })).toBeNull();
  });

  test("no message permission in that network ⇒ keep the 404", () => {
    expect(pickAliasNetwork({ ...base, canMessage: () => false })).toBeNull();
  });

  test("the alias is nowhere ⇒ keep the 404", () => {
    expect(pickAliasNetwork({ ...base, networksWithAlias: [] })).toBeNull();
  });

  test("no membership at all ⇒ keep the 404", () => {
    expect(pickAliasNetwork({ ...base, memberNetworkIds: [] })).toBeNull();
  });

  test("an empty alias is never sent anywhere", () => {
    expect(pickAliasNetwork({ ...base, alias: "   " })).toBeNull();
  });
});
