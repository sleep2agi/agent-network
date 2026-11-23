import { describe, expect, it } from "vitest";
import { isBenignAckRejection } from "./inbox-ack";

describe("isBenignAckRejection", () => {
  it("treats the Hub's already-acked rejection as benign", () => {
    expect(
      isBenignAckRejection(
        new Error("app-level rejection: message not found or already acknowledged"),
      ),
    ).toBe(true);
  });

  it("treats a bare not-found rejection as benign", () => {
    expect(isBenignAckRejection(new Error("message not found"))).toBe(true);
  });

  it("keeps transport failures fatal", () => {
    expect(isBenignAckRejection(new Error("fetch failed"))).toBe(false);
    expect(isBenignAckRejection(new Error("HTTP 502 bad gateway"))).toBe(false);
    expect(isBenignAckRejection(new Error("unauthorized"))).toBe(false);
  });

  it("accepts non-Error rejections without throwing", () => {
    expect(isBenignAckRejection(undefined)).toBe(false);
    expect(isBenignAckRejection("message not found or already acknowledged")).toBe(true);
  });
});