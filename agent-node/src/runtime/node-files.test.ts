// 项目文件夹只读查看 —— 路径规范化、凭据判定(纯函数)、realpath 收口、软链接不外逃、
// node_modules / .git 不进入、文本 / 二进制 / 超大、门铃 ack。
// 跑法:cd agent-node && bun test src/runtime/node-files.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NODE_FILES_LIST_MAX,
  NODE_FILE_READ_MAX_BYTES,
  listNodeFiles,
  noDescendReasonFor,
  normalizeNodeRelPath,
  readNodeFile,
  secretReasonFor,
} from "./node-files";
import { processRulesFileRequests } from "./rules-file";

const cleanup: string[] = [];
afterAll(async () => {
  for (const d of cleanup) {
    await fs.chmod(path.join(d, "work", ".env"), 0o600).catch(() => {});
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function tmp(prefix: string): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  cleanup.push(d);
  return d;
}

/**
 * base/
 *   outside/secret.txt, outside/dir/x.txt    ← 工作目录之外
 *   work/                                     ← 工作目录
 *     README.md, src/lib/util.ts, .env (0000), .env.local, config/app.key,
 *     .anet/nodes/demo-node/config.json, .anet/nodes/demo-node/run.log,
 *     .git/HEAD, node_modules/pkg/index.js, big.log (> 256 KiB), logo.bin (NUL),
 *     latin1.txt (invalid UTF-8),
 *     link-out -> ../outside/secret.txt, link-out-dir -> ../outside/dir,
 *     link-in -> src, notes.txt -> .env.local
 */
async function tree(): Promise<{ base: string; work: string }> {
  const base = await tmp("node-files-");
  const work = path.join(base, "work");
  const w = async (rel: string, body: string | Buffer) => {
    await fs.mkdir(path.dirname(path.join(base, rel)), { recursive: true });
    await fs.writeFile(path.join(base, rel), body);
  };
  await w("outside/secret.txt", "OUTSIDE-SECRET");
  await w("outside/dir/x.txt", "outside dir file");
  await w("work/README.md", "# demo\n");
  await w("work/src/lib/util.ts", "export const x = 1;\n");
  await w("work/.env", "API_KEY=sk-should-never-leave\n");
  await w("work/.env.local", "LOCAL_TOKEN=also-secret\n");
  await w("work/config/app.key", "-----BEGIN PRIVATE KEY-----\n");
  await w("work/.anet/nodes/demo-node/config.json", '{"token":"ntok_secret"}');
  await w("work/.anet/nodes/demo-node/run.log", "hello log\n");
  await w("work/.git/HEAD", "ref: refs/heads/main\n");
  await w("work/node_modules/pkg/index.js", "module.exports = 1;\n");
  await w("work/big.log", "x".repeat(NODE_FILE_READ_MAX_BYTES + 1));
  await w("work/logo.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  await w("work/latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  // Valid UTF-8 (a decoder accepts it) but has NUL bytes → still binary.
  await w("work/ascii-nul.dat", Buffer.from("abc\u0000def\n", "utf8"));
  await fs.symlink(path.join(base, "outside/secret.txt"), path.join(work, "link-out"));
  await fs.symlink(path.join(base, "outside/dir"), path.join(work, "link-out-dir"));
  await fs.symlink("src", path.join(work, "link-in"));
  await fs.symlink(".env.local", path.join(work, "notes.txt"));
  // A link NAMED like a session store but pointing at an ordinary dir, and an
  // innocent name pointing INTO .git: each is refused by one of the two checks.
  await fs.symlink("src", path.join(work, ".codex"));
  await fs.symlink(".git", path.join(work, "gitlink"));
  // 读 .env 的内容会直接 EACCES —— 凭据判定必须在打开文件之前。
  await fs.chmod(path.join(work, ".env"), 0o000);
  return { base, work };
}

describe("normalizeNodeRelPath", () => {
  test("accepts relative paths and normalizes . and empty segments", () => {
    expect(normalizeNodeRelPath(undefined)).toBe("");
    expect(normalizeNodeRelPath("")).toBe("");
    expect(normalizeNodeRelPath("./")).toBe("");
    expect(normalizeNodeRelPath("./src//lib/")).toBe("src/lib");
    expect(normalizeNodeRelPath("a.b/..c/d..")).toBe("a.b/..c/d..");
  });
  test("refuses absolute, ~, drive letters, .., backslash, NUL, non-strings, over-long", () => {
    for (const bad of ["/etc/passwd", "/", "~/x", "~", "C:/x", "c:x", "..", "../x", "a/../b", "a/..", "a\\b", "a\u0000b", "x".repeat(1025)]) {
      expect(() => normalizeNodeRelPath(bad)).toThrow(/invalid path/);
    }
    expect(() => normalizeNodeRelPath(42)).toThrow(/invalid path/);
  });
});

describe("secretReasonFor (pure deny rules)", () => {
  const secret = [
    ".env", ".env.local", "app/.env.production", ".ENV", ".envrc",
    "certs/server.pem", "tls/app.key", "SERVER.PEM", "keys/id_rsa", "id_ed25519.pub",
    "auth.json", "codex/auth.json", "credentials", "aws/credentials.json", "store.p12", "cert.pfx",
    ".npmrc", "user.npmrc", ".netrc", ".git-credentials",
    ".anet/config.json", ".anet/nodes/demo-node/config.json", ".anet/config.json.bak-20260101",
    ".git", ".git/config", "sub/.git/HEAD",
    "codex-home", "nodes/x/codex-home/sessions/r.jsonl", ".codex/auth", ".grok/session.json", ".claude/settings.local.json",
    ".ssh/known_hosts", ".gnupg/pubring.kbx", ".aws/config",
  ];
  const fine = [
    "README.md", "src/environment.ts", "src/env.ts", "keys.ts", "monkey.ts", "identity.md", "src/id.ts",
    "config.json", "configs/config.json", "app/config.json", ".anet/nodes/demo-node/run.log",
    "docs/credential-rotation.md", "node_modules/pkg/index.js", ".github/workflows/ci.yml", "package.json",
  ];
  for (const p of secret) test(`secret: ${p}`, () => expect(secretReasonFor(p)).toBe("secret"));
  for (const p of fine) test(`not secret: ${p}`, () => expect(secretReasonFor(p)).toBeNull());

  test("the work dir's own ancestors count as directories, never as a file name", () => {
    expect(secretReasonFor("notes.md", "/home/demo/.claude/projects/p")).toBe("secret");
    expect(secretReasonFor("", "/home/demo/.codex")).toBe("secret");
    expect(secretReasonFor("config.json", "/srv/demo/.anet/nodes/demo-node")).toBe("secret");
    expect(secretReasonFor("run.log", "/srv/demo/.anet/nodes/demo-node")).toBeNull();
    // A work dir that happens to be named like a secret file is still browsable.
    expect(secretReasonFor("", "/srv/credentials-service")).toBeNull();
    expect(secretReasonFor("README.md", "/srv/credentials-service")).toBeNull();
  });

  test("noDescendReasonFor: secret dirs → secret, node_modules → skipped", () => {
    expect(noDescendReasonFor(".git")).toBe("secret");
    expect(noDescendReasonFor("a/node_modules")).toBe("skipped");
    expect(noDescendReasonFor("a/node_modules/b")).toBe("skipped");
    expect(noDescendReasonFor("src")).toBeNull();
    expect(noDescendReasonFor("")).toBeNull();
  });
});

describe("listNodeFiles", () => {
  test("root: dirs first, secret names listed without size, skipped dirs flagged, symlinks typed", async () => {
    const { work } = await tree();
    const r = await listNodeFiles(work, "");
    expect(r.path).toBe("");
    expect(r.truncated).toBe(false);
    const by = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    // dirs first
    const firstFile = r.entries.findIndex((e) => e.type !== "dir");
    expect(r.entries.slice(0, firstFile).every((e) => e.type === "dir")).toBe(true);
    expect(r.entries.slice(firstFile).some((e) => e.type === "dir")).toBe(false);
    expect(by["README.md"]).toMatchObject({ type: "file", size: 7 });
    expect(typeof by["README.md"]!.mtime).toBe("number");
    expect(by["src"]).toMatchObject({ type: "dir" });
    expect(by["src"]!.no_descend).toBeUndefined();
    expect(by[".env"]).toMatchObject({ type: "file", hidden_reason: "secret" });
    expect(by[".env"]!.size).toBeUndefined();
    expect(by[".env.local"]!.size).toBeUndefined();
    expect(by[".git"]).toMatchObject({ type: "dir", hidden_reason: "secret", no_descend: true });
    expect(by["node_modules"]).toMatchObject({ type: "dir", hidden_reason: "skipped", no_descend: true });
    expect(by["link-out"]).toMatchObject({ type: "symlink", link_type: null });
    expect(by["link-out-dir"]).toMatchObject({ type: "symlink", link_type: null });
    expect(by["link-in"]).toMatchObject({ type: "symlink", link_type: "dir" });
    expect(by["notes.txt"]).toMatchObject({ type: "symlink", link_type: "file", hidden_reason: "secret" });
    // Nothing in the payload names a path outside the work dir.
    expect(JSON.stringify(r)).not.toContain("outside");
  });

  test("nested dir and a symlink that stays inside", async () => {
    const { work } = await tree();
    expect((await listNodeFiles(work, "src")).entries.map((e) => e.name)).toEqual(["lib"]);
    expect((await listNodeFiles(work, "src/lib")).entries.map((e) => e.name)).toEqual(["util.ts"]);
    expect((await listNodeFiles(work, "link-in")).entries.map((e) => e.name)).toEqual(["lib"]);
    const anet = await listNodeFiles(work, ".anet/nodes/demo-node");
    expect(Object.fromEntries(anet.entries.map((e) => [e.name, e.hidden_reason ?? null]))).toEqual({ "config.json": "secret", "run.log": null });
  });

  test("refuses ../, absolute, symlink-to-outside dir, .git and node_modules", async () => {
    const { work } = await tree();
    await expect(listNodeFiles(work, "../")).rejects.toThrow(/invalid path/);
    await expect(listNodeFiles(work, "src/../../outside")).rejects.toThrow(/invalid path/);
    await expect(listNodeFiles(work, "/etc")).rejects.toThrow(/invalid path/);
    await expect(listNodeFiles(work, "link-out-dir")).rejects.toThrow(/outside the work dir/);
    await expect(listNodeFiles(work, ".git")).rejects.toThrow(/not browsable \(secret\)/);
    await expect(listNodeFiles(work, "node_modules")).rejects.toThrow(/not browsable \(skipped\)/);
    await expect(listNodeFiles(work, "node_modules/pkg")).rejects.toThrow(/not browsable/);
    await expect(listNodeFiles(work, "README.md")).rejects.toThrow(/not a directory/);
    await expect(listNodeFiles(work, "nope")).rejects.toThrow(/not found/);
    // requested name is a session store (target is fine) → refused by name
    await expect(listNodeFiles(work, ".codex")).rejects.toThrow(/not browsable \(secret\)/);
    // innocent name, target is .git → refused after realpath
    await expect(listNodeFiles(work, "gitlink")).rejects.toThrow(/not browsable \(secret\)/);
  });

  test("caps at NODE_FILES_LIST_MAX with truncated + total", async () => {
    const work = await tmp("node-files-many-");
    await fs.mkdir(path.join(work, "zz-dir"));
    for (let i = 0; i < NODE_FILES_LIST_MAX + 5; i++) await fs.writeFile(path.join(work, `f${String(i).padStart(5, "0")}.txt`), "");
    const r = await listNodeFiles(work, "");
    expect(r.entries.length).toBe(NODE_FILES_LIST_MAX);
    expect(r.total).toBe(NODE_FILES_LIST_MAX + 6);
    expect(r.truncated).toBe(true);
    // Dirs sort first even when they would sort last by name.
    expect(r.entries[0]!.name).toBe("zz-dir");
  });
});

describe("readNodeFile", () => {
  test("text files come back whole", async () => {
    const { work } = await tree();
    expect(await readNodeFile(work, "README.md")).toMatchObject({ path: "README.md", name: "README.md", kind: "text", size: 7, content: "# demo\n" });
    expect(await readNodeFile(work, "link-in/lib/util.ts")).toMatchObject({ kind: "text", content: "export const x = 1;\n" });
    expect(await readNodeFile(work, ".anet/nodes/demo-node/run.log")).toMatchObject({ kind: "text" });
  });

  test(".env is refused without being opened (it is mode 000 here), and without a size", async () => {
    const { work } = await tree();
    const r = await readNodeFile(work, ".env");
    expect(r).toEqual({ path: ".env", name: ".env", kind: "secret", hidden_reason: "secret" });
    expect(await readNodeFile(work, "config/app.key")).toMatchObject({ kind: "secret" });
    expect(await readNodeFile(work, ".anet/nodes/demo-node/config.json")).toMatchObject({ kind: "secret" });
    expect(await readNodeFile(work, ".git/HEAD")).toMatchObject({ kind: "secret" });
    // Existence is not revealed either.
    expect(await readNodeFile(work, ".env.missing")).toMatchObject({ kind: "secret" });
  });

  test("a harmless-looking symlink to a secret file is still a secret", async () => {
    const { work } = await tree();
    const r = await readNodeFile(work, "notes.txt");
    expect(r.kind).toBe("secret");
    expect(r.content).toBeUndefined();
  });

  test("symlink to a file outside the work dir is refused", async () => {
    const { work } = await tree();
    await expect(readNodeFile(work, "link-out")).rejects.toThrow(/outside the work dir/);
    await expect(readNodeFile(work, "link-out-dir/x.txt")).rejects.toThrow(/outside the work dir/);
  });

  test("../ and absolute paths are refused before touching the disk", async () => {
    const { work } = await tree();
    await expect(readNodeFile(work, "../outside/secret.txt")).rejects.toThrow(/invalid path/);
    await expect(readNodeFile(work, "/etc/hostname")).rejects.toThrow(/invalid path/);
    await expect(readNodeFile(work, "")).rejects.toThrow(/invalid path/);
  });

  test("over 256 KiB → too_large with size; NUL or invalid UTF-8 → binary with size; no content", async () => {
    const { work } = await tree();
    expect(await readNodeFile(work, "big.log")).toMatchObject({ kind: "too_large", size: NODE_FILE_READ_MAX_BYTES + 1 });
    expect((await readNodeFile(work, "big.log")).content).toBeUndefined();
    expect(await readNodeFile(work, "logo.bin")).toMatchObject({ kind: "binary", size: 7 });
    expect((await readNodeFile(work, "logo.bin")).content).toBeUndefined();
    expect(await readNodeFile(work, "latin1.txt")).toMatchObject({ kind: "binary", size: 5 });
    expect(await readNodeFile(work, "ascii-nul.dat")).toMatchObject({ kind: "binary", size: 8 });
  });

  test("node_modules files and directories are refused", async () => {
    const { work } = await tree();
    await expect(readNodeFile(work, "node_modules/pkg/index.js")).rejects.toThrow(/not browsable/);
    await expect(readNodeFile(work, "src")).rejects.toThrow(/not a regular file/);
  });
});

describe("doorbell: files_list / file_read ack JSON; failures ack failed", () => {
  test("round trip through processRulesFileRequests", async () => {
    const { work } = await tree();
    const queue: any[] = [
      { request_id: "rf_l", op: "files_list", content: "src" },
      { request_id: "rf_r", op: "file_read", content: "README.md" },
      { request_id: "rf_e", op: "file_read", content: ".env" },
      { request_id: "rf_x", op: "file_read", content: "../outside/secret.txt" },
      { request_id: "rf_root", op: "files_list" },
    ];
    const acks: any[] = [];
    const callCommHub = async (method: string, params: Record<string, unknown>) => {
      if (method === "get_rules_file_request") return { ok: true, request: queue.shift() ?? null };
      if (method === "ack_rules_file_request") { acks.push(params); return { ok: true }; }
      throw new Error(`unexpected ${method}`);
    };
    const n = await processRulesFileRequests({ callCommHub, runtime: "codex", workDir: work, log: () => {}, warn: () => {} });
    expect(n).toBe(5);
    expect(acks[0]).toMatchObject({ request_id: "rf_l", status: "done", file_name: "files" });
    expect(JSON.parse(acks[0].content).entries.map((e: any) => e.name)).toEqual(["lib"]);
    expect(JSON.parse(acks[1].content)).toMatchObject({ kind: "text", content: "# demo\n" });
    expect(JSON.parse(acks[2].content)).toEqual({ path: ".env", name: ".env", kind: "secret", hidden_reason: "secret" });
    expect(acks[3]).toMatchObject({ request_id: "rf_x", status: "failed", file_name: "files" });
    expect(String(acks[3].error)).toMatch(/invalid path/);
    expect(JSON.parse(acks[4].content).path).toBe("");
    for (const a of acks) expect(JSON.stringify(a)).not.toContain("sk-should-never-leave");
    for (const a of acks) expect(JSON.stringify(a)).not.toContain(work);
  });
});
