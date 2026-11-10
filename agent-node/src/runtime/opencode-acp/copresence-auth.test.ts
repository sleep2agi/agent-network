import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildOpencodeChildEnv, cleanupOpencodeChildEnv, discardUnspawnedOpencodeChildEnv } from "./child-env";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "auth1120-node-"));
  const base = `/run/user/${process.getuid!()}`;
  mkdirSync(base, { recursive: true, mode: 0o700 });
  chmodSync(base, 0o700);
  const launchBase = mkdtempSync(join(base, ".auth1120-"));
  const path = join(dir, ".local/share/opencode/auth.json");
  const open = (options = {}) => buildOpencodeChildEnv({
    workDir: dir, cwd: dir, parentEnv: {}, launchBase, persistAuth: true, ...options,
  });
  return { dir, path, launchBase, open,
    close: () => { rmSync(dir, { recursive: true, force: true }); rmSync(launchBase, { recursive: true, force: true }); } };
}
const authPath = (env: NodeJS.ProcessEnv) => join(env.XDG_DATA_HOME!, "opencode/auth.json");
const save = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("TUI API/OAuth/wellknown login survives cleanup and a fresh launch; only auth is copied", () => {
  const f = fixture();
  try {
    const first = f.open();
    const loggedIn = {
      openai: { type: "oauth", refresh: "fixture-refresh", access: "fixture-access", expires: 123,
        accountId: "fixture-account", enterpriseUrl: "https://example.test", extra: "drop" },
      custom: { type: "api", key: "fixture-api", metadata: { organization: "fixture-org" } },
      discovered: { type: "wellknown", key: "fixture-key", token: "fixture-token" },
    };
    save(authPath(first), loggedIn);
    writeFileSync(join(first.XDG_DATA_HOME!, "opencode/opencode.db"), "fixture-history");
    const oldRoot = dirname(first.XDG_DATA_HOME!);
    expect(cleanupOpencodeChildEnv(f.dir, first)).toBe(true);
    expect(existsSync(oldRoot)).toBe(false);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(read(f.path).openai.extra).toBeUndefined();
    const second = f.open();
    expect(read(authPath(second))).toEqual(read(f.path));
    expect(read(authPath(second)).openai.accountId).toBe("fixture-account");
    expect(existsSync(join(second.XDG_DATA_HOME!, "opencode/opencode.db"))).toBe(false);
    expect(cleanupOpencodeChildEnv(f.dir, second)).toBe(true);
  } finally { f.close(); }
});

test("TUI logout persists an empty auth file without reintroducing the old login", () => {
  const f = fixture();
  try {
    let env = f.open(); save(authPath(env), { openai: { type: "api", key: "fixture-old" } });
    expect(cleanupOpencodeChildEnv(f.dir, env)).toBe(true);
    env = f.open(); save(authPath(env), {});
    expect(cleanupOpencodeChildEnv(f.dir, env)).toBe(true);
    env = f.open(); expect(read(authPath(env))).toEqual({});
    expect(cleanupOpencodeChildEnv(f.dir, env)).toBe(true);
  } finally { f.close(); }
});

test("probe/discard and headless ACP never save or expand OAuth login state", () => {
  const f = fixture();
  try {
    let env = f.open(); save(authPath(env), { openai: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 0 } });
    expect(cleanupOpencodeChildEnv(f.dir, env)).toBe(true);
    const original = readFileSync(f.path, "utf8");
    env = f.open({ credentialMode: "probe" });
    expect(existsSync(authPath(env))).toBe(false);
    save(authPath(env), { openai: { type: "api", key: "fixture-probe" } });
    expect(discardUnspawnedOpencodeChildEnv(f.dir, env)).toBe(true);
    expect(readFileSync(f.path, "utf8")).toBe(original);
    env = f.open({ persistAuth: false }); expect(read(authPath(env))).toEqual({});
    save(authPath(env), { openai: { type: "api", key: "fixture-acp" } });
    expect(cleanupOpencodeChildEnv(f.dir, env)).toBe(true);
    expect(readFileSync(f.path, "utf8")).toBe(original);
  } finally { f.close(); }
});

test("concurrent credential edits are retained and changed runtime root is not deleted", () => {
  const f = fixture();
  try {
    const env = f.open();
    save(authPath(env), { custom: { type: "api", key: "fixture-tui" } });
    save(f.path, { custom: { type: "api", key: "fixture-operator" } });
    expect(() => cleanupOpencodeChildEnv(f.dir, env)).toThrow("credentials changed since launch");
    expect(read(f.path).custom.key).toBe("fixture-operator");
    expect(existsSync(dirname(env.XDG_DATA_HOME!))).toBe(true);
  } finally { f.close(); }
});

test("runtime and persistent credential symlinks cannot read or overwrite another file", () => {
  for (const target of ["runtime", "persistent"]) {
    const f = fixture();
    try {
      const env = f.open(); const outside = join(f.dir, "outside-auth");
      save(outside, { openai: { type: "api", key: "fixture-outside" } });
      save(authPath(env), { openai: { type: "api", key: "fixture-runtime" } });
      const path = target === "runtime" ? authPath(env) : f.path;
      rmSync(path, { force: true }); symlinkSync(outside, path);
      expect(() => cleanupOpencodeChildEnv(f.dir, env)).toThrow("single-link regular file");
      expect(read(outside).openai.key).toBe("fixture-outside");
    } finally { f.close(); }
  }
});

test("invalid JSON never exposes credential contents or replaces the previous auth", () => {
  const f = fixture();
  try {
    const env = f.open(); const sentinel = "fixture-secret-not-for-errors";
    writeFileSync(authPath(env), `{${sentinel}`, { mode: 0o600 });
    let message = ""; try { cleanupOpencodeChildEnv(f.dir, env); } catch (e: any) { message = e.message; }
    expect(message).toBe("opencode refuses co-presence auth: invalid JSON");
    expect(message).not.toContain(sentinel); expect(existsSync(f.path)).toBe(false);
  } finally { f.close(); }
});

test("unspawned runtime discard does not commit a login, and unsafe tools uses the same private auth boundary", () => {
  const f = fixture();
  try {
    let env = f.open(); save(authPath(env), { custom: { type: "api", key: "fixture-rejected" } });
    expect(discardUnspawnedOpencodeChildEnv(f.dir, env)).toBe(true); expect(existsSync(f.path)).toBe(false);
    env = f.open({ unsafeTools: true }); save(authPath(env), { custom: { type: "api", key: "fixture-unsafe" } });
    expect(cleanupOpencodeChildEnv(f.dir, env)).toBe(true);
    env = f.open({ unsafeTools: true }); expect(read(authPath(env)).custom.key).toBe("fixture-unsafe");
    expect(env.XDG_DATA_HOME).not.toBe(join(f.dir, ".local/share"));
    expect(cleanupOpencodeChildEnv(f.dir, env)).toBe(true);
  } finally { f.close(); }
});
