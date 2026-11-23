import { describe, expect, test } from "bun:test";
import { isWithinWorkspacePath, opencodeDirectoryHeader, sameWorkspacePath } from "./workspace-path";

describe("workspace paths: POSIX stays byte-exact", () => {
  test("equality is string equality", () => {
    expect(sameWorkspacePath("/ws", "/ws", "linux")).toBe(true);
    expect(sameWorkspacePath("/ws", "/WS", "linux")).toBe(false);
    expect(sameWorkspacePath("/ws", "/ws/", "linux")).toBe(false);
    expect(sameWorkspacePath("/ws", undefined, "linux")).toBe(false);
  });
  test("containment is boundary-checked", () => {
    expect(isWithinWorkspacePath("/ws", "/ws", "linux")).toBe(true);
    expect(isWithinWorkspacePath("/ws/wt/branch", "/ws", "linux")).toBe(true);
    expect(isWithinWorkspacePath("/ws-2", "/ws", "linux")).toBe(false);
    expect(isWithinWorkspacePath("/ws/../etc", "/ws", "linux")).toBe(false);
    expect(isWithinWorkspacePath("", "/ws", "linux")).toBe(false);
  });
});

describe("workspace paths: Windows spellings of one directory are one directory", () => {
  const ws = "D:\\工作 目录\\项目A";
  test("drive case, slash direction and a trailing separator do not matter", () => {
    for (const other of ["d:\\工作 目录\\项目A", "D:/工作 目录/项目A", "D:\\工作 目录\\项目A\\", "D:\\工作 目录\\.\\项目A"]) {
      expect(sameWorkspacePath(ws, other, "win32")).toBe(true);
      expect(isWithinWorkspacePath(other, ws, "win32")).toBe(true);
    }
    expect(sameWorkspacePath(ws, "D:\\工作 目录\\项目B", "win32")).toBe(false);
  });
  test("inside, sibling, parent, other drive, drive root", () => {
    expect(isWithinWorkspacePath("d:/工作 目录/项目A/wt/branch", ws, "win32")).toBe(true);
    expect(isWithinWorkspacePath("D:\\工作 目录\\项目A-2", ws, "win32")).toBe(false);
    expect(isWithinWorkspacePath("D:\\工作 目录", ws, "win32")).toBe(false);
    expect(isWithinWorkspacePath("C:\\工作 目录\\项目A", ws, "win32")).toBe(false);
    expect(isWithinWorkspacePath("D:\\工作 目录\\项目A\\..\\项目B", ws, "win32")).toBe(false);
    expect(isWithinWorkspacePath("D:\\ws", "D:\\", "win32")).toBe(true);
    expect(isWithinWorkspacePath("E:\\ws", "D:\\", "win32")).toBe(false);
  });
});

describe("the directory request header", () => {
  test("paths that fit in a header are sent unchanged", () => {
    for (const dir of ["/home/a/ws", "/home/a/my ws", "D:\\anet nodes\\ops", "C:\\Users\\a~1"]) {
      expect(opencodeDirectoryHeader(dir)).toBe(dir);
    }
  });
  test("a path fetch would refuse is percent-encoded and can be sent", () => {
    const dir = "D:\\anet-3812-probe\\工作 目录";
    const value = opencodeDirectoryHeader(dir);
    expect(value).toBe(encodeURIComponent(dir));
    expect(decodeURIComponent(value)).toBe(dir);
    expect(() => new Headers({ "x-opencode-directory": dir })).toThrow();
    expect(() => new Headers({ "x-opencode-directory": value })).not.toThrow();
  });
});
