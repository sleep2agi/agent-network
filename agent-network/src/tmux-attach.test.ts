import { describe, expect, test } from "bun:test";
import { findExactTmuxSession, parseTmuxSessions } from "./tmux-attach";

describe("tmux attach resolution", () => {
  const listing = "$1\t通信牛-node\n$2\t通信牛\n$3\t通信牛-桥\n";

  test("parses opaque IDs and Unicode names", () => {
    expect(parseTmuxSessions(listing)).toEqual([
      { id: "$1", name: "通信牛-node" },
      { id: "$2", name: "通信牛" },
      { id: "$3", name: "通信牛-桥" },
    ]);
  });

  test("selects the exact TUI instead of prefix siblings", () => {
    expect(findExactTmuxSession(listing, "通信牛")).toEqual({ id: "$2", name: "通信牛" });
  });

  test("does not fall back to a bridge or node session", () => {
    expect(findExactTmuxSession("$1\t通信牛-node\n$3\t通信牛-桥\n", "通信牛")).toBeNull();
  });
});
