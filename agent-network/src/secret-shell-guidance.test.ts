import { describe, expect, test } from "bun:test";
import {
  formatSecretAssignment,
  secretPersistenceHeading,
  secretShellAction,
} from "./secret-shell-guidance";

describe("#379 secret shell guidance", () => {
  test("keeps the existing POSIX export form", () => {
    expect(formatSecretAssignment("linux", "API_TOKEN_NODE", "a'b")).toBe(
      `export API_TOKEN_NODE='a'\\''b'`,
    );
    expect(secretPersistenceHeading("linux")).toContain("~/.bashrc / ~/.zshrc");
    expect(secretShellAction("linux")).toBe("export");
  });

  test("uses PowerShell syntax and quote escaping on Windows", () => {
    expect(formatSecretAssignment("win32", "API_TOKEN_NODE", "a'b")).toBe(
      `$env:API_TOKEN_NODE='a''b'`,
    );
    expect(secretPersistenceHeading("win32")).toContain("PowerShell $PROFILE");
    expect(secretPersistenceHeading("win32")).not.toContain(".bashrc");
    expect(secretShellAction("win32")).toBe("set");
  });
});
