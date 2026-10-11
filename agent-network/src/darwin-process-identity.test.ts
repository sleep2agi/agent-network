import { describe, expect, test } from "bun:test";
import { parseDarwinBsdInfo, parseDarwinEnvironment } from "./darwin-process-identity";

function args(argv: string[], environment: string[]): Buffer {
  const argc = Buffer.alloc(4); argc.writeInt32LE(argv.length);
  return Buffer.concat([argc, Buffer.from(`/usr/bin/codex\0\0${argv.join("\0")}\0${environment.join("\0")}\0`)]);
}

describe("Darwin kernel process identity", () => {
  test("an argv marker is not ownership; native environment keeps spaces and empty arguments", () => {
    const raw = args(["codex", "ANET_NODE_MARKER=foreign", ""], ["ANET_NODE_MARKER=owned", "CODEX_HOME=/private/node with spaces"]);
    expect(parseDarwinEnvironment(raw).split("\0")).toEqual(["ANET_NODE_MARKER=owned", "CODEX_HOME=/private/node with spaces", ""]);
  });
  test("truncated argv/environment and invalid argc are refused", () => {
    expect(() => parseDarwinEnvironment(Buffer.from([0, 0, 0, 0, 0]))).toThrow();
    expect(() => parseDarwinEnvironment(args(["codex"], ["X=1"]).subarray(0, -1))).toThrow();
    const raw = args(["codex"], []); raw.writeInt32LE(1000);
    expect(() => parseDarwinEnvironment(raw)).toThrow();
  });
  test("kernel birth has microsecond precision and distinguishes reused PIDs", () => {
    const raw = Buffer.alloc(136);
    raw.writeUInt32LE(123, 12); raw.writeUInt32LE(10, 16);
    raw.writeUInt32LE(501, 28); raw.writeUInt32LE(123, 100);
    raw.writeBigUInt64LE(1_791_690_000n, 120); raw.writeBigUInt64LE(123_456n, 128);
    const first = parseDarwinBsdInfo(raw);
    expect(first).toEqual({ pid: 123, ppid: 10, pgid: 123, uid: 501, starttime_jiffies: 1_791_690_000_123_456, state: "R" });
    raw.writeBigUInt64LE(123_457n, 128);
    expect(parseDarwinBsdInfo(raw).starttime_jiffies).not.toBe(first.starttime_jiffies);
    raw.writeUInt32LE(5, 4); expect(parseDarwinBsdInfo(raw).state).toBe("Z");
    expect(() => parseDarwinBsdInfo(raw.subarray(0, 135))).toThrow();
    raw.writeBigUInt64LE(1_000_000n, 128); expect(() => parseDarwinBsdInfo(raw)).toThrow();
  });
});
