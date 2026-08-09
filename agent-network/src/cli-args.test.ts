import { describe, expect, test } from "bun:test";
import { BOOLEAN_FLAGS, parseCliOptions, positionalArgs } from "./cli-args";

const formerlyMissingBooleanFlags = [
  "accept-dev-channels",
  "dev-open",
  "dry-run",
  "follow",
  "no-auto-self",
  "no-yolo",
  "resume-latest",
  "self",
  "f",
];

describe("CLI argument parsing", () => {
  test("pins the complete presence-only flag set", () => {
    expect([...BOOLEAN_FLAGS].sort()).toEqual([
      "--accept-dev-channels",
      "--all",
      "--copresence",
      "--dangerously-allow-full-access",
      "--dev-open",
      "--dry-run",
      "--f",
      "--follow",
      "--grok-headless",
      "--new-session",
      "--no-auto-self",
      "--no-yolo",
      "--resume-latest",
      "--self",
      "--tmux",
      "--yes-danger-full-access",
    ]);
  });

  for (const flag of formerlyMissingBooleanFlags) {
    test(`--${flag} does not swallow a following positional operand`, () => {
      const argv = [`--${flag}`, "node-a"];
      expect(parseCliOptions(argv)[flag]).toBe("true");
      expect(positionalArgs(argv)).toEqual(["node-a"]);
    });

    test(`--${flag} works after a positional operand`, () => {
      const argv = ["node-a", `--${flag}`];
      expect(parseCliOptions(argv)[flag]).toBe("true");
      expect(positionalArgs(argv)).toEqual(["node-a"]);
    });
  }

  test("presence-only flags do not accept an explicit true or false value", () => {
    expect(parseCliOptions(["--dry-run", "false"])["dry-run"]).toBe("true");
    expect(positionalArgs(["--dry-run", "false"])).toEqual(["false"]);
  });

  test("value flags, repeatable flags, and multiple positionals retain their behavior", () => {
    const argv = [
      "node-a",
      "--runtime", "codex-sdk",
      "--channel", "server:commhub",
      "--channel", "feishu:ops",
      "--env", "A=1",
      "--dry-run",
      "node-b",
    ];
    const parsed = parseCliOptions(argv);
    expect(parsed.runtime).toBe("codex-sdk");
    expect(parsed["dry-run"]).toBe("true");
    expect(parsed._channels).toEqual(["server:commhub", "feishu:ops"]);
    expect(parsed._envs).toEqual(["A=1"]);
    expect(positionalArgs(argv)).toEqual(["node-a", "node-b"]);
  });

  test("key=value remains unsupported and is treated as the complete key", () => {
    expect(parseCliOptions(["--runtime=codex-sdk"])).toEqual({
      _channels: [],
      _envs: [],
      "runtime=codex-sdk": "true",
    });
    expect(positionalArgs(["--runtime=codex-sdk"])).toEqual([]);
  });
});
