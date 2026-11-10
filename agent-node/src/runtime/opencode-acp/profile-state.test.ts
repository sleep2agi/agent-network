import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  writebackOpencodeConfiguredModel,
  shouldReconcileOpencodeSessionModel,
  armModelReconcile,
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
      expect(writebackOpencodeConfiguredModel(f.config, next.model)).toBe(true);
      expect(writebackOpencodeConfiguredModel(f.config, next.model)).toBe(false);
      expect(readOpencodeConfig(f.config).opencodeConfiguredModelAtLastOpen).toBe(next.model);
      expect(shouldReconcileOpencodeSessionModel(readOpencodeConfig(f.config), next.model)).toBe(false);
      expect(shouldReconcileOpencodeSessionModel(readOpencodeConfig(f.config), "openai/new-model")).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("an existing session without a model baseline keeps the TUI selection", () => {
    expect(shouldReconcileOpencodeSessionModel({ model: "opencode/free" }, "opencode/free")).toBe(false);
    expect(shouldReconcileOpencodeSessionModel({ model: "opencode/free" }, "openai/new-model")).toBe(false);
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


// #3418 —— marker 的语义是「上次打开时一致的那个模型」。会话漂走之后它就是一句谎话，
// 于是 shouldReconcile 永远返回 false，节点永远不自愈、也不喊。armModelReconcile 是解药。
describe("#3418 会话漂出配置后武装一次对账", () => {
  test("清空 marker ⇒ 下一次启动必判差异（空串不等于任何真实模型名）", () => {
    const f = fixture("arm");
    try {
      writebackOpencodeConfiguredModel(f.config, "xai/grok-4.7");
      expect(shouldReconcileOpencodeSessionModel(readOpencodeConfig(f.config), "xai/grok-4.7")).toBe(false);
      expect(armModelReconcile(f.config)).toBe(true);
      expect(readOpencodeConfig(f.config).opencodeConfiguredModelAtLastOpen).toBe("");
      expect(shouldReconcileOpencodeSessionModel(readOpencodeConfig(f.config), "xai/grok-4.7")).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("镜像：已经为空 ⇒ 返回 false，不重复写盘（心跳不该整天改 config.json）", () => {
    const f = fixture("arm-idempotent");
    try {
      writebackOpencodeConfiguredModel(f.config, "xai/grok-4.7");
      expect(armModelReconcile(f.config)).toBe(true);
      expect(armModelReconcile(f.config)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("镜像否定：marker 从未写过（旧节点）⇒ 不凭空造一个 marker", () => {
    const f = fixture("arm-legacy");
    try {
      expect(readOpencodeConfig(f.config).opencodeConfiguredModelAtLastOpen).toBeUndefined();
      expect(armModelReconcile(f.config)).toBe(false);
      expect(readOpencodeConfig(f.config).opencodeConfiguredModelAtLastOpen).toBeUndefined();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

// 接线判据（源码契约）：纯函数对了，但轮询里没调用，生产上照样不自愈。
// 用**守卫位置**而不是「文件里出现过」：调用必须挂在 `next !== MODEL` 这个条件里。
describe("#3418 接线：轮询发现漂移时才武装", () => {
  const src = readFileSync(join(import.meta.dir, "..", "..", "cli.ts"), "utf8");
  test("pollOpencodeSessionModel 里，armModelReconcile 挂在 next !== MODEL 的条件下", () => {
    const start = src.indexOf("async function pollOpencodeSessionModel()");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n}\n", start);
    const fn = src.slice(start, end);
    expect(fn).toMatch(/if \(MODEL && next !== MODEL && configFilePath\) \{[\s\S]*armModelReconcile\(configFilePath\)/);
  });
});
