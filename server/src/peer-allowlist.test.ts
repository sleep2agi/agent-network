// 2026-11-11 安全排查：COMMHUB_ALLOWED_PEER_IPS —— Hub 端口只接名单里的对端 + 本机回环。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

process.env.COMMHUB_DB ||= join(mkdtempSync(join(tmpdir(), "anet-peer-")), "hub.db");
const { peerAllowed } = await import("./server.js");

describe("peerAllowed", () => {
  const list = new Set(["47.0.0.1"]);
  test("unset = no restriction (old behaviour)", () => {
    expect(peerAllowed("203.0.113.9", null)).toBe(true);
  });
  test("loopback always allowed (frp, local nodes)", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.1.1"]) expect(peerAllowed(ip, list)).toBe(true);
  });
  test("listed proxy allowed, IPv4-mapped too", () => {
    expect(peerAllowed("47.0.0.1", list)).toBe(true);
    expect(peerAllowed("::ffff:47.0.0.1", list)).toBe(true);
  });
  test("anyone else refused", () => {
    expect(peerAllowed("203.0.113.9", list)).toBe(false);
    expect(peerAllowed("::ffff:203.0.113.9", list)).toBe(false);
  });
  test("unknown peer is not refused (never lock everyone out on a missing address)", () => {
    expect(peerAllowed(null, list)).toBe(true);
  });
});
