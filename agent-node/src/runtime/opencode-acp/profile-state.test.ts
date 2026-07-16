import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  backupOpencodeConfig,
  configStateDeclaresOpencode,
  loadOpencodeConfigWithSelfHeal,
  readOpencodeConfig,
  writeOpencodeConfig,
  writebackOpencodeSession,
} from "./profile-state";

function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `opencode-profile-state-${label}-`));
  const node = join(root, "node");
  const config = join(node, "config.json");
  mkdirSync(node, { mode: 0o700 });
  chmodSync(node, 0o700);
  writeFileSync(config, JSON.stringify({ runtime: "opencode-cli", session: "old" }) + "\n", {
    mode: 0o600,
  });
  chmodSync(config, 0o600);
  return { root, node, config };
}

describe("OpenCode private profile state", () => {
  test("loads, atomically updates, backs up, and writes a session", () => {
    const f = fixture("happy");
    try {
      expect(configStateDeclaresOpencode(f.config)).toBe(true);
      expect(loadOpencodeConfigWithSelfHeal(f.config).config.runtime).toBe("opencode-cli");
      const next = readOpencodeConfig(f.config);
      next.model = "opencode/deepseek-v4-flash-free";
      writeOpencodeConfig(f.config, next);
      expect(readOpencodeConfig(f.config).model).toBe("opencode/deepseek-v4-flash-free");
      expect(backupOpencodeConfig(f.config).backedUp).toBe(true);
      expect(writebackOpencodeSession(f.config, "new-session")).toBe(true);
      expect(readOpencodeConfig(f.config).session).toBe("new-session");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("a post-load config symlink cannot redirect session writeback", () => {
    const f = fixture("session-symlink");
    const outside = join(f.root, "outside.json");
    const original = '{"must":"stay"}\n';
    try {
      writeFileSync(outside, original, { mode: 0o600 });
      unlinkSync(f.config);
      symlinkSync(outside, f.config);
      expect(() => writebackOpencodeSession(f.config, "stolen")).toThrow(/refuses|symlink/);
      expect(readFileSync(outside, "utf8")).toBe(original);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("boot refuses a config symlink before self-heal can write its target", () => {
    const f = fixture("boot-symlink");
    const outside = join(f.root, "outside.json");
    const original = "not-json\n";
    try {
      writeFileSync(outside, original, { mode: 0o600 });
      writeFileSync(`${f.config}.prev`, '{"runtime":"opencode-cli"}\n', { mode: 0o600 });
      unlinkSync(f.config);
      symlinkSync(outside, f.config);
      expect(() => loadOpencodeConfigWithSelfHeal(f.config)).toThrow(/refuses|single-link/);
      expect(readFileSync(outside, "utf8")).toBe(original);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("backup refuses a pre-planted .prev symlink", () => {
    const f = fixture("prev-symlink");
    const outside = join(f.root, "outside.json");
    const original = '{"must":"stay"}\n';
    try {
      writeFileSync(outside, original, { mode: 0o600 });
      symlinkSync(outside, `${f.config}.prev`);
      expect(() => backupOpencodeConfig(f.config)).toThrow(/refuses|single-link/);
      expect(readFileSync(outside, "utf8")).toBe(original);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("runtime hint rejects suspicious config leaves for every runtime", () => {
    const f = fixture("hint-symlink");
    const outside = join(f.root, "outside.json");
    try {
      writeFileSync(outside, '{"runtime":"claude-agent-sdk"}\n');
      unlinkSync(f.config);
      symlinkSync(outside, f.config);
      expect(() => configStateDeclaresOpencode(f.config)).toThrow(/symlinks/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

