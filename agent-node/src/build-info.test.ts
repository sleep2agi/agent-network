// #3294 —— agent-node 的构建标识读取：三态 + 「只给值，成因交给 Hub」。
//
// 与 server / agent-network 两份同一套判据，但独立实现（三个包分别发布，不能跨包 import）。
// 这里钉的是：present / absent / invalid 分开；坏掉的**不冒充没有**（虽然两者对外都返回 undefined，
// 成因由 Hub 的 build_note 承担 —— 这一点必须写下来，否则「读不到」会被读成「本来就没有」）。
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BUILD_INFO_FILE, readBuildInfo, validateBuildInfo } from "./build-info";

const SHA = "c".repeat(40);
const GOOD = { schema: 1, commit: SHA, dirty: false, built_at: "2026-10-31T20:00:00Z" };

function inTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "an-build-info-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("#3294 agent-node build-info", () => {
  test("absent：没有文件（源码检出 / 老制品）—— 正常状态", () => {
    inTemp((dir) => expect(readBuildInfo(dir)).toEqual({ kind: "absent" }));
  });

  test("present：原样读出", () => {
    inTemp((dir) => {
      writeFileSync(join(dir, BUILD_INFO_FILE), JSON.stringify(GOOD));
      expect(readBuildInfo(dir)).toEqual({ kind: "present", info: GOOD });
    });
  });

  test("invalid 与 absent 分开（写坏了 ≠ 没有）", () => {
    inTemp((dir) => {
      writeFileSync(join(dir, BUILD_INFO_FILE), "not json");
      expect(readBuildInfo(dir)).toEqual({ kind: "invalid", error: "invalid_json" });
      writeFileSync(join(dir, BUILD_INFO_FILE), JSON.stringify({ ...GOOD, dirty: "no" }));
      expect(readBuildInfo(dir)).toEqual({ kind: "invalid", error: "invalid_shape" });
    });
  });

  test("严格校验：每种坏形状都拒绝", () => {
    expect(validateBuildInfo(null)).toBeNull();
    expect(validateBuildInfo({ ...GOOD, schema: 0 })).toBeNull();
    expect(validateBuildInfo({ ...GOOD, commit: SHA.toUpperCase() })).toBeNull();
    expect(validateBuildInfo({ ...GOOD, built_at: "2026-10-31" })).toBeNull();
  });
});


// #3294 —— 写侧：**commit 描述的是被打包的那棵树**，不是触发事件的 sha。
//
// 实测抓到的错误（2026-10-31 agent-network .205）：
//   release workflow 的 checkout 是 `ref: inputs.commit || github.sha`，
//   而 GITHUB_SHA 永远是事件的 sha ⇒ 指定 commit 发布时两者不同。
//   日志里 `HEAD is now at 9bb1a3995`，制品里却写着 644c95cd。
//   **标识说错了自己描述的对象** —— 这比没有标识更糟，因为它看起来可引用。
const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const WRITER = join(REPO_ROOT, "agent-node", "scripts", "write-build-info.mjs");

function runWriter(dir: string, env: Record<string, string> = {}): { written: any | null; stderr: string } {
  const out = join(dir, "out.json");
  const child = Bun.spawnSync(["node", join(dir, "scripts", "write-build-info.mjs"), "--out", out], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: dir, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const stderr = new TextDecoder().decode(child.stderr);
  try { return { written: JSON.parse(readFileSync(out, "utf8")), stderr }; }
  catch { return { written: null, stderr }; }
}

function makeTree(headEnvSha?: string): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "an-writer-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(WRITER, join(dir, "scripts", "write-build-info.mjs"));
  writeFileSync(join(dir, "package.json"), '{"name":"fixture","version":"0.0.0"}\n');
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture");
  return { dir, head: git("rev-parse", "HEAD") };
}

describe("#3294 build-info 写侧：commit 描述树，event_sha 描述事件", () => {
  test("有 git 时用 HEAD（不是 GITHUB_SHA）", () => {
    const { dir, head } = makeTree();
    try {
      const { written } = runWriter(dir, { GITHUB_SHA: head });
      expect(written.commit).toBe(head);
      expect(written.event_sha).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("🔴 GITHUB_SHA ≠ HEAD ⇒ commit=HEAD，另记 event_sha（并说清为什么）", () => {
    const { dir, head } = makeTree();
    const eventSha = "f".repeat(40);
    try {
      const { written, stderr } = runWriter(dir, { GITHUB_SHA: eventSha });
      expect(written.commit).toBe(head);          // 制品描述的是这棵树
      expect(written.event_sha).toBe(eventSha);   // 事件另存，不冒充
      expect(stderr).toContain("event sha");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("没有 .git（安装树）⇒ 退回 GITHUB_SHA", () => {
    const dir = mkdtempSync(join(tmpdir(), "an-writer-nogit-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(WRITER, join(dir, "scripts", "write-build-info.mjs"));
    const sha = "a".repeat(40);
    try {
      const { written } = runWriter(dir, { GITHUB_SHA: sha });
      expect(written.commit).toBe(sha);
      expect(written.source).toBe("ci");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("两者都没有 ⇒ 不写文件（absent 是诚实的，假 commit 不是）", () => {
    const dir = mkdtempSync(join(tmpdir(), "an-writer-none-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(WRITER, join(dir, "scripts", "write-build-info.mjs"));
    try {
      const { written } = runWriter(dir);
      expect(written).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
